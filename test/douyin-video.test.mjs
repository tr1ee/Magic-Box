import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDouyinDataScannedVideoResults, buildDouyinShareScannedVideoResults, extractDouyinVideosFromPage } from "../server/index.mjs";

const videoId = "7682792289869122856";
const canonicalUrl = `https://www.douyin.com/video/${videoId}`;
const shareUrl = `https://www.iesdouyin.com/share/video/${videoId}/`;
const address = (quality = 1080, suffix = "") => ({
  width: quality, height: Math.round(quality * 16 / 9),
  url_list: [`https://media.example.com/video-${quality}${suffix}.mp4`]
});
const item = (id = videoId) => ({ aweme_id: id, desc: "Sample clip", video: { play_addr: address() } });
const routerHtml = (items) => `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { item_list: items } })}</script>`;
const response = (html, finalUrl = shareUrl) => ({ buffer: Buffer.from(html), finalUrl });

describe("Douyin video page compatibility", () => {
  it("reads the browser detail response and preserves CDN mirrors and sizes", () => {
    const clip = item();
    clip.video.duration = 15000;
    clip.video.bit_rate = [{ gear_name: "adapt_2160_1", bit_rate: 1840000, play_addr: {
      width: 2160, height: 3840, data_size: 3430282,
      url_list: ["https://media.example.com/original.mp4", "https://backup.example.com/original.mp4"]
    } }, { gear_name: "normal_720_0", bit_rate: 1000000, play_addr: address(720) }];
    const results = buildDouyinDataScannedVideoResults({ aweme_detail: clip, status_code: 0 }, canonicalUrl);
    assert.equal(results[0].qualityLabel, "2160p");
    assert.equal(results[0].bytes, 3430282);
    assert.equal(results[0].duration, 15);
    assert.deepEqual(results[0].fallbackUrls, ["https://backup.example.com/original.mp4"]);
    assert.deepEqual(buildDouyinDataScannedVideoResults({ aweme_detail: item("111") }, canonicalUrl), []);
  });

  it("reads URL-encoded RENDER_DATA with camelCase identifiers and bitrate-only video", () => {
    const data = { aweme: { detail: { awemeId: videoId, desc: "Desktop clip", video: {
      bitRateList: [{ gearName: "normal_1080", bitRate: 2200000, playAddr: {
        width: 1080, height: 1920, urlList: ["https://media.example.com/desktop.mp4"]
      } }]
    } } } };
    const html = `<script id="RENDER_DATA" type="application/json">${encodeURIComponent(JSON.stringify(data))}</script>`;
    const videos = buildDouyinShareScannedVideoResults(html, canonicalUrl);
    assert.equal(videos.length, 1);
    assert.equal(videos[0].qualityLabel, "1080p");
    assert.equal(videos[0].url, "https://media.example.com/desktop.mp4");
  });

  it("continues to valid render data after a malformed router assignment", () => {
    const html = `<script>window._ROUTER_DATA = {broken:true}</script><script id="RENDER_DATA">${encodeURIComponent(JSON.stringify({ detail: item() }))}</script>`;
    assert.equal(buildDouyinShareScannedVideoResults(html, canonicalUrl).length, 1);
  });

  it("selects the requested video instead of the first recommended video", () => {
    const recommended = item("1111111111111111111");
    recommended.desc = "Unrelated recommended clip";
    const results = buildDouyinShareScannedVideoResults(routerHtml([recommended, item()]), canonicalUrl);
    assert.equal(results[0].filename, "Sample clip.mp4");
    assert.deepEqual(buildDouyinShareScannedVideoResults(routerHtml([recommended]), canonicalUrl), []);
  });

  it("ignores an empty placeholder for the same video before its playable detail", () => {
    const placeholder = { aweme_id: videoId, video: { play_addr: { url_list: [] }, bit_rate: [] } };
    assert.equal(buildDouyinShareScannedVideoResults(routerHtml([placeholder, item()]), canonicalUrl).length, 1);
  });

  it("recognizes desktop modal and aweme query links", () => {
    for (const key of ["modal_id", "aweme_id", "item_id"]) {
      const results = buildDouyinShareScannedVideoResults(routerHtml([item("111"), item()]), `https://www.douyin.com/discover?${key}=${videoId}`);
      assert.equal(results[0].filename, "Sample clip.mp4");
      assert.deepEqual(buildDouyinShareScannedVideoResults(routerHtml([item("111")]), `https://www.douyin.com/discover?${key}=${videoId}`), []);
    }
  });

  it("retains a demonstrably higher-resolution direct source outside the bitrate list", () => {
    const clip = item();
    clip.video.bit_rate = [{ play_addr: address(720), bit_rate: 1200000 }];
    const results = buildDouyinShareScannedVideoResults(routerHtml([clip]), canonicalUrl);
    assert.deepEqual(results[0].variants.map((variant) => variant.qualityLabel), ["1080p", "720p"]);
  });

  it("falls back to direct playback when bitrate entries contain no playable addresses", () => {
    const clip = item();
    clip.video.bit_rate = [{ gear_name: "normal_720", play_addr: { url_list: [] } }];
    assert.equal(buildDouyinShareScannedVideoResults(routerHtml([clip]), canonicalUrl)[0].url, address().url_list[0]);
  });

  it("parses the resolved short-link body without dropping its share context and refetching", async () => {
    const requested = [];
    const source = "https://v.douyin.com/test-share/";
    const resolvedUrl = `${shareUrl}?share_context=fixture`;
    const results = await extractDouyinVideosFromPage(source, { requestPage: async (url) => {
      requested.push(url);
      return response(routerHtml([item()]), resolvedUrl);
    } });
    assert.deepEqual(requested, [source]);
    assert.equal(results[0].sourcePage, source);
    assert.equal(results[0].referer, resolvedUrl);
    assert.equal(results[0].httpHeaders.Referer, resolvedUrl);
  });

  it("tries desktop render data when the mobile share response has only loader metadata", async () => {
    const requested = [];
    const source = "https://v.douyin.com/test-share/";
    const mobileShell = `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { "video_(id)/page": { itemId: videoId } } })}</script>`;
    const results = await extractDouyinVideosFromPage(source, { requestPage: async (url, options) => {
      requested.push(url);
      assert.ok(options.timeout <= 12000);
      return url === canonicalUrl ? response(routerHtml([item()]), canonicalUrl) : response(mobileShell);
    } });
    assert.deepEqual(requested, [source, shareUrl, canonicalUrl]);
    assert.equal(results.length, 1);
  });

  it("continues to desktop fallback if the share endpoint fails", async () => {
    const requested = [];
    const source = `https://www.douyin.com/discover?modal_id=${videoId}`;
    const results = await extractDouyinVideosFromPage(source, { requestPage: async (url) => {
      requested.push(url);
      if (url === canonicalUrl) return response(routerHtml([item()]), canonicalUrl);
      throw new Error("HTTP 503");
    } });
    assert.deepEqual(requested, [source, shareUrl, canonicalUrl]);
    assert.equal(results.length, 1);
  });

  it("does not invent a playable result for a modern share shell", async () => {
    const results = await extractDouyinVideosFromPage(canonicalUrl, { captureVideoData: async () => null, requestPage: async () => response(
      `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { "video_(id)/page": { itemId: videoId } } })}</script>`
    ) });
    assert.deepEqual(results, []);
  });

  it("captures dynamic detail after share shells and uses the browser's playback headers", async () => {
    let capturedId;
    const source = "https://v.douyin.com/test-share/";
    const results = await extractDouyinVideosFromPage(source, {
      requestPage: async () => response(`<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { "video_(id)/page": { itemId: videoId } } })}</script>`),
      captureVideoData: async (id) => {
        capturedId = id;
        return { data: { aweme_detail: item(), status_code: 0 }, userAgent: "Fixture desktop browser" };
      }
    });
    assert.equal(capturedId, videoId);
    assert.equal(results.length, 1);
    assert.equal(results[0].sourcePage, source);
    assert.equal(results[0].httpHeaders["User-Agent"], "Fixture desktop browser");
    assert.equal(results[0].httpHeaders.Referer, canonicalUrl);
    assert.equal(results[0].variants[0].httpHeaders["User-Agent"], "Fixture desktop browser");
  });

  it("rejects a captured detail for a different video", async () => {
    const results = await extractDouyinVideosFromPage(canonicalUrl, {
      requestPage: async () => response("<html>Loading player</html>"),
      captureVideoData: async () => ({ data: { aweme_detail: item("1111111111111111111") } })
    });
    assert.deepEqual(results, []);
  });
});
