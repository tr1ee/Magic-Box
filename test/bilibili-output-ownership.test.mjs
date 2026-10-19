import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { downloadVideoFile } from "../server/index.mjs";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require("ffmpeg-static");
const ffprobe = require("ffprobe-static").path;
let temporary, server, baseUrl;
const fixtures = new Map();

before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-bilibili-output-ownership-"));
  for (const [filename, input, codec] of [
    ["video.mp4", "color=c=blue:s=160x90:r=10", ["-an", "-c:v", "libx264", "-pix_fmt", "yuv420p"]],
    ["audio.m4a", "sine=frequency=440:sample_rate=44100", ["-vn", "-c:a", "aac"]]
  ]) {
    const fixturePath = path.join(temporary, filename);
    await execFileAsync(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", input,
      "-t", "0.2", ...codec, fixturePath], { windowsHide: true, timeout: 10000 });
    fixtures.set(`/${filename}`, await fs.readFile(fixturePath));
  }
  server = http.createServer((request, response) => {
    const fixture = fixtures.get(request.url);
    if (!fixture) return response.writeHead(404).end("missing fixture");
    response.writeHead(200, { "Content-Length": fixture.length, "Content-Type": "video/mp4" }).end(fixture);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  if (temporary) await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function outputDirectory() {
  return fs.mkdtemp(path.join(temporary, "output-"));
}

function videoFor(kind, missing = false) {
  return {
    url: `${baseUrl}/${missing ? "missing" : kind === "audio" ? "audio.m4a" : "video.mp4"}`,
    filename: `ownership.${kind === "audio" ? "mp3" : "mp4"}`,
    extractor: kind === "audio" ? "bilibili-audio" : "bilibili-page",
    ...(kind === "dash" ? { audioUrl: `${baseUrl}/audio.m4a` } : {})
  };
}

for (const kind of ["audio", "dash"]) {
  test(`BiliBili ${kind} network failure preserves a destination created after name indexing`, async () => {
    const outputDir = await outputDirectory();
    const video = videoFor(kind, true);
    const finalPath = path.join(outputDir, `001-${video.filename}`);
    const sentinel = "preexisting user media must survive a failed network request";
    await fs.writeFile(finalPath, sentinel);
    await assert.rejects(downloadVideoFile(video, outputDir, 1, new Set()), { code: "HTTP_404" });
    assert.equal(await fs.readFile(finalPath, "utf8"), sentinel);
    assert.deepEqual(await fs.readdir(outputDir), [path.basename(finalPath)]);
  });

  test(`BiliBili ${kind} completes conversion but never overwrites or deletes a late output collision`, async () => {
    const outputDir = await outputDirectory();
    const video = videoFor(kind);
    const finalPath = path.join(outputDir, `001-${video.filename}`);
    const sentinel = "another download created this output while the streams were downloading";
    let collided = false;
    await assert.rejects(downloadVideoFile(video, outputDir, 1, new Set(), {
      onProgress(event) {
        if (!collided && event.progress === (kind === "audio" ? 0.9 : 0.96)) {
          writeFileSync(finalPath, sentinel);
          collided = true;
        }
      }
    }), { code: "EEXIST" });
    assert.equal(collided, true, "the network transfer must reach conversion before introducing the collision");
    assert.equal(await fs.readFile(finalPath, "utf8"), sentinel);
    assert.deepEqual(await fs.readdir(outputDir), [path.basename(finalPath)]);
  });

  test(`BiliBili ${kind} publishes a complete playable output after private conversion`, async () => {
    const outputDir = await outputDirectory();
    const video = videoFor(kind);
    const result = await downloadVideoFile(video, outputDir, 1, new Set());
    assert.equal(result.path, path.join(outputDir, `001-${video.filename}`));
    assert.equal(result.bytes, (await fs.stat(result.path)).size);
    assert.ok(result.bytes > 0);
    const { stdout } = await execFileAsync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", result.path],
      { windowsHide: true, timeout: 10000 });
    assert.deepEqual(JSON.parse(stdout).streams.map(stream => stream.codec_type).sort(), kind === "audio" ? ["audio"] : ["audio", "video"]);
    assert.deepEqual(await fs.readdir(outputDir), [path.basename(result.path)]);
  });
}
