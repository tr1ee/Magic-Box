import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createVideoAuthenticationRegistry, prepareVideoCookieArgs, validateVideoCookiesFile } from "../server/video-auth.mjs";
import { buildYtDlpScannedVideoResults, normalizeVideoRequestList, parseVideoPageInput, scanVideoPage } from "../server/index.mjs";

const bilibili = "https://www.bilibili.com/video/BV1234567890/";
const douyin = "https://v.douyin.com/uPreGFr5-Bs/";
const video = (height) => [{ url: `https://cdn.example.com/${height}.mp4`, qualityHeight: height, variants: [{ qualityHeight: height }] }];
const previousSettings = process.env.MAGIC_BOX_SETTINGS_FILE;
let settingsDirectory;
before(async () => {
  settingsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-auth-settings-"));
  process.env.MAGIC_BOX_SETTINGS_FILE = path.join(settingsDirectory, "settings.json");
});
after(async () => {
  if (previousSettings === undefined) delete process.env.MAGIC_BOX_SETTINGS_FILE;
  else process.env.MAGIC_BOX_SETTINGS_FILE = previousSettings;
  await fs.rm(settingsDirectory, { recursive: true, force: true });
});

test("silent source keeps its exact quality without requiring nonexistent audio", () => {
  const videos = buildYtDlpScannedVideoResults({ formats: [{
    format_id: "v4k", height: 2160, vcodec: "avc1", acodec: "none",
    url: "https://cdn.example.com/silent.mp4"
  }] }, bilibili);
  assert.equal(videos[0].formatSelector, "v4k");
  assert.equal(videos[0].requiresAudioMerge, false);
  assert.match(videos[0].qualityLabel, /video-only/);
});

