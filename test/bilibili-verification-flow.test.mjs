import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { after, before, test } from "node:test";
import { extractBilibiliVideosWithSiteSession, scanVideoPage, startServer } from "../server/index.mjs";

const bvid = "BV1yHYt6qE1A";
const pageUrl = `https://www.bilibili.com/video/${bvid}/?p=2`;
const userAgent = "BiliBili-fixture-browser";
const metadata = {
  bvid, title: "BiliBili session fixture", cid: 100,
  pages: [{ page: 1, cid: 100 }, { page: 2, cid: 200 }]
};
const wbiImages = {
  img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
  sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png"
};
const previousSettings = process.env.MAGIC_BOX_SETTINGS_FILE;
let temporary;

before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-bilibili-verify-flow-"));
  process.env.MAGIC_BOX_SETTINGS_FILE = path.join(temporary, "settings.json");
});
after(async () => {
  if (previousSettings === undefined) delete process.env.MAGIC_BOX_SETTINGS_FILE;
  else process.env.MAGIC_BOX_SETTINGS_FILE = previousSettings;
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

function playInfo(quality = 80) {
  return { code: 0, data: {
    accept_quality: [120, 112, 80, 32],
    accept_description: ["4K 超清", "1080P 高码率", "1080P 高清", "480P 标清"],
    dash: {
      duration: 60,
      video: [{ id: quality, width: quality === 80 ? 1920 : 854, height: quality === 80 ? 940 : 418,
        bandwidth: 2000000, frameRate: "30", baseUrl: `https://media.example.com/${quality}.m4s` }],
      audio: [{ id: 30280, bandwidth: 128000, baseUrl: "https://media.example.com/audio.m4s" }]
    }
  } };
}

function browserFixture({ loggedIn = true, quality = 80, videoMetadata = metadata, finalUrl = pageUrl, evaluationUrl = finalUrl } = {}) {
  const calls = [];
  let signedIn = loggedIn;
  const snapshot = {
    html: "<html><title>BiliBili session fixture</title></html>", finalUrl, userAgent,
    evaluate: expression => vm.runInNewContext(expression, {
      location: new URL(evaluationUrl), URL, Number, AbortSignal,
      fetch: async (url, options) => {
        const target = new URL(url);
        assert.equal(target.origin, "https://api.bilibili.com");
        assert.equal(options.credentials, "include", "player requests use the dedicated browser session");
        assert.ok(options.signal instanceof AbortSignal);
        calls.push(target);
        if (target.pathname === "/x/web-interface/nav") return { ok: true, json: async () => ({ code: 0, data: { isLogin: signedIn, wbi_img: wbiImages, privateField: "never returned" } }) };
        if (target.pathname === "/x/web-interface/view") return { ok: true, json: async () => ({ code: 0, data: videoMetadata }) };
        if (["/x/player/wbi/playurl", "/x/player/playurl"].includes(target.pathname)) return { ok: true, json: async () => playInfo(quality) };
        assert.fail(`Unexpected player endpoint: ${target.pathname}`);
      }
    }, { timeout: 1000 })
  };
  return {
    calls, snapshot, signIn: () => { signedIn = true; },
    capturePage: async (_url, options) => ({ ...snapshot, inspection: await options.inspectPage(snapshot) })
  };
}

const simpleVideos = height => [{
  url: `https://media.example.com/${height}.mp4`, qualityHeight: height,
  variants: [{ url: `https://media.example.com/${height}.mp4`, qualityHeight: height }]
}];

test("BiliBili manual inspection waits for login, then requests signed highest quality for the requested part", async () => {
  const fixture = browserFixture({ loggedIn: false });
  const controller = new AbortController();
  const profileRoot = path.join(temporary, "video-verification");
  const result = await extractBilibiliVideosWithSiteSession(pageUrl, {
    verifyInBrowser: true, profileRoot, signal: controller.signal,
    requestPage: async () => assert.fail("known BV links do not need an anonymous lookup"),
    capturePage: async (url, options) => {
      assert.equal(url, pageUrl);
      assert.equal(options.headless, false);
      assert.equal(options.timeoutMs, 150000);
      assert.equal(options.profileRoot, profileRoot);
      assert.equal(options.signal, controller.signal);
      assert.equal(await options.inspectPage(fixture.snapshot), null);
      assert.deepEqual(fixture.calls.map(url => url.pathname), ["/x/web-interface/nav"]);
      fixture.signIn();
      return { ...fixture.snapshot, inspection: await options.inspectPage(fixture.snapshot) };
    }
  });
  assert.equal(result.pageUrl, pageUrl);
  assert.deepEqual(fixture.calls.map(url => url.pathname), ["/x/web-interface/nav", "/x/web-interface/nav", "/x/web-interface/view", "/x/player/wbi/playurl"]);
  const request = fixture.calls.at(-1);
  assert.equal(request.searchParams.get("bvid"), bvid);
  assert.equal(request.searchParams.get("cid"), "200");
  assert.equal(request.searchParams.get("qn"), "127");
  assert.equal(request.searchParams.get("fnval"), "4048");
  assert.equal(request.searchParams.get("fourk"), "1");
  assert.match(request.searchParams.get("w_rid"), /^[a-f0-9]{32}$/);
  const video = result.videos[0];
  assert.equal(video.qualityTierHeight, 1080);
  assert.equal(video.qualityHeight, 940);
  assert.equal(video.requiresAudioMerge, true);
  assert.equal(video.audioUrl, "https://media.example.com/audio.m4s");
  assert.ok(video.variants.some(variant => variant.kind === "bilibili-audio"));
  for (const variant of [video, ...video.variants]) {
    assert.equal(variant.httpHeaders["User-Agent"], userAgent);
    assert.equal(variant.httpHeaders.Referer, pageUrl);
    assert.equal(variant.httpHeaders.Cookie, undefined);
  }
  assert.doesNotMatch(JSON.stringify(result), /privateField|never returned|video-verification/);
});

test("a saved BiliBili session requires a real login and never invents advertised premium streams", async () => {
  const expired = browserFixture({ loggedIn: false });
  await assert.rejects(extractBilibiliVideosWithSiteSession(pageUrl, {
    profileRoot: path.join(temporary, "video-verification"),
    capturePage: async (url, options) => {
      assert.equal(options.headless, true);
      assert.equal(options.timeoutMs, 40000);
      return expired.capturePage(url, options);
    }
  }), { code: "BILIBILI_SESSION_REQUIRED" });
  const fixture = browserFixture({ quality: 32 });
  const result = await extractBilibiliVideosWithSiteSession(pageUrl, { capturePage: fixture.capturePage });
  assert.deepEqual(result.videos[0].variants.filter(video => video.kind !== "bilibili-audio").map(video => video.bilibiliQualityId), [32]);
  assert.equal(result.videos[0].qualityTierHeight, 480);
});

test("BiliBili inspection rejects a different BV or part before requesting its player data", async () => {
  for (const finalUrl of [pageUrl.replace(bvid, "BV1abcdefgh1"), pageUrl.replace("p=2", "p=1")]) {
    const fixture = browserFixture({ finalUrl });
    await assert.rejects(extractBilibiliVideosWithSiteSession(pageUrl, { capturePage: fixture.capturePage }), { code: "VIDEO_VERIFICATION_REDIRECT" });
    assert.equal(fixture.calls.length, 0);
  }
  const changedDuringEvaluation = browserFixture({ evaluationUrl: pageUrl.replace("p=2", "p=1") });
  await assert.rejects(extractBilibiliVideosWithSiteSession(pageUrl, { capturePage: changedDuringEvaluation.capturePage }), { code: "VIDEO_VERIFICATION_REDIRECT" });
  assert.equal(changedDuringEvaluation.calls.length, 0);
});

test("BiliBili rejects nonexistent parts and mismatched metadata instead of silently selecting part one", async () => {
  const missingPart = pageUrl.replace("p=2", "p=3");
  const fixture = browserFixture({ finalUrl: missingPart });
  await assert.rejects(extractBilibiliVideosWithSiteSession(missingPart, { capturePage: fixture.capturePage }), { code: "BILIBILI_NOT_VIDEO" });
  assert.ok(fixture.calls.every(url => !url.pathname.includes("playurl")));
  const wrongVideo = browserFixture({ videoMetadata: { ...metadata, bvid: "BV1abcdefgh1" } });
  await assert.rejects(extractBilibiliVideosWithSiteSession(pageUrl, { capturePage: wrongVideo.capturePage }), { code: "BILIBILI_SESSION_REQUIRED" });
});

test("BiliBili short-link verification accepts its canonical video and rejects off-site redirects", async () => {
  const shortUrl = "https://b23.tv/fixture";
  for (const host of ["unrelated.example", "bilibili.com.unrelated.example", "not-bilibili.com"]) {
    await assert.rejects(extractBilibiliVideosWithSiteSession(shortUrl, {
      requestPage: async () => ({ finalUrl: `https://${host}/video/${bvid}/?p=2` }),
      capturePage: async () => assert.fail("off-site redirects must not open a browser")
    }), { code: "VIDEO_VERIFICATION_REDIRECT" });
  }
  const fixture = browserFixture();
  const result = await extractBilibiliVideosWithSiteSession(shortUrl, {
    requestPage: async url => { assert.equal(url, shortUrl); return { finalUrl: pageUrl }; },
    capturePage: fixture.capturePage
  });
  assert.equal(result.pageUrl, pageUrl);
  assert.equal(result.videos[0].qualityTierHeight, 1080);
});

test("ordinary BiliBili scans reuse the saved site session before reading Chrome cookies", async () => {
  const controller = new AbortController();
  const result = await scanVideoPage(pageUrl, { browser: "chrome", signal: controller.signal }, {
    hasSiteSession: async (root, origin) => {
      assert.equal(root, path.join(temporary, "video-verification"));
      assert.equal(origin, "https://www.bilibili.com");
      return true;
    },
    bilibiliSession: async (url, options) => {
      assert.equal(url, pageUrl);
      assert.notEqual(options.verifyInBrowser, true);
      assert.equal(options.signal, controller.signal);
      return { pageUrl, videos: simpleVideos(1080) };
    },
    bilibiliLogin: async () => assert.fail("the saved session must avoid ordinary Chrome cookie decryption"),
    site: async () => assert.fail("do not downgrade a working signed-in result")
  });
  assert.equal(result.authenticated, true);
  assert.equal(result.authenticationMethod, "verification-browser");
  assert.equal(result.videos[0].qualityHeight, 1080);
  assert.notEqual(result.canVerifyInBrowser, true);
});

test("an expired BiliBili session preserves public 480p and offers an actionable login recovery", async () => {
  const result = await scanVideoPage(pageUrl, {}, {
    hasSiteSession: async () => true,
    bilibiliSession: async () => { throw Object.assign(new Error("private diagnostic"), { code: "BILIBILI_SESSION_REQUIRED" }); },
    site: async () => simpleVideos(480)
  });
  assert.equal(result.authenticated, false);
  assert.equal(result.videos[0].qualityHeight, 480);
  assert.equal(result.canVerifyInBrowser, true);
  assert.equal(result.verificationReason, "bilibili-login");
  assert.match(result.verificationMessage, /sign in.*dedicated browser/i);
  assert.match(result.authenticationWarning, /saved BiliBili session/);
  assert.doesNotMatch(JSON.stringify(result), /private diagnostic/);
});

test("explicit BiliBili verification uses the dedicated adapter and reports confirmed low source quality honestly", async () => {
  const result = await scanVideoPage(pageUrl, { verifyInBrowser: true }, {
    bilibiliSession: async (url, options) => {
      assert.equal(url, pageUrl);
      assert.equal(options.verifyInBrowser, true);
      assert.equal(options.profileRoot, path.join(temporary, "video-verification"));
      return { pageUrl, videos: simpleVideos(480) };
    },
    verifyPage: async () => assert.fail("BiliBili cannot use the generic HTML-only scan"),
    site: async () => assert.fail("manual verification must not switch to anonymous extraction")
  });
  assert.equal(result.usedBrowserVerification, true);
  assert.equal(result.authenticationMethod, "verification-browser");
  assert.equal(result.videos[0].qualityHeight, 480);
  assert.notEqual(result.canVerifyInBrowser, true, "a confirmed 480p source must not loop back to login");
  assert.match(result.qualityWarning, /signed-in account was checked/);
});

test("BiliBili scan HTTP API returns the login recovery action with usable 480p and opens it only for boolean true", async () => {
  let sessionCalls = 0;
  const app = await startServer({
    port: 0, dht: false, lsd: false, tracker: false,
    defaultDownloadDir: path.join(temporary, "downloads"),
    assistantDataDir: path.join(temporary, "assistant"),
    videoScanAdapters: {
      hasSiteSession: async () => false,
      site: async () => simpleVideos(480),
      verifyPage: async () => assert.fail("generic browser capture is not the BiliBili verification route"),
      bilibiliSession: async (url, options) => {
        sessionCalls += 1;
        assert.equal(options.verifyInBrowser, true);
        assert.ok(options.signal instanceof AbortSignal);
        return { pageUrl: url, videos: simpleVideos(1080) };
      }
    }
  });
  const post = body => fetch(`${app.url}/api/videos/scan`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    for (const verifyInBrowser of [undefined, "true"]) {
      const response = await post({ pageUrl, verifyInBrowser });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.count, 1);
      assert.equal(body.videos[0].qualityHeight, 480);
      assert.equal(body.canVerifyInBrowser, true);
      assert.equal(body.verificationReason, "bilibili-login");
      assert.ok(body.verificationMessage);
      assert.equal(sessionCalls, 0);
    }
    const response = await post({ pageUrl, verifyInBrowser: true });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.usedBrowserVerification, true);
    assert.equal(body.videos[0].qualityHeight, 1080);
    assert.equal(sessionCalls, 1);
    assert.doesNotMatch(JSON.stringify(body), /settings\.json|video-verification|Cookie/);
  } finally { await app.close(); }
});
