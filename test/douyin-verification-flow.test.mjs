import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { scanVideoPage, startServer } from "../server/index.mjs";

const videoId = "7682792289869122856";
const canonicalUrl = `https://www.douyin.com/video/${videoId}`;
const shareUrl = `https://www.iesdouyin.com/share/video/${videoId}/`;
const shortUrl = "https://v.douyin.com/fixture-share/";
const mediaUrl = "https://media.example.com/douyin-fixture.mp4";
const previousSettings = process.env.MAGIC_BOX_SETTINGS_FILE;
let temporary, app;
let apiCaptureCalls = 0;

const capture = (id = videoId) => ({
  data: { aweme_detail: {
    aweme_id: id,
    desc: "Douyin verification fixture",
    video: { play_addr: { width: 1080, height: 1920, url_list: [mediaUrl] } }
  } },
  userAgent: "Douyin-verification-fixture-browser"
});
const redirectedPage = finalUrl => ({
  buffer: Buffer.from("<html><title>Douyin</title></html>"), finalUrl
});
const blocked = () => Object.assign(new Error("HTTP 403"), {
  statusCode: 403, code: "HTTP_403", accessBlocked: true
});

before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-douyin-verify-flow-"));
  process.env.MAGIC_BOX_SETTINGS_FILE = path.join(temporary, "settings.json");
  app = await startServer({
    port: 0, dht: false, lsd: false, tracker: false,
    defaultDownloadDir: path.join(temporary, "downloads"),
    assistantDataDir: path.join(temporary, "assistant"),
    videoScanAdapters: {
      site: async () => { throw blocked(); },
      extractor: async () => { throw new Error("private extractor diagnostics"); },
      verifyPage: async () => assert.fail("Douyin must use its detail capture, not generic HTML capture"),
      douyinRequestPage: async url => {
        assert.equal(url, shortUrl);
        return redirectedPage(shareUrl);
      },
      douyinCaptureVideoData: async (id, options) => {
        apiCaptureCalls += 1;
        assert.equal(id, videoId);
        assert.equal(options.headless, false);
        assert.equal(options.timeoutMs, 150000);
        assert.equal(options.profileRoot, path.join(temporary, "video-verification"));
        assert.ok(options.signal instanceof AbortSignal);
        return capture();
      }
    }
  });
});