async function withCookieFile(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-video-auth-test-"));
  const filename = path.join(directory, "cookies.txt");
  const content = "# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\ttest-only\n";
  await fs.writeFile(filename, content);
  try { await run(filename, content); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("cookie validation rejects relative paths, missing files and non-Netscape content", async () => {
  await assert.rejects(validateVideoCookiesFile("cookies.txt"), { code: "INVALID_VIDEO_COOKIES_FILE" });
  await assert.rejects(validateVideoCookiesFile(path.join(os.tmpdir(), "missing-file.cookies.txt")), { code: "INVALID_VIDEO_COOKIES_FILE" });
  await withCookieFile(async (filename) => {
    assert.equal(await validateVideoCookiesFile(`"${filename}"`), filename);
    await fs.writeFile(filename, "not a cookie export");
    await assert.rejects(validateVideoCookiesFile(filename), { code: "INVALID_VIDEO_COOKIES_FILE" });
  });
});

test("extractor uses isolated cookie copy and cleans it without modifying original", async () => {
  await withCookieFile(async (filename, content) => {
    const prepared = await prepareVideoCookieArgs(["--cookies", filename, bilibili]);
    const temporary = prepared.args[1];
    assert.notEqual(temporary, filename);
    assert.equal(await fs.readFile(temporary, "utf8"), content);
    await fs.writeFile(temporary, "updated extractor cookie jar");
    await prepared.cleanup();
    await assert.rejects(fs.access(temporary));
    assert.equal(await fs.readFile(filename, "utf8"), content);
  });
});

test("cookie path stays server-side and expired download sessions require rescan", () => {
  let now = 0;
  const registry = createVideoAuthenticationRegistry({ now: () => now, ttlMs: 100, maxEntries: 2 });
  const videos = registry.bind([{ cookiesFile: "private-path", variants: [{ cookiesFile: "private-path" }] }], "private-path");
  assert.ok(!JSON.stringify(videos).includes("private-path"));
  const token = videos[0].authSessionId;
  assert.equal(videos[0].variants[0].authSessionId, token);
  assert.equal(registry.resolve(token), "private-path");
  now = 101;
  assert.throws(() => registry.resolve(token), { code: "VIDEO_LOGIN_EXPIRED" });
});

test("BiliBili multipart URL keeps the requested part", () => {
  assert.equal(parseVideoPageInput(`${bilibili}?p=2&from=share`).href, `${bilibili}?p=2`);
});

test("scan keeps 720p session result instead of downgrading to public 480p", async () => {
  const result = await scanVideoPage(bilibili, { browser: "edge" }, {
    bilibiliLogin: async () => video(720),
    site: async () => { throw new Error("must not downgrade"); }
  });
  assert.equal(result.videos[0].qualityHeight, 720);
  assert.equal(result.authenticationMethod, "browser");
  assert.equal(result.authenticationWarning, null);
});

test("public BiliBili scan reports actual quality and a login recovery hint", async () => {
  const result = await scanVideoPage(bilibili, {}, { site: async () => video(480) });
  assert.equal(result.authenticated, false);
  assert.match(result.qualityWarning, /480p.*Enable site login/);
});

test("browser failure retains cause and usable public result", async () => {
  const message = "Browser session could not be read; use fresh cookies.txt.";
  const result = await scanVideoPage(bilibili, { bilibiliBrowser: "chrome" }, {
    bilibiliLogin: async () => { throw Object.assign(new Error(message), { code: "BILIBILI_BROWSER_LOGIN_FAILED" }); },
    site: async () => video(480)
  });
  assert.equal(result.authenticationWarning, message);
  assert.equal(result.requestedBrowser, "chrome");
  assert.equal(result.videos[0].qualityHeight, 480);
});

test("public parser failure still tries independent BiliBili extractor", async () => {
  const result = await scanVideoPage(bilibili, {}, {
    site: async () => { throw new Error("upstream markup changed"); },
    extractor: async () => video(1080)
  });
  assert.equal(result.videos[0].qualityHeight, 1080);
});

test("Douyin fallback receives opted-in browser login", async () => {
  let received;
  const result = await scanVideoPage(douyin, { browser: "firefox" }, {
    site: async () => [],
    extractor: async (_url, options) => { received = options; return video(1080); }
  });
  assert.equal(received.browser, "firefox");
  assert.equal(result.site, "douyin");
  assert.equal(result.authenticationMethod, "browser");
});

test("Douyin fallback does not read any browser without opt-in", async () => {
  await assert.rejects(scanVideoPage(douyin, {}, {
    site: async () => [],
    extractor: async (_url, options) => { assert.deepEqual(options, {}); throw new Error("raw secret stderr"); }
  }), (error) => error.code === "DOUYIN_SESSION_REQUIRED" && /Verify in browser/.test(error.message) && !error.message.includes("raw secret"));
});

test("cookie file login overrides browser and does not expose its path in response", async () => {
  await withCookieFile(async (filename) => {
    const result = await scanVideoPage(bilibili, { browser: "edge", cookiesFile: filename }, {
      bilibiliLogin: async (_url, browser, options) => {
        assert.equal(browser, null);
        assert.equal(options.cookiesFile, filename);
        return [{ ...video(2160)[0], cookiesFile: filename, variants: [{ cookiesFile: filename, qualityHeight: 2160 }] }];
      }
    });
    assert.equal(result.authenticationMethod, "cookies-file");
    assert.equal(result.browser, null);
    assert.ok(result.videos[0].authSessionId);
    assert.ok(!JSON.stringify(result).includes("cookies.txt"));
    assert.equal(result.videos[0].cookiesFile, undefined);
    const selected = { ...result.videos[0], ...result.videos[0].variants[0] };
    const normalized = normalizeVideoRequestList([selected], bilibili)[0];
    assert.equal(normalized.cookiesFile, filename, "download resolves the server-side session after quality selection");
    assert.equal(normalizeVideoRequestList([normalized])[0].cookiesFile, filename, "download's second normalization retains the session");
  });
});
