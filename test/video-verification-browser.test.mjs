import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import { acquireVerificationProfile, captureVerifiedVideoPage, hasVerificationProfile, verifiedPageState } from "../server/video-verification-browser.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function temporaryRoot() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-verification-test-"));
  cleanups.push(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 8, retryDelay: 150 }));
  return directory;
}
const origin = "https://video.example.com";
const page = (changes = {}) => ({ url: `${origin}/watch/123`, status: 200, readyState: "complete", title: "Sample video", html: "<html><body><script>var player = {source: 'fixture'};</script></body></html>", ...changes });

describe("manual browser verification document checks", () => {
  it("accepts ordinary complete HTML with inline player data without relying on a specific site", () => {
    assert.equal(verifiedPageState(page(), `${origin}/watch/123`), "ready");
    assert.equal(verifiedPageState(page({ html: "<html><script src='/cdn-cgi/challenge-platform/h/g/jsd/main.js'></script><body>Video</body></html>" }), origin), "ready");
  });

  it("waits for an actual HTTP 200 document and rejects blank, failed, or unfinished documents", () => {
    for (const changes of [{ url: "about:blank" }, { status: 403 }, { status: undefined }, { readyState: "interactive" }, { html: "" }]) {
      assert.equal(verifiedPageState(page(changes), origin), "loading");
    }
  });

  it("never accepts a challenge, including a challenge shell served as HTTP 200", () => {
    for (const changes of [
      { headers: { "Cf-Mitigated": "challenge" } },
      { title: "Just a moment..." },
      { html: "<html><script>window._cf_chl_opt = {cType: 'managed'};</script></html>" },
      { html: "<form id='challenge-form'>Check</form>" }
    ]) assert.equal(verifiedPageState(page(changes), origin), "challenge");
  });

  it("enforces the exact origin, including protocol and port", () => {
    for (const url of ["http://video.example.com/a", "https://video.example.com:444/a", "https://video.example.com.evil.test/a", "https://other.example.com/a", "file:///tmp/a"]) {
      assert.equal(verifiedPageState(page({ url }), origin), "redirect");
    }
    for (const input of ["file:///tmp/a", "javascript:alert(1)", "https://user:password@video.example.com/a"]) {
      assert.throws(() => verifiedPageState(page(), input), { code: "VIDEO_VERIFICATION_REQUIRED" });
    }
  });

  it("bounds captured HTML size", () => {
    assert.equal(verifiedPageState(page({ html: "x".repeat(8 * 1024 * 1024 + 1) }), origin), "oversize");
  });
});

