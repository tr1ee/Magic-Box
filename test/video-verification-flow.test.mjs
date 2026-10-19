import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { scanVideoPage, startServer } from "../server/index.mjs";

let mediaServer, mediaBase, temporary, app;
const previousSettings = process.env.MAGIC_BOX_SETTINGS_FILE;
let verifyCalls = 0;
const pageUrl = "https://missav.example/fixture";
const challenge = () => Object.assign(new Error("HTTP 403"), { statusCode: 403, code: "HTTP_403", accessBlocked: true });
const verifiedHtml = () => `<title>Verification fixture</title><video src="${mediaBase}/movie-720p.mp4"></video>`;

before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-verify-flow-"));
  process.env.MAGIC_BOX_SETTINGS_FILE = path.join(temporary, "settings.json");
  mediaServer = http.createServer((request, response) => {
    if (request.url === "/challenge") {
      response.writeHead(503, { "cf-mitigated": "challenge", "Content-Type": "text/html" }).end("Verification required");
    } else {
      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": 15 }).end("synthetic-video");
    }
  });
  await new Promise(resolve => mediaServer.listen(0, "127.0.0.1", resolve));
  mediaBase = `http://127.0.0.1:${mediaServer.address().port}`;
  app = await startServer({
    port: 0, dht: false, lsd: false, tracker: false,
    defaultDownloadDir: path.join(temporary, "downloads"),
    assistantDataDir: path.join(temporary, "assistant"),
    videoScanAdapters: {
      site: async () => { throw challenge(); },
      verifyPage: async (url, options) => {
        verifyCalls += 1;
        assert.equal(url, pageUrl);
        assert.equal(options.timeoutMs, 150000);
        assert.ok(options.signal);
        return { html: verifiedHtml(), finalUrl: pageUrl, userAgent: "Verification-fixture-browser" };
      }
    }
  });
});

after(async () => {
  await app?.close();
  if (mediaServer) await new Promise(resolve => mediaServer.close(resolve));
  if (previousSettings === undefined) delete process.env.MAGIC_BOX_SETTINGS_FILE;
  else process.env.MAGIC_BOX_SETTINGS_FILE = previousSettings;
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

test("blocked supported-site scan surfaces the challenge without launching a browser", async () => {
  await assert.rejects(scanVideoPage(pageUrl, {}, {
    site: async () => { throw challenge(); },
    verifyPage: async () => assert.fail("browser requires an explicit action"),
    extractor: async () => assert.fail("challenge must not be hidden by another extractor")
  }), { accessBlocked: true });
});

test("verification retry feeds the captured page into the existing site parser", async () => {
  const result = await scanVideoPage(pageUrl, { verifyInBrowser: true }, {
    site: async () => assert.fail("must not refetch the blocked page"),
    verifyPage: async () => ({ html: verifiedHtml(), finalUrl: pageUrl, userAgent: "Fixture-browser" })
  });
  assert.equal(result.usedBrowserVerification, true);
  assert.equal(result.count, 1);
  assert.equal(result.videos[0].url, `${mediaBase}/movie-720p.mp4`);
  assert.equal(result.videos[0].httpHeaders["User-Agent"], "Fixture-browser");
  assert.equal(result.videos[0].httpHeaders.Cookie, undefined);
});

test("verification rejects a remaining challenge and a cross-site result", async () => {
  await assert.rejects(scanVideoPage(pageUrl, { verifyInBrowser: true }, {
    verifyPage: async () => ({ html: '<title>Just a moment...</title><form id="challenge-form"></form>', finalUrl: pageUrl })
  }), { accessBlocked: true });
  await assert.rejects(scanVideoPage(pageUrl, { verifyInBrowser: true }, {
    verifyPage: async () => ({ html: verifiedHtml(), finalUrl: "https://unrelated.example/page" })
  }), { code: "VIDEO_VERIFICATION_REDIRECT" });
});

test("verified empty page reports a parsing failure instead of a successful zero result", async () => {
  await assert.rejects(scanVideoPage(pageUrl, { verifyInBrowser: true }, {
    verifyPage: async () => ({ html: "<html><title>Normal page</title><body>Loaded</body></html>", finalUrl: pageUrl })
  }), { code: "VIDEO_VERIFIED_NO_MEDIA" });
});

test("a regular page mentioning captcha settings is not mistaken for a challenge", async () => {
  const result = await scanVideoPage(pageUrl, { verifyInBrowser: true }, {
    verifyPage: async () => ({ html: `${verifiedHtml()}<script>const settings = {captcha: false};</script>`, finalUrl: pageUrl })
  });
  assert.equal(result.count, 1);
});

test("HTTP challenge headers stop the generic path before automatic rendering", async () => {
  await assert.rejects(scanVideoPage(`${mediaBase}/challenge`, {}, {
    site: async () => [], extractor: async () => []
  }), { statusCode: 503, browserChallenge: true });
});

test("scan API offers verification and opens it only for an explicit boolean retry", async () => {
  const post = body => fetch(`${app.url}/api/videos/scan`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  for (const value of [undefined, "true"]) {
    const response = await post({ pageUrl, verifyInBrowser: value });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, "VIDEO_VERIFICATION_REQUIRED");
    assert.equal(body.canVerifyInBrowser, true);
    assert.equal(verifyCalls, 0);
  }
  const response = await post({ pageUrl, verifyInBrowser: true });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.usedBrowserVerification, true);
  assert.equal(body.count, 1);
  assert.equal(verifyCalls, 1);
  assert.doesNotMatch(JSON.stringify(body), /video-verification|settings\.json|Cookie/);
});
