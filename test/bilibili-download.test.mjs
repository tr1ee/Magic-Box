import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBilibiliPageScannedVideoResults,
  buildBilibiliPageOrApiResults,
  extractBilibiliVideosWithBrowserLogin,
  requestBilibiliPlayInfo
} from "../server/index.mjs";

const pageUrl = "https://www.bilibili.com/video/BV1234567890/?p=2";
const metadata = {
  videoData: {
    bvid: "BV1234567890",
    title: "Quality regression",
    cid: 100,
    pages: [{ page: 1, cid: 100 }, { page: 2, cid: 200 }]
  }
};
const navInfo = {
  code: 0,
  data: { wbi_img: {
    img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
    sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png"
  } }
};

function playInfo(height, options = {}) {
  return { code: 0, data: {
    accept_quality: [120, 80, 32],
    accept_description: ["4K", "1080P", "480P"],
    dash: {
      duration: 60,
      video: options.videos || [{
        id: height >= 2160 ? 120 : height >= 1080 ? 80 : 32,
        baseUrl: `https://media.example.com/${height}.m4s`,
        height,
        width: Math.round(height * 16 / 9),
        bandwidth: 2000000,
        frameRate: "30"
      }],
      audio: [{ id: 30280, baseUrl: "https://media.example.com/audio.m4s", bandwidth: 128000 }]
    }
  } };
}

function htmlWithInfo(info) {
  return `<script>window.__INITIAL_STATE__=${JSON.stringify(metadata)};</script>` +
    `<script>window.__playinfo__=${JSON.stringify(info)};</script>`;
}

test("BiliBili login accepts the highest available quality even below 1080p", async () => {
  let invocation;
  const videos = await extractBilibiliVideosWithBrowserLogin(pageUrl, "edge", {
    execYtDlp: async (args) => {
      invocation = args;
      return { stdout: JSON.stringify({ title: "720p upload", formats: [{
        format_id: "720", url: "https://media.example.com/720.mp4", height: 720,
        ext: "mp4", vcodec: "avc1", acodec: "mp4a"
      }] }) };
    }
  });
  assert.equal(videos[0].qualityHeight, 720);
  assert.equal(videos[0].cookiesFromBrowser, "edge");
  assert.equal(invocation[invocation.indexOf("--cookies-from-browser") + 1], "edge");
  assert.ok(!invocation.includes("--impersonate"), "cookie extraction must not require optional curl-cffi support");
});

test("BiliBili exported cookies take priority and follow the format into download metadata", async () => {
  const cookiePath = "C:\\local-session\\bilibili.txt";
  let invocation;
  const videos = await extractBilibiliVideosWithBrowserLogin(pageUrl, "edge", {
    cookiesFile: cookiePath,
    execYtDlp: async (args) => {
      invocation = args;
      return { stdout: JSON.stringify({ formats: [{
        format_id: "4k", url: "https://media.example.com/4k.m4s", height: 2160,
        ext: "mp4", vcodec: "avc1", acodec: "none"
      }] }) };
    }
  });
  assert.equal(videos[0].qualityHeight, 2160);
  assert.equal(videos[0].cookiesFile, cookiePath);
  assert.equal(videos[0].variants[0].cookiesFile, cookiePath);
  assert.equal(videos[0].cookiesFromBrowser, null);
  assert.equal(invocation[invocation.indexOf("--cookies") + 1], cookiePath);
  assert.ok(!invocation.includes("--cookies-from-browser"));
});

test("BiliBili requests signed highest-quality playinfo for the selected part", async () => {
  const calls = [];
  const videos = await requestBilibiliPlayInfo("", pageUrl, metadata, {
    now: 1702204169000,
    requestJson: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.pathname.endsWith("/nav")) return navInfo;
      assert.equal(parsed.pathname, "/x/player/wbi/playurl");
      assert.equal(parsed.searchParams.get("cid"), "200");
      assert.equal(parsed.searchParams.get("qn"), "127");
      assert.equal(parsed.searchParams.get("fnval"), "4048");
      assert.equal(parsed.searchParams.get("fourk"), "1");
      assert.equal(parsed.searchParams.get("wts"), "1702204169");
      assert.match(parsed.searchParams.get("w_rid"), /^[0-9a-f]{32}$/);
      return playInfo(2160);
    }
  });
  assert.equal(videos[0].qualityHeight, 2160);
  assert.equal(calls.length, 2, "do not repeat futile quality requests after a playable WBI response");
});

test("BiliBili falls back to legacy playinfo if the signed endpoint rejects the request", async () => {
  const calls = [];
  const videos = await requestBilibiliPlayInfo("", pageUrl, metadata, {
    requestJson: async (url) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      if (pathname.endsWith("/nav")) return navInfo;
      if (pathname.includes("/wbi/")) return { code: -352, message: "request rejected" };
      return playInfo(480);
    }
  });
  assert.equal(videos[0].qualityHeight, 480);
  assert.deepEqual(calls, ["/x/web-interface/nav", "/x/player/wbi/playurl", "/x/player/playurl"]);
  assert.deepEqual(videos[0].variants.filter((variant) => variant.kind !== "bilibili-audio")
    .map((variant) => variant.qualityHeight), [480], "advertised but inaccessible HD formats must not be invented");
});

test("BiliBili does not stop at an embedded 480p preview when the player API offers HD", async () => {
  const videos = await buildBilibiliPageOrApiResults(htmlWithInfo(playInfo(480)), pageUrl, {
    requestJson: async (url) => new URL(url).pathname.endsWith("/nav") ? navInfo : playInfo(2160)
  });
  assert.equal(videos[0].qualityHeight, 2160);
  assert.deepEqual(videos[0].variants.map((variant) => variant.qualityHeight), [2160, 480, null]);
});

test("BiliBili retains embedded HD when the API only exposes an anonymous preview", async () => {
  const videos = await buildBilibiliPageOrApiResults(htmlWithInfo(playInfo(2160)), pageUrl, {
    requestJson: async (url) => new URL(url).pathname.endsWith("/nav") ? navInfo : playInfo(480)
  });
  assert.equal(videos[0].qualityHeight, 2160);
  assert.equal(videos[0].selectedQualityUrl, "https://media.example.com/2160.m4s");
});

test("BiliBili keeps 60fps and enhanced formats at the same resolution", () => {
  const info = playInfo(1080, { videos: [
    { id: 80, height: 1080, frameRate: "30", bandwidth: 2500000, baseUrl: "https://media.example.com/1080.m4s" },
    { id: 116, height: 1080, frameRate: "60000/1001", bandwidth: 2000000, baseUrl: "https://media.example.com/1080-60.m4s" },
    { id: 112, height: 1080, frameRate: "30", bandwidth: 5000000, baseUrl: "https://media.example.com/1080-plus.m4s" }
  ] });
  info.data.support_formats = [{ quality: 112, new_description: "1080P 高码率" }];
  const videos = buildBilibiliPageScannedVideoResults(htmlWithInfo(info), pageUrl);
  const videoVariants = videos[0].variants.filter((variant) => variant.kind !== "bilibili-audio");
  assert.equal(videoVariants.length, 3);
  assert.equal(videoVariants[0].fps, 60);
  assert.match(videoVariants[0].qualityLabel, /1080P 60帧/);
  assert.ok(videoVariants.some((variant) => /高码率/.test(variant.qualityLabel)));
});
