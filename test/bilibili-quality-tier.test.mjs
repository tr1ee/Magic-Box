import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBilibiliPageScannedVideoResults, buildYtDlpScannedVideoResults, scanVideoPage } from "../server/index.mjs";

const pageUrl = "https://www.bilibili.com/video/BV1yHYt6qE1A/";
const audio = { format_id: "30280", url: "https://cdn.example.com/audio.m4a", vcodec: "none", acodec: "mp4a" };
const video = (overrides = {}) => ({
  format_id: "30080", quality: 80, format: "1080P 高清", width: 1920, height: 940,
  url: "https://cdn.example.com/1080.m4s", ext: "mp4", vcodec: "avc1", acodec: "none", ...overrides
});

test("BiliBili 1080P tier remains 1080P when the encoded frame is 1920x940", () => {
  const [result] = buildYtDlpScannedVideoResults({ formats: [video(), audio] }, pageUrl);
  assert.equal(result.qualityLabel, "1080P 高清 (1920×940) mp4 + audio");
  assert.equal(result.qualityHeight, 940, "actual dimensions must not be falsified");
  assert.equal(result.qualityWidth, 1920);
  assert.equal(result.qualityTierHeight, 1080);
  assert.equal(result.bilibiliQualityId, 80);
  assert.equal(result.formatSelector, "30080+bestaudio", "tier ID must not replace the exact format selector");
});

test("public BiliBili 854x418 stream uses its 480P tier in the label and warning", async () => {
  const info = { data: {
    accept_quality: [112, 80, 32], accept_description: ["1080P 高码率", "1080P 高清", "480P 标清"],
    dash: { video: [{ id: 32, baseUrl: "https://cdn.example.com/480.m4s", width: 854, height: 418 }],
      audio: [{ id: 30280, baseUrl: "https://cdn.example.com/audio.m4a" }] }
  } };
  const videos = buildBilibiliPageScannedVideoResults(`<script>window.__playinfo__=${JSON.stringify(info)};</script>`, pageUrl);
  assert.equal(videos[0].qualityLabel, "480P 标清 (854×418) mp4 DASH + audio");
  assert.equal(videos[0].qualityHeight, 418);
  assert.equal(videos[0].qualityTierHeight, 480);
  assert.equal(videos[0].variants.filter(v => v.kind !== "bilibili-audio").length, 1, "advertised premium qualities are not downloadable streams");
  const result = await scanVideoPage(pageUrl, {}, { hasSiteSession: async () => false, site: async () => videos });
  assert.match(result.qualityWarning, /at most 480p/);
  assert.doesNotMatch(result.qualityWarning, /418p/);
});

test("BiliBili high-bitrate 1080P remains distinct and ranks above ordinary 1080P", () => {
  const [result] = buildYtDlpScannedVideoResults({ formats: [
    video({ tbr: 5000 }),
    video({ quality: 112, format_id: "30112", format: "1080P 高码率", url: "https://cdn.example.com/enhanced.m4s", tbr: 5000 }), audio
  ] }, pageUrl);
  assert.equal(result.variants.length, 2);
  assert.equal(result.bilibiliQualityId, 112);
  assert.equal(result.formatSelector, "30112+bestaudio");
  assert.match(result.variants[0].qualityLabel, /1080P 高码率/);
  assert.match(result.variants[1].qualityLabel, /1080P 高清/);
});

test("known BiliBili tier IDs supply missing display names without changing dimensions", () => {
  const [result] = buildYtDlpScannedVideoResults({ formats: [video({ format: "30080 - 1920x940" }), audio] }, pageUrl);
  assert.equal(result.qualityLabel, "1080P 高清 (1920×940) mp4 + audio");
  assert.equal(result.qualityHeight, 940);
});

test("HDR and Dolby labels do not invent a 4K resolution", () => {
  for (const [quality, format] of [[125, "HDR 真彩"], [126, "杜比视界"]]) {
    const [result] = buildYtDlpScannedVideoResults({ formats: [video({ quality, format }), audio] }, pageUrl);
    assert.equal(result.qualityTierHeight, null);
    assert.equal(result.qualityHeight, 940);
    assert.ok(result.qualityLabel.startsWith(`${format} (1920×940)`));
    assert.doesNotMatch(result.qualityLabel, /2160|4K/);
  }
});

test("HDR at the same actual size is not demoted by mixing tier and pixel heights", () => {
  const [result] = buildYtDlpScannedVideoResults({ formats: [video(), video({ quality: 125, format: "HDR 真彩", format_id: "30125", url: "https://cdn.example.com/hdr.m4s" }), audio] }, pageUrl);
  assert.equal(result.bilibiliQualityId, 125);
});

test("non-BiliBili sources keep pixel-based labels even if their quality happens to be 80", () => {
  const [result] = buildYtDlpScannedVideoResults({ formats: [video(), audio] }, "https://example.com/video");
  assert.equal(result.qualityLabel, "940p mp4 + audio");
  assert.equal(result.qualityTierHeight, undefined);
  assert.equal(result.bilibiliQualityId, undefined);
});