describe("manual browser verification profile lifecycle", () => {
  it("checks existing site profiles without creating or reading their contents", async () => {
    const root = await temporaryRoot();
    const absentRoot = path.join(root, "not-created");
    assert.equal(await hasVerificationProfile(absentRoot, origin), false);
    await assert.rejects(fs.stat(absentRoot), { code: "ENOENT" });
    assert.equal(await hasVerificationProfile(root, origin), false);
    assert.deepEqual(await fs.readdir(root), []);
    const lease = await acquireVerificationProfile(root, `${origin}/watch/one`);
    await lease.release();
    assert.equal(await hasVerificationProfile(root, `${origin}/watch/two`), true);
    assert.equal(await hasVerificationProfile(root, "https://different.example.com/"), false);
    assert.equal(await hasVerificationProfile(root, "http://video.example.com/"), false);
  });

  it("reuses only the site's dedicated profile and preserves its session files", async () => {
    const root = await temporaryRoot();
    const first = await acquireVerificationProfile(root, `${origin}/watch/one`);
    assert.equal(path.dirname(first.profile), root);
    assert.match(path.basename(first.profile), /^[a-f0-9]{32}$/);
    await fs.writeFile(path.join(first.profile, "session-marker"), "fixture");
    await first.release();
    const second = await acquireVerificationProfile(root, `${origin}/watch/two`);
    assert.equal(second.profile, first.profile);
    assert.equal(await fs.readFile(path.join(second.profile, "session-marker"), "utf8"), "fixture");
    await second.release();
    await second.release();
    const other = await acquireVerificationProfile(root, "https://different.example.com/a");
    assert.notEqual(other.profile, first.profile);
    await other.release();
  });

  it("rejects concurrent verification for the same origin and releases its lock", async () => {
    const root = await temporaryRoot();
    const first = await acquireVerificationProfile(root, origin);
    await assert.rejects(acquireVerificationProfile(root, `${origin}/another`), { code: "VIDEO_VERIFICATION_BUSY" });
    await first.release();
    const next = await acquireVerificationProfile(root, origin);
    await next.release();
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".lock")), []);
  });

  it("does not steal another live process's lock", async () => {
    const root = await temporaryRoot();
    const first = await acquireVerificationProfile(root, origin);
    const lockPath = `${first.profile}.lock`;
    await first.release();
    const owner = JSON.stringify({ pid: process.pid, nonce: "other-server" });
    await fs.writeFile(lockPath, owner);
    await assert.rejects(acquireVerificationProfile(root, origin), { code: "VIDEO_VERIFICATION_BUSY" });
    assert.equal(await fs.readFile(lockPath, "utf8"), owner);
  });

  it("cleans up a failed launch so a subsequent attempt is not reported busy", async () => {
    const root = await temporaryRoot();
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(captureVerifiedVideoPage(origin, { profileRoot: root, executablePath: path.join(root, "missing-browser.exe") }), { code: "VIDEO_BROWSER_UNAVAILABLE" });
    }
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".lock")), []);
  });

  it("reports an invalid browser executable and releases its profile", async () => {
    const root = await temporaryRoot();
    const executablePath = path.join(root, "invalid-browser.exe");
    await fs.writeFile(executablePath, "This is not an executable.");
    await assert.rejects(captureVerifiedVideoPage(origin, { profileRoot: root, executablePath, headless: true }), { code: "VIDEO_BROWSER_UNAVAILABLE" });
    const lease = await acquireVerificationProfile(root, origin);
    await lease.release();
  });

  it("does not open a profile when the request was already cancelled", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(captureVerifiedVideoPage(origin, { profileRoot: root, signal: controller.signal }), { code: "VIDEO_VERIFICATION_CANCELLED" });
    assert.deepEqual(await fs.readdir(root), []);
  });
});

