import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { buildMissAvPageScannedVideoResults } from "../server/index.mjs";

describe("HLS quality discovery from page metadata", () => {
  let server;
  let baseUrl;
  const requests = [];
  const emptyMediaPlaylist = "#EXTM3U\n#EXT-X-ENDLIST\n";

  before(async () => {
    server = http.createServer((request, response) => {
      requests.push({
        path: request.url,
        referer: request.headers.referer,
        userAgent: request.headers["user-agent"]
      });
      if (request.url === "/redirect-master.m3u8") {
        response.writeHead(302, { Location: "/actual/master.m3u8" });
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      if (request.url === "/master.m3u8" || request.url === "/actual/master.m3u8") {
        response.end([
          "#EXTM3U",
          "#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080",
          "/opaque-a.m3u8",
          "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720",
          "/opaque-b.m3u8",
          ""
        ].join("\n"));
        return;
      }
      if (request.url === "/header-protected-master.m3u8") {
        if (request.headers["user-agent"] !== "fixture-agent" || request.headers.referer !== `${baseUrl}/watch`) {
          response.statusCode = 403;
          response.end("Expected the page's user agent and referer.");
          return;
        }
        response.end([
          "#EXTM3U",
          "#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080",
          "/opaque-a.m3u8",
          ""
        ].join("\n"));
        return;
      }
      if (["/opaque-a.m3u8", "/opaque-b.m3u8", "/720p.m3u8", "/1080p.m3u8", "/unlabelled.m3u8"].includes(request.url)) {
        // Metadata only: the fixture never serves or names media segments.
        response.end(emptyMediaPlaylist);
        return;
      }
      response.statusCode = 404;
      response.end("Unknown metadata fixture.");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(() => {
    requests.length = 0;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("lets an HLS manifest correct a page label for an already discovered URL", async () => {
    const html = `<source src="/opaque-a.m3u8" label="720p"><source src="/master.m3u8">`;
    const results = await buildMissAvPageScannedVideoResults(html, `${baseUrl}/watch`);
    const variants = results[0].variants;

    assert.equal(results[0].url, `${baseUrl}/opaque-a.m3u8`);
    assert.equal(results[0].qualityHeight, 1080);
    assert.equal(variants.find((variant) => variant.url === `${baseUrl}/opaque-a.m3u8`)?.qualityHeight, 1080);
    assert.equal(variants.find((variant) => variant.url === `${baseUrl}/opaque-b.m3u8`)?.qualityHeight, 720);
  });

  it("keeps a main player source when a packed script exposes only a lower quality", async () => {
    const payload = "0='/1';".replaceAll("'", "\\'");
    const html = `<script>eval(function(p,a,c,k,e,d){return p}('${payload}',36,2,'source720|720p.m3u8'.split('|'),0,{}))</script>
      <video><source src="/1080p.m3u8" label="1080p"></video>`;
    const results = await buildMissAvPageScannedVideoResults(html, `${baseUrl}/watch`);

    assert.equal(results[0].qualityHeight, 1080);
    assert.ok(results[0].variants.some((variant) => variant.url === `${baseUrl}/1080p.m3u8`));
    assert.ok(results[0].variants.some((variant) => variant.url === `${baseUrl}/720p.m3u8`));
  });

  it("uses the page's request headers when expanding an HLS master", async () => {
    const html = `<source src="/header-protected-master.m3u8">`;
    const results = await buildMissAvPageScannedVideoResults(html, `${baseUrl}/watch`, { userAgent: "fixture-agent" });
    const masterRequest = requests.find((request) => request.path === "/header-protected-master.m3u8");

    assert.equal(masterRequest?.userAgent, "fixture-agent");
    assert.equal(masterRequest?.referer, `${baseUrl}/watch`);
    assert.ok(results[0].variants.some((variant) => variant.qualityHeight === 1080));
  });

  it("retains an unlabelled source alongside an explicitly labelled rendition", async () => {
    const html = `<video><source src="/unlabelled.m3u8"><source src="/720p.m3u8" label="720p"></video>`;
    const results = await buildMissAvPageScannedVideoResults(html, `${baseUrl}/watch`);
    const unlabelled = results[0].variants.find((variant) => variant.url === `${baseUrl}/unlabelled.m3u8`);

    assert.ok(unlabelled, "An unknown resolution must not be discarded merely because another source has a known quality.");
    assert.equal(unlabelled.qualityHeight, null);
    assert.doesNotMatch(unlabelled.qualityLabel, /1080|2160|4k/i);
    assert.ok(results[0].variants.some((variant) => variant.qualityHeight === 720));
  });

  it("removes both original and redirected master URLs after discovering their renditions", async () => {
    const html = `<source src="/redirect-master.m3u8">`;
    const results = await buildMissAvPageScannedVideoResults(html, `${baseUrl}/watch`);
    const variants = results[0].variants;

    assert.equal(results[0].qualityHeight, 1080);
    assert.deepEqual(variants.map((variant) => variant.url), [
      `${baseUrl}/opaque-a.m3u8`,
      `${baseUrl}/opaque-b.m3u8`
    ]);
    assert.equal(variants.find((variant) => variant.qualityHeight === 720)?.url, `${baseUrl}/opaque-b.m3u8`);
    assert.ok(requests.some((request) => request.path === "/redirect-master.m3u8"));
    assert.ok(requests.some((request) => request.path === "/actual/master.m3u8"));
  });
});
