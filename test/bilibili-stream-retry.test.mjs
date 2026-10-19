import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { downloadVideoResourceToPath } from "../server/index.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function destination() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-bilibili-stream-retry-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return path.join(directory, "stream.m4s");
}

async function fixtureServer(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    handler(request, response, requests);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

function interrupt(response) {
  response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": 1000 });
  response.write("incomplete-source-bytes");
  const timer = setTimeout(() => response.destroy(), 40);
  response.once("close", () => clearTimeout(timer));
}

test("an interrupted BiliBili stream restarts from its mirror without mixing partial bytes", async () => {
  const complete = Buffer.from("complete-mirror-content-with-a-different-prefix");
  const server = await fixtureServer((request, response) => {
    if (request.url === "/primary") return interrupt(response);
    assert.equal(request.headers.referer, "https://www.bilibili.com/video/BVfixture/");
    assert.equal(request.headers["user-agent"], "Fixture-browser");
    response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": complete.length });
    response.end(complete);
  });
  const filename = await destination();
  const result = await downloadVideoResourceToPath({
    url: `${server.url}/primary`, fallbackUrls: [`${server.url}/mirror`],
    referer: "https://www.bilibili.com/video/BVfixture/", httpHeaders: { "User-Agent": "Fixture-browser" }
  }, filename);
  assert.deepEqual(server.requests, ["/primary", "/mirror"]);
  assert.deepEqual(await fs.readFile(filename), complete);
  assert.equal(result.bytes, complete.length);
  assert.equal(result.bytesTotal, complete.length);
  assert.equal(result.finalUrl, `${server.url}/mirror`);
});

test("BiliBili retries an interrupted original when no mirror is available", async () => {
  const complete = Buffer.from("complete-original-on-retry");
  const server = await fixtureServer((_request, response, requests) => {
    if (requests.length === 1) return interrupt(response);
    response.writeHead(200, { "Content-Length": complete.length });
    response.end(complete);
  });
  const filename = await destination();
  const result = await downloadVideoResourceToPath({ url: `${server.url}/source` }, filename);
  assert.equal(server.requests.length, 2);
  assert.deepEqual(await fs.readFile(filename), complete);
  assert.equal(result.bytes, complete.length);
});

test("BiliBili closes an ongoing rejected CDN response instead of draining it while the mirror finishes", async () => {
  let resolvePrimaryClosed;
  const primaryClosed = new Promise(resolve => { resolvePrimaryClosed = resolve; });
  const complete = Buffer.from("complete-mirror-after-rejected-source");
  const server = await fixtureServer((request, response) => {
    if (request.url === "/primary") {
      response.once("close", () => resolvePrimaryClosed(true));
      response.writeHead(503, { "Content-Type": "text/plain" });
      response.write("unbounded rejected response body");
      // Keep the body open. The client must close this connection itself;
      // fixture cleanup happens only after the assertion below.
      return;
    }
    response.writeHead(200, { "Content-Length": complete.length });
    response.end(complete);
  });
  const filename = await destination();
  await downloadVideoResourceToPath({
    url: `${server.url}/primary`, fallbackUrls: [`${server.url}/mirror`]
  }, filename);
  assert.deepEqual(server.requests, ["/primary", "/mirror"]);
  assert.deepEqual(await fs.readFile(filename), complete);
  let timeout;
  try {
    const closed = await Promise.race([
      primaryClosed,
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), 1000); })
    ]);
    assert.equal(closed, true, "the rejected primary body must not keep downloading after fallback succeeds");
  } finally { clearTimeout(timeout); }
});

test("all interrupted BiliBili sources stop after three full attempts and remove their partial file", async () => {
  const server = await fixtureServer((_request, response) => interrupt(response));
  const filename = await destination();
  await assert.rejects(downloadVideoResourceToPath({
    url: `${server.url}/first`, fallbackUrls: [`${server.url}/second`, `${server.url}/third`, `${server.url}/fourth`]
  }, filename), error => ["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"].includes(error.code));
  assert.deepEqual(server.requests, ["/first", "/second", "/third"]);
  await assert.rejects(fs.stat(filename), { code: "ENOENT" });
});

test("cancelling a BiliBili transfer destroys the stalled stream immediately and never retries", async () => {
  const server = await fixtureServer((_request, response) => {
    response.writeHead(200, { "Content-Length": 1000 });
    response.write("first bytes");
  });
  const filename = await destination();
  const controller = new AbortController();
  const start = Date.now();
  await assert.rejects(downloadVideoResourceToPath({
    url: `${server.url}/stalled`, fallbackUrls: [`${server.url}/mirror`]
  }, filename, { signal: controller.signal, onProgress: () => controller.abort() }), { code: "ECANCELLED" });
  assert.ok(Date.now() - start < 5000, "cancellation must not wait for the socket timeout");
  assert.deepEqual(server.requests, ["/stalled"]);
  await assert.rejects(fs.stat(filename), { code: "ENOENT" });
});

test("no-network: an existing destination is preserved and is never treated as a partial download", async () => {
  const filename = await destination();
  await fs.writeFile(filename, "preexisting user file");
  await assert.rejects(downloadVideoResourceToPath({
    url: "http://127.0.0.1:1/never-request", fallbackUrls: ["http://127.0.0.1:1/never-request-mirror"]
  }, filename), { code: "EEXIST" });
  assert.equal(await fs.readFile(filename, "utf8"), "preexisting user file");
});

test("no-network: an already cancelled transfer never creates its destination", async () => {
  const filename = await destination();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(downloadVideoResourceToPath({ url: "http://127.0.0.1:1/never-request" }, filename, { signal: controller.signal }), { code: "ECANCELLED" });
  await assert.rejects(fs.stat(filename), { code: "ENOENT" });
});

test("BiliBili retries recoverable HTTP failures but keeps forbidden-source retries on a different mirror", async () => {
  for (const status of [408, 429, 503, 403]) {
    const server = await fixtureServer((_request, response, requests) => {
      if (requests.length === 1) response.writeHead(status).end("temporary failure");
      else response.writeHead(200, { "Content-Length": 4 }).end("done");
    });
    const filename = await destination();
    await downloadVideoResourceToPath({ url: `${server.url}/primary`, fallbackUrls: [`${server.url}/mirror`] }, filename);
    assert.deepEqual(server.requests, ["/primary", "/mirror"]);
    assert.equal(await fs.readFile(filename, "utf8"), "done");
  }
  const forbidden = await fixtureServer((_request, response) => response.writeHead(403).end("forbidden"));
  await assert.rejects(downloadVideoResourceToPath({ url: `${forbidden.url}/source` }, await destination()), { code: "HTTP_403" });
  assert.equal(forbidden.requests.length, 1);
});

test("BiliBili does not retry permanent HTTP errors or oversized resources", async () => {
  for (const [status, headers, code] of [
    [404, {}, "HTTP_404"],
    [200, { "Content-Length": 5 * 1024 * 1024 * 1024 }, "VIDEO_TOO_LARGE"]
  ]) {
    const server = await fixtureServer((_request, response) => response.writeHead(status, headers).end());
    const filename = await destination();
    await assert.rejects(downloadVideoResourceToPath({
      url: `${server.url}/primary`, fallbackUrls: [`${server.url}/mirror`]
    }, filename), { code });
    assert.deepEqual(server.requests, ["/primary"]);
    await assert.rejects(fs.stat(filename), { code: "ENOENT" });
  }
});