// Opt-in integration tests use only a local synthetic page and no real media,
// account, cookies, or external site. Set this to an installed Chrome/Edge path.
describe("manual verification local browser integration", { skip: !process.env.MAGICBOX_BROWSER_TEST_EXECUTABLE }, () => {
  async function fixtureServer() {
    const server = http.createServer((request, response) => {
      if (request.url === "/challenge") {
        response.writeHead(403, { "Content-Type": "text/html", "Cf-Mitigated": "challenge" });
        response.end("<html><title>Just a moment...</title><body><form id='challenge-form'>Local verification fixture</form></body></html>");
      } else if (request.url === "/redirect") {
        response.writeHead(302, { Location: `http://localhost:${server.address().port}/normal` });
        response.end();
      } else {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<html><head><title>Local verification fixture</title></head><body><p>Ordinary video page fixture</p><script>setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<script type=application/json id=player-data>{\"fixture\":true}<\\/script>'); }, 600);</script></body></html>");
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function options(extra = {}) { return { profileRoot: await temporaryRoot(), executablePath: process.env.MAGICBOX_BROWSER_TEST_EXECUTABLE, headless: true, timeoutMs: 15000, ...extra }; }

  it("captures a stable rendered local page and leaves its persistent profile reusable", async () => {
    const site = await fixtureServer();
    const settings = await options();
    const result = await captureVerifiedVideoPage(`${site}/normal`, settings);
    assert.equal(result.finalUrl, `${site}/normal`);
    assert.match(result.html, /id="player-data"/);
    assert.match(result.userAgent, /Chrome|Chromium|Edg/);
    const lease = await acquireVerificationProfile(settings.profileRoot, site);
    await lease.release();
  });

  it("waits for inspection data, throttles retries and awaits page expressions", async () => {
    const site = await fixtureServer();
    const inspectedAt = [];
    const result = await captureVerifiedVideoPage(`${site}/normal`, await options({
      inspectPage: async ({ html, finalUrl, userAgent, evaluate }) => {
        inspectedAt.push(Date.now());
        assert.equal(finalUrl, `${site}/normal`);
        assert.match(html, /id="player-data"/);
        assert.match(userAgent, /Chrome|Chromium|Edg/);
        if (inspectedAt.length === 1) return null;
        await assert.rejects(evaluate('Promise.reject(new Error("private-site-error"))'), (error) =>
          error.code === "VIDEO_BROWSER_EVALUATION_FAILED" && !error.message.includes("private-site-error"));
        return evaluate('new Promise(resolve => setTimeout(() => resolve({ fixture: JSON.parse(document.getElementById("player-data").textContent).fixture }), 100))');
      }
    }));
    assert.equal(inspectedAt.length, 2);
    assert.ok(inspectedAt[1] - inspectedAt[0] >= 1950, "inspection retries must be at least two seconds apart");
    assert.deepEqual(result.inspection, { fixture: true });
  });

  it("cancels a pending page inspection and releases its profile", async () => {
    const site = await fixtureServer();
    const controller = new AbortController();
    let abortTimer;
    const settings = await options({
      signal: controller.signal,
      inspectPage: async ({ evaluate }) => {
        abortTimer = setTimeout(() => controller.abort(), 200);
        return evaluate("new Promise(() => {})");
      }
    });
    try { await assert.rejects(captureVerifiedVideoPage(`${site}/normal`, settings), { code: "VIDEO_VERIFICATION_CANCELLED" }); }
    finally { clearTimeout(abortTimer); }
    const lease = await acquireVerificationProfile(settings.profileRoot, site);
    await lease.release();
  });

  it("preserves a typed inspection error and releases its profile", async () => {
    const site = await fixtureServer();
    const expected = Object.assign(new Error("This requested video is unavailable."), { code: "VIDEO_UNAVAILABLE" });
    const settings = await options({ inspectPage: async () => { throw expected; } });
    await assert.rejects(captureVerifiedVideoPage(`${site}/normal`, settings), (error) => error === expected);
    const lease = await acquireVerificationProfile(settings.profileRoot, site);
    await lease.release();
  });

  it("times out a local challenge without accepting its HTML", async () => {
    const site = await fixtureServer();
    const settings = await options({ timeoutMs: 4000 });
    await assert.rejects(captureVerifiedVideoPage(`${site}/challenge`, settings), { code: "VIDEO_VERIFICATION_REQUIRED" });
    const lease = await acquireVerificationProfile(settings.profileRoot, site);
    await lease.release();
  });

  it("cancels a running browser and releases the profile", async () => {
    const site = await fixtureServer();
    const controller = new AbortController();
    const settings = await options({ signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 2000);
    try { await assert.rejects(captureVerifiedVideoPage(`${site}/challenge`, settings), { code: "VIDEO_VERIFICATION_CANCELLED" }); }
    finally { clearTimeout(timer); }
    const lease = await acquireVerificationProfile(settings.profileRoot, site);
    await lease.release();
  });

  it("rejects a main-document redirect to a different origin", async () => {
    const site = await fixtureServer();
    let inspected = false;
    await assert.rejects(captureVerifiedVideoPage(`${site}/redirect`, await options({ inspectPage: async () => { inspected = true; return {}; } })), { code: "VIDEO_VERIFICATION_REDIRECT" });
    assert.equal(inspected, false, "the inspector must never run on a different origin");
  });
});
