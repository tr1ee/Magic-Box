import assert from "node:assert/strict";
import { test } from "node:test";
import { probeVideoDimensions } from "../server/video-dimensions.mjs";

const media = { url: "https://cdn.example.com/source.m3u8?token=private" };
const ffprobePath = "C:\\Media Tools\\ffprobe.exe";
const dimensions = JSON.stringify({ streams: [{ width: 1920, height: 1080 }] });

function mockProbe(stdout = dimensions, error = null) {
  const calls = [];
  return {
    calls,
    options: {
      ffprobePath,
      execFile(...args) {
        calls.push(args.slice(0, 3));
        args[3](error, stdout, "stderr is never returned");
      }
    }
  };
}

test("media probe discovers actual 1080p dimensions using a bounded shell-free ffprobe", async () => {
  const probe = mockProbe();
  assert.deepEqual(await probeVideoDimensions(media, probe.options), {
    qualityHeight: 1080,
    qualityWidth: 1920,
    qualityLabel: "1080p",
    qualityRank: 1080,
    qualityExplicit: true,
    qualitySource: "media-probe"
  });
  assert.equal(probe.calls.length, 1);
  const [command, args, options] = probe.calls[0];
  assert.equal(command, ffprobePath);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 8000);
  assert.equal(options.maxBuffer, 65536);
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value("-i"), media.url);
  assert.equal(value("-select_streams"), "v:0");
  assert.equal(value("-show_entries"), "stream=width,height");
  assert.equal(value("-of"), "json");
  assert.equal(value("-protocol_whitelist"), "http,https,tcp,tls,crypto");
  assert.equal(value("-rw_timeout"), "3000000");
  assert.equal(value("-probesize"), "1048576");
  assert.equal(value("-analyzeduration"), "2000000");
  assert.equal(value("-read_intervals"), "%+#1");
});

test("probe preserves request headers and supplies a valid fallback Referer", async () => {
  const probe = mockProbe();
  await probeVideoDimensions({
    ...media,
    sourcePage: "https://www.example.com/watch/1",
    httpHeaders: { "User-Agent": "TestBrowser/1.0", Origin: "https://www.example.com", Cookie: "session=private" }
  }, probe.options);
  const args = probe.calls[0][1];
  assert.equal(args[args.indexOf("-headers") + 1], "User-Agent: TestBrowser/1.0\r\nOrigin: https://www.example.com\r\nCookie: session=private\r\nReferer: https://www.example.com/watch/1\r\n");
  const explicit = mockProbe();
  await probeVideoDimensions({ ...media, referer: "invalid", httpHeaders: { referer: "https://explicit.example.com/" } }, explicit.options);
  const explicitArgs = explicit.calls[0][1];
  assert.equal(explicitArgs[explicitArgs.indexOf("-headers") + 1], "referer: https://explicit.example.com/\r\n");
});

test("probe reports actual nonstandard dimensions without rounding or tier inference", async () => {
  const probe = mockProbe(JSON.stringify({ streams: [{ width: 1920, height: 940 }] }));
  const result = await probeVideoDimensions(media, probe.options);
  assert.equal(result.qualityHeight, 940);
  assert.equal(result.qualityLabel, "940p");
});

test("missing video, invalid JSON and invalid dimensions remain unknown", async () => {
  for (const stdout of ["", "not-json", "null", "{}", '{"streams":[]}', ...[
    { width: 0, height: 1080 }, { width: 1920, height: -1 },
    { width: "1920", height: 1080 }, { width: 1920, height: 1080.5 },
    { width: 100000, height: 1080 }
  ].map((stream) => JSON.stringify({ streams: [stream] }))]) {
    assert.equal(await probeVideoDimensions(media, mockProbe(stdout).options), null);
  }
});

test("failed, timed-out and synchronously failed probes remain unknown without leaking errors", async () => {
  for (const error of [new Error("sensitive URL"), Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" })]) {
    assert.equal(await probeVideoDimensions(media, mockProbe(dimensions, error).options), null);
  }
  assert.equal(await probeVideoDimensions(media, { ffprobePath, execFile() { throw new Error("cannot launch"); } }), null);
});

test("probe rejects non-HTTP URLs, URL credentials and missing media URL before spawning", async () => {
  for (const video of [
    { url: "file:///private/file.m3u8" }, { url: "ftp://example.com/media.m3u8" },
    { url: "https://user:password@example.com/media.m3u8" }, { url: "https://user@example.com/media.m3u8" },
    { url: "https://cdn.example.com/\r\nprivate" }, { url: "not-a-url" },
    { sourcePage: media.url }, { sourceUrl: media.url }, null
  ]) {
    const probe = mockProbe();
    assert.equal(await probeVideoDimensions(video, probe.options), null);
    assert.equal(probe.calls.length, 0);
  }
  const probe = mockProbe();
  assert.equal(await probeVideoDimensions(media, { ...probe.options, ffprobePath: undefined }), null);
  assert.equal(probe.calls.length, 0);
});

test("invalid header names, values, duplicate names and invalid fallback Referer are rejected", async () => {
  for (const httpHeaders of [
    { "User-Agent": "safe\r\nInjected: value" }, { "Bad\nName": "value" },
    { "User-Agent": "bad\0value" }, { "User Agent": "value" },
    { Cookie: "value", cookie: "another" }, { Cookie: ["value"] },
    { Cookie: "x".repeat(17000) }, ["bad"]
  ]) {
    const probe = mockProbe();
    assert.equal(await probeVideoDimensions({ ...media, httpHeaders }, probe.options), null);
    assert.equal(probe.calls.length, 0);
  }
  const probe = mockProbe();
  assert.equal(await probeVideoDimensions({ ...media, referer: "https://example.com/\r\nBad: value" }, probe.options), null);
  assert.equal(probe.calls.length, 0);
});

test("abort signal and explicit timeout are forwarded; pre-aborted probes do not spawn", async () => {
  const controller = new AbortController();
  const probe = mockProbe();
  await probeVideoDimensions(media, { ...probe.options, signal: controller.signal, timeoutMs: 1234 });
  assert.equal(probe.calls[0][2].signal, controller.signal);
  assert.equal(probe.calls[0][2].timeout, 1234);
  const args = probe.calls[0][1];
  assert.equal(args[args.indexOf("-rw_timeout") + 1], "1234000");
  controller.abort();
  assert.equal(await probeVideoDimensions(media, { ...probe.options, signal: controller.signal }), null);
  assert.equal(probe.calls.length, 1);
});