after(async () => {
  await app?.close();
  if (previousSettings === undefined) delete process.env.MAGIC_BOX_SETTINGS_FILE;
  else process.env.MAGIC_BOX_SETTINGS_FILE = previousSettings;
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

test("Douyin verification opens known video and modal links without another HTTP request", async () => {
  for (const pageUrl of [canonicalUrl, `https://www.douyin.com/discover?modal_id=${videoId}`]) {
    const controller = new AbortController();
    let captureCalls = 0;
    const result = await scanVideoPage(pageUrl, { verifyInBrowser: true, signal: controller.signal }, {
      douyinRequestPage: async () => assert.fail("a known video ID does not need an anonymous HTTP lookup"),
      verifyPage: async () => assert.fail("generic HTML capture cannot retain async Douyin details"),
      douyinCaptureVideoData: async (id, options) => {
        captureCalls += 1;
        assert.equal(id, videoId);
        assert.equal(options.headless, false);
        assert.equal(options.timeoutMs, 150000);
        assert.equal(options.profileRoot, path.join(temporary, "video-verification"));
        assert.equal(options.signal, controller.signal);
        return capture();
      }
    });
    assert.equal(captureCalls, 1);
    assert.equal(result.site, "douyin");
    assert.equal(result.count, 1);
    assert.equal(result.usedBrowserVerification, true);
    assert.equal(result.videos[0].url, mediaUrl);
  }
});

test("Douyin short-link verification retains the original link and canonical playback headers", async () => {
  for (const finalUrl of [shareUrl, canonicalUrl]) {
    const requested = [];
    const result = await scanVideoPage(shortUrl, { verifyInBrowser: true }, {
      douyinRequestPage: async url => { requested.push(url); return redirectedPage(finalUrl); },
      douyinCaptureVideoData: async id => { assert.equal(id, videoId); return capture(); }
    });
    assert.deepEqual(requested, [shortUrl]);
    assert.equal(result.count, 1);
    assert.equal(result.usedBrowserVerification, true);
    const video = result.videos[0];
    for (const source of [video, ...video.variants]) {
      assert.equal(source.sourcePage, shortUrl);
      assert.equal(source.referer, canonicalUrl);
      assert.equal(source.httpHeaders.Referer, canonicalUrl);
      assert.equal(source.httpHeaders["User-Agent"], capture().userAgent);
      assert.equal(source.httpHeaders.Cookie, undefined);
    }
  }
});

test("Douyin short-link verification rejects off-site redirects including lookalike domains", async () => {
  for (const host of ["unrelated.example", "douyin.com.unrelated.example", "fake-douyin.com"]) {
    await assert.rejects(scanVideoPage(shortUrl, { verifyInBrowser: true }, {
      douyinRequestPage: async () => redirectedPage(`https://${host}/video/${videoId}`),
      douyinCaptureVideoData: async () => assert.fail("off-site IDs must not open a verification browser")
    }), { code: "VIDEO_VERIFICATION_REDIRECT" });
  }
});

test("Douyin verification reports a profile URL as a non-video before opening a browser", async () => {
  const profileUrl = "https://www.douyin.com/user/self";
  await assert.rejects(scanVideoPage(profileUrl, { verifyInBrowser: true }, {
    douyinRequestPage: async () => redirectedPage(profileUrl),
    douyinCaptureVideoData: async () => assert.fail("a profile has no requested video to capture")
  }), { code: "DOUYIN_NOT_VIDEO" });
});

test("Douyin verification does not substitute a recommendation or an empty detail response", async () => {
  for (const captured of [capture("1111111111111111111"), { data: { aweme_detail: { aweme_id: videoId, video: {} } } }]) {
    await assert.rejects(scanVideoPage(canonicalUrl, { verifyInBrowser: true }, {
      douyinRequestPage: async () => assert.fail("known video ID"),
      douyinCaptureVideoData: async () => captured
    }), { code: "VIDEO_VERIFIED_NO_MEDIA" });
  }
});

test("Douyin manual verification preserves cancellation and profile-busy errors", async () => {
  for (const code of ["VIDEO_VERIFICATION_CANCELLED", "VIDEO_VERIFICATION_BUSY"]) {
    await assert.rejects(scanVideoPage(canonicalUrl, { verifyInBrowser: true }, {
      douyinCaptureVideoData: async () => { throw Object.assign(new Error("verification interrupted"), { code }); },
      extractor: async () => assert.fail("manual verification errors must not start an unrelated fallback")
    }), { code });
  }
});

test("ordinary Douyin scans pass their dedicated profile and cancellation signal without a visible retry", async () => {
  const controller = new AbortController();
  for (const verifyInBrowser of [undefined, false, "true"]) {
    const result = await scanVideoPage(canonicalUrl, { verifyInBrowser, signal: controller.signal }, {
      site: async (url, options) => {
        assert.equal(url, canonicalUrl);
        assert.equal(options.profileRoot, path.join(temporary, "video-verification"));
        assert.equal(options.signal, controller.signal);
        assert.notEqual(options.headless, false);
        return [{ url: mediaUrl, qualityHeight: 1080, variants: [] }];
      },
      verifyPage: async () => assert.fail("a visible browser requires boolean true"),
      douyinCaptureVideoData: async () => assert.fail("a visible browser requires boolean true")
    });
    assert.equal(result.count, 1);
    assert.notEqual(result.usedBrowserVerification, true);
  }
});

test("Douyin scan API offers verification after both extractors fail and only opens on boolean true", async () => {
  const post = body => fetch(`${app.url}/api/videos/scan`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  for (const verifyInBrowser of [undefined, "true"]) {
    const response = await post({ pageUrl: shortUrl, verifyInBrowser });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, "VIDEO_VERIFICATION_REQUIRED");
    assert.equal(body.canVerifyInBrowser, true);
    assert.equal(apiCaptureCalls, 0);
    assert.doesNotMatch(JSON.stringify(body), /private extractor diagnostics/);
  }
  const response = await post({ pageUrl: shortUrl, verifyInBrowser: true });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.site, "douyin");
  assert.equal(body.usedBrowserVerification, true);
  assert.equal(body.count, 1);
  assert.equal(apiCaptureCalls, 1);
  assert.doesNotMatch(JSON.stringify(body), /video-verification|settings\.json|Cookie/);
});
