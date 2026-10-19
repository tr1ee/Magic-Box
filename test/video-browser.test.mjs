import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { captureDouyinVideoData, douyinDetailMatchesVideo, isDouyinDetailAccessBlocked, isDouyinDetailResponse } from "../server/video-browser.mjs";
import { acquireVerificationProfile } from "../server/video-verification-browser.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function temporaryRoot() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-douyin-browser-test-"));
  cleanups.push(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 8, retryDelay: 150 }));
  return directory;
}
const canonicalUrl = "https://www.douyin.com/video/12345";

test("browser capture only accepts Douyin detail responses from the real host", () => {
  assert.equal(isDouyinDetailResponse("https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=12345"), true);
  assert.equal(isDouyinDetailResponse("https://www-hj.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=12345"), true);
  for (const url of ["https://douyin.com.example.org/aweme/v1/web/aweme/detail/", "http://www.douyin.com/aweme/v1/web/aweme/detail/", "https://www.douyin.com/aweme/v1/web/feed/", "invalid"]) {
    assert.equal(isDouyinDetailResponse(url), false);
  }
});

test("browser capture rejects recommendation details and missing media", () => {
  assert.equal(douyinDetailMatchesVideo({ aweme_detail: { aweme_id: "12345", video: {} } }, "12345"), true);
  assert.equal(douyinDetailMatchesVideo({ aweme_detail: { aweme_id: "54321", video: {} } }, "12345"), false);
  assert.equal(douyinDetailMatchesVideo({ aweme_detail: { aweme_id: "12345" } }, "12345"), false);
});

test("invalid target is rejected before launching any browser", async () => {
  const profileRoot = await temporaryRoot();
  await assert.rejects(captureDouyinVideoData("../profile", { profileRoot, headless: false }), /Invalid Douyin video ID/);
  assert.deepEqual(await fs.readdir(profileRoot), []);
});

test("only denied detail requests for the exact target offer immediate session recovery", () => {
  const url = "https://www-hj.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=12345";
  assert.equal(isDouyinDetailAccessBlocked(url, 403, "12345"), true);
  assert.equal(isDouyinDetailAccessBlocked(url, 429, "12345"), true);
  assert.equal(isDouyinDetailAccessBlocked(url, 200, "12345"), false);
  assert.equal(isDouyinDetailAccessBlocked(url, 403, "54321"), false);
  assert.equal(isDouyinDetailAccessBlocked(url.replace("www-hj.douyin.com", "douyin.com.evil.test"), 403, "12345"), false);
  assert.equal(isDouyinDetailAccessBlocked(url.replace("aweme_id=12345", "unrelated=12345"), 403, "12345"), false);
  assert.equal(isDouyinDetailAccessBlocked("invalid", 403, "12345"), false);
});

test("a cancelled scan never creates a profile or launches its browser", async () => {
  const profileRoot = await temporaryRoot();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(captureDouyinVideoData("12345", { profileRoot, signal: controller.signal, headless: false }), { code: "VIDEO_VERIFICATION_CANCELLED" });
  assert.deepEqual(await fs.readdir(profileRoot), []);
});

test("cancellation during browser lookup releases a newly acquired profile", async (context) => {
  const profileRoot = await temporaryRoot();
  const controller = new AbortController();
  const stat = context.mock.method(fs, "stat", async () => {
    controller.abort();
    throw Object.assign(new Error("Lookup interrupted"), { code: "ENOENT" });
  });
  await assert.rejects(captureDouyinVideoData("12345", {
    profileRoot, executablePath: path.join(profileRoot, "cancelled-browser.exe"), signal: controller.signal
  }), { code: "VIDEO_VERIFICATION_CANCELLED" });
  assert.equal(stat.mock.callCount(), 1);
  stat.mock.restore();
  const lease = await acquireVerificationProfile(profileRoot, canonicalUrl);
  await lease.release();
  assert.deepEqual((await fs.readdir(profileRoot)).filter(name => name.endsWith(".lock")), []);
});

test("public and visible scans cannot use a verification profile already owned by another scan", async () => {
  const profileRoot = await temporaryRoot();
  const lease = await acquireVerificationProfile(profileRoot, canonicalUrl);
  try {
    for (const headless of [true, false]) {
      await assert.rejects(captureDouyinVideoData("67890", { profileRoot, headless }), { code: "VIDEO_VERIFICATION_BUSY" });
    }
    assert.equal(await fs.stat(`${lease.profile}.lock`).then(stat => stat.isFile()), true);
  } finally { await lease.release(); }
});

test("a failed browser launch releases its lock and preserves the dedicated session", async () => {
  const profileRoot = await temporaryRoot();
  const lease = await acquireVerificationProfile(profileRoot, canonicalUrl);
  const marker = path.join(lease.profile, "session-marker");
  await fs.writeFile(marker, "retained fixture session");
  await lease.release();
  for (const headless of [true, false]) {
    await assert.rejects(captureDouyinVideoData("12345", {
      profileRoot, headless, executablePath: path.join(profileRoot, "missing-browser.exe")
    }), { code: "VIDEO_BROWSER_UNAVAILABLE" });
  }
  const next = await acquireVerificationProfile(profileRoot, canonicalUrl);
  try {
    assert.equal(next.profile, lease.profile);
    assert.equal(await fs.readFile(marker, "utf8"), "retained fixture session");
  } finally { await next.release(); }
  assert.deepEqual((await fs.readdir(profileRoot)).filter(name => name.endsWith(".lock")), []);
});

test("an invalid executable does not leave the profile busy", async () => {
  const profileRoot = await temporaryRoot();
  const executablePath = path.join(profileRoot, "invalid-browser.exe");
  await fs.writeFile(executablePath, "This is not an executable.");
  const oldLease = await acquireVerificationProfile(profileRoot, canonicalUrl);
  const oldEndpoint = path.join(oldLease.profile, "DevToolsActivePort");
  await fs.writeFile(oldEndpoint, "9222\n/devtools/browser/old-process");
  await oldLease.release();
  await assert.rejects(captureDouyinVideoData("12345", { profileRoot, executablePath }), { code: "VIDEO_BROWSER_UNAVAILABLE" });
  await assert.rejects(fs.stat(oldEndpoint), { code: "ENOENT" });
  const lease = await acquireVerificationProfile(profileRoot, canonicalUrl);
  await lease.release();
});
