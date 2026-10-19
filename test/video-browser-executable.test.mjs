import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { findVideoBrowserExecutable } from "../server/video-browser-executable.mjs";

function installed(context, files) {
  const checked = [];
  context.mock.method(fs, "stat", async file => {
    checked.push(file);
    return { isFile: () => files.includes(file) };
  });
  return checked;
}
const macOptions = { platform: "darwin", homeDir: "/Users/fixture", env: {} };

test("finds the macOS Chrome bundle without Windows environment variables", async context => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  installed(context, [chrome]);
  assert.equal(await findVideoBrowserExecutable(undefined, macOptions), chrome);
});

test("falls back to macOS Edge and browsers installed only for the current user", async context => {
  for (const executable of [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Users/fixture/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Users/fixture/Applications/Chromium.app/Contents/MacOS/Chromium"
  ]) {
    installed(context, [executable]);
    assert.equal(await findVideoBrowserExecutable(undefined, macOptions), executable);
    context.mock.restoreAll();
  }
});

test("an explicit executable is honored and a missing override never silently falls back", async context => {
  const checked = installed(context, ["/custom/Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
  assert.equal(await findVideoBrowserExecutable("/custom/Chrome", macOptions), "/custom/Chrome");
  await assert.rejects(findVideoBrowserExecutable("/missing/Chrome", macOptions), { code: "VIDEO_BROWSER_UNAVAILABLE" });
  assert.deepEqual(checked, ["/custom/Chrome", "/missing/Chrome"]);
});

test("preserves installed Windows browser detection", async context => {
  const options = { platform: "win32", env: { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local" } };
  for (const browser of [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Users\\fixture\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"
  ]) {
    installed(context, [browser]);
    assert.equal(await findVideoBrowserExecutable(undefined, options), browser);
    context.mock.restoreAll();
  }
});

test("the portable Windows runtime is available only to scans that opt in", async context => {
  const appRoot = path.resolve("fixture-app");
  const fixedRoot = path.join(appRoot, "vendor", "webview2-fixed");
  const browser = path.join(fixedRoot, "123", "runtime", "msedgewebview2.exe");
  installed(context, [browser]);
  context.mock.method(fs, "readdir", async directory => directory === fixedRoot ? ["123"] : ["runtime"]);
  const options = { platform: "win32", env: {}, appRoot };
  await assert.rejects(findVideoBrowserExecutable(undefined, options), { code: "VIDEO_BROWSER_UNAVAILABLE" });
  assert.equal(await findVideoBrowserExecutable(undefined, { ...options, allowBundledRuntime: true }), browser);
});

test("an absent or unreadable browser reports a recoverable availability error", async context => {
  context.mock.method(fs, "stat", async () => { throw Object.assign(new Error("Cannot access bundle"), { code: "EACCES" }); });
  await assert.rejects(findVideoBrowserExecutable(undefined, macOptions), { code: "VIDEO_BROWSER_UNAVAILABLE" });
});
