import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import {
  applyTorrentFileSelection,
  buildBilibiliPageScannedVideoResults,
  buildDouyinShareScannedVideoResults,
  buildJavtifulPageScannedVideoResults,
  buildMissAvPageScannedVideoResults,
  buildYtDlpScannedVideoResults,
  compactHistory,
  filenameWithOutputExtension,
  isSeedSongAdvisoryCandidateUsable,
  isSeedSongRepairCandidateUsable,
  isSeedSongStrictlyAccepted,
  normalizeVoicePreparationArtifactPath,
  parseVideoPageInput,
  preserveProfilesMissingFromStaleVoiceDb,
  publicVoiceProfile,
  redactLogText,
  resolveLocalOpenTarget,
  runFfmpegVoiceCommand,
  selectFineCheckpointCandidate,
  selectSeedSongReferenceClips,
  shouldRenderVideoPageAfterFetchError,
  startServer,
  voicePreparationTimeoutForSource,
  voicePreparationWorkerTimeoutOptions,
  voiceCloneLineage
} from "../server/index.mjs";
import {
  inferVoiceLanguageFromText,
  parseEmotionSegments,
  resolveVoiceLanguage,
  sanitizeUnicodeText,
  splitVoiceSynthesisClauses
} from "../shared/voiceClone.mjs";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

let appContext;
let imageServer;
let imageBaseUrl;
let tempRoot;
let voiceIngressFixture;
let previousVoiceEngineFake;
let previousVoiceEngineFakeGpu;
const imageFixtures = new Map();
const requestCounts = new Map();

it("preserves a newly-created voice profile when a stale background snapshot commits later", () => {
  const staleDb = {
    profiles: [{ id: "existing-profile", name: "Existing" }],
    samples: []
  };
  const currentDb = {
    profiles: [
      { id: "new-profile", name: "New" },
      { id: "existing-profile", name: "Existing" }
    ],
    samples: [{ id: "new-sample", profileId: "new-profile" }]
  };

  const merged = preserveProfilesMissingFromStaleVoiceDb(staleDb, currentDb);
  assert.deepEqual(merged.profiles.map((profile) => profile.id), ["new-profile", "existing-profile"]);
  assert.deepEqual(merged.samples.map((sample) => sample.id), ["new-sample"]);

  const deleted = preserveProfilesMissingFromStaleVoiceDb(staleDb, currentDb, {
    deletedProfileIds: ["new-profile"]
  });
  assert.deepEqual(deleted.profiles.map((profile) => profile.id), ["existing-profile"]);
  assert.deepEqual(deleted.samples, []);
});

it("accepts Voice Preparation artifacts returned through a resolved directory junction", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magic-box-preparation-path-"));
  try {
    const realCandidateDir = path.join(root, "real", "candidate");
    const linkedCandidateDir = path.join(root, "linked-candidate");
    const artifactPath = path.join(realCandidateDir, "vocal.wav");
    const outsidePath = path.join(root, "outside.wav");
    await fs.mkdir(realCandidateDir, { recursive: true });
    await fs.writeFile(artifactPath, "vocal");
    await fs.writeFile(outsidePath, "outside");
    await fs.symlink(realCandidateDir, linkedCandidateDir, process.platform === "win32" ? "junction" : "dir");

    assert.equal(
      await normalizeVoicePreparationArtifactPath(linkedCandidateDir, artifactPath),
      path.join(linkedCandidateDir, "vocal.wav")
    );
    assert.equal(await normalizeVoicePreparationArtifactPath(linkedCandidateDir, outsidePath), "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function countRequest(pathname) {
  requestCounts.set(pathname, (requestCounts.get(pathname) || 0) + 1);
}

async function waitForImageJob(job) {
  const snapshots = [job];
  let current = job;
  for (let attempt = 0; attempt < 200 && !["complete", "failed", "cancelled"].includes(current.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = await getJson(`/api/images/download/${encodeURIComponent(job.id)}`);
    snapshots.push(current);
  }
  return { current, snapshots };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function postJson(pathname, body) {
  const response = await fetch(`${appContext.url}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function getJson(pathname) {
  const response = await fetch(`${appContext.url}${pathname}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function patchJson(pathname, body) {
  const response = await fetch(`${appContext.url}${pathname}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function postForm(pathname, body) {
  const response = await fetch(`${appContext.url}${pathname}`, {
    method: "POST",
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  if (/^\/api\/voice-clone\/profiles\/[^/]+\/samples$/u.test(pathname) && payload?.job?.type === "prepare-profile-source") {
    const preparationJobs = Array.isArray(payload.jobs) && payload.jobs.length ? payload.jobs : [payload.job];
    const preparedJobs = await Promise.all(preparationJobs.map((job) => waitForVoiceJob(job)));
    const failedJob = preparedJobs.find((job) => job.status !== "completed");
    if (failedJob) {
      throw new Error(failedJob.error || "Voice Preparation fixture job failed.");
    }
    const profiles = await getJson("/api/voice-clone/profiles");
    const profile = profiles.find((item) => item.id === payload.profile?.id);
    const uploadedIds = new Set((payload.samples || []).map((sample) => sample.id));
    return {
      ...payload,
      profile,
      samples: (profile?.samples || []).filter((sample) => uploadedIds.has(sample.id))
    };
  }
  return payload;
}

async function makeImage(format, color) {
  return sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: color
    }
  })[format]().toBuffer();
}

async function makeAnimatedWebp() {
  const frames = await Promise.all([
    makeImage("png", "#ff0000"),
    makeImage("png", "#0000ff")
  ]);
  return sharp(frames, { join: { animated: true } })
    .webp({ loop: 0, delay: [100, 120] })
    .toBuffer();
}

function makeWav(durationSeconds = 1.2) {
  const sampleRate = 16000;
  const frameCount = Math.floor(sampleRate * durationSeconds);
  const dataSize = frameCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < frameCount; index += 1) {
    const value = Math.round(Math.sin(2 * Math.PI * 440 * (index / sampleRate)) * 9000);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  return buffer;
}

function makeStereoSongWav(durationSeconds = 2.4) {
  const sampleRate = 16000;
  const channels = 2;
  const frameCount = Math.floor(sampleRate * durationSeconds);
  const bytesPerFrame = channels * 2;
  const dataSize = frameCount * bytesPerFrame;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerFrame, 28);
  buffer.writeUInt16LE(bytesPerFrame, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < frameCount; index += 1) {
    const time = index / sampleRate;
    const centeredVocal = Math.sin(2 * Math.PI * 440 * time) * 6500;
    const sideBgm = Math.sin(2 * Math.PI * 220 * time) * 3500;
    const left = Math.round(centeredVocal + sideBgm);
    const right = Math.round(centeredVocal - sideBgm);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, left)), 44 + index * bytesPerFrame);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, right)), 44 + index * bytesPerFrame + 2);
  }
  return buffer;
}

async function makeMp3(durationSeconds = 4) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const wavPath = path.join(tempRoot, `voice-source-${id}.wav`);
  const mp3Path = path.join(tempRoot, `voice-source-${id}.mp3`);
  await fs.writeFile(wavPath, makeWav(durationSeconds));
  await execFileAsync(ffmpegPath, [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", wavPath,
    "-ar", "16000",
    "-ac", "1",
    mp3Path
  ], { windowsHide: true, timeout: 20000 });
  return fs.readFile(mp3Path);
}

async function makeDashPair() {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const videoPath = path.join(tempRoot, `dash-video-${id}.mp4`);
  const audioPath = path.join(tempRoot, `dash-audio-${id}.m4a`);
  await execFileAsync(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=320x180:d=1",
    "-an", "-c:v", "mpeg4", "-f", "mp4", videoPath
  ], { windowsHide: true, timeout: 20000 });
  await execFileAsync(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-vn", "-c:a", "aac", "-f", "mp4", audioPath
  ], { windowsHide: true, timeout: 20000 });
  return {
    video: await fs.readFile(videoPath),
    audio: await fs.readFile(audioPath)
  };
}

async function commandAvailable(command, args = ["--version"]) {
  try {
    await execFileAsync(command, args, { windowsHide: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function runWorkerRequest(command, args, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.resolve(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (code !== 0 || !line) {
        reject(new Error(stderr.trim() || stdout.trim() || `Worker exited with code ${code}.`));
        return;
      }
      resolve({ line, payload: JSON.parse(line) });
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

async function waitForVoiceJob(job) {
  let current = job;
  for (let attempt = 0; attempt < 400 && !["completed", "needs-review", "rejected", "failed", "cancelled"].includes(current.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    current = await getJson(`/api/voice-clone/jobs/${encodeURIComponent(job.id)}`);
  }
  return current;
}

async function waitForFormatFactoryJob(job) {
  let current = job;
  for (let attempt = 0; attempt < 240 && !["completed", "failed", "cancelled"].includes(current.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 35));
    current = await getJson(`/api/format-factory/jobs/${encodeURIComponent(job.id)}`);
  }
  return current;
}

describe("Magic Box server image downloads", () => {
  before(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "magic-box-test-"));
    process.env.MAGIC_BOX_SETTINGS_FILE = path.join(tempRoot, "settings.json");
    previousVoiceEngineFake = process.env.MAGIC_BOX_VOICE_ENGINE_FAKE;
    previousVoiceEngineFakeGpu = process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_GPU;
    process.env.MAGIC_BOX_VOICE_ENGINE_FAKE = "1";
    process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_GPU = "1";
    const voiceRoot = path.join(tempRoot, "voice_clone");
    voiceIngressFixture = {
      voiceRoot,
      durableProfilePath: path.join(voiceRoot, "profiles", "durable-profile", "keep.txt"),
      orphanIngressPath: path.join(voiceRoot, "temp", "ingress", "orphan-request", "part.bin"),
      orphanJobPath: path.join(voiceRoot, "temp", "jobs", "orphan-job", "source.wav")
    };
    await fs.mkdir(path.dirname(voiceIngressFixture.durableProfilePath), { recursive: true });
    await fs.mkdir(path.dirname(voiceIngressFixture.orphanIngressPath), { recursive: true });
    await fs.mkdir(path.dirname(voiceIngressFixture.orphanJobPath), { recursive: true });
    await Promise.all([
      fs.writeFile(voiceIngressFixture.durableProfilePath, "do-not-delete", "utf8"),
      fs.writeFile(voiceIngressFixture.orphanIngressPath, "orphan", "utf8"),
      fs.writeFile(voiceIngressFixture.orphanJobPath, "orphan", "utf8")
    ]);

    imageFixtures.set("/sample.webp", {
      contentType: "image/webp",
      buffer: await makeImage("webp", "#ff0000")
    });
    imageFixtures.set("/animated.webp", {
      contentType: "image/webp",
      buffer: await makeAnimatedWebp()
    });
    imageFixtures.set("/sample.png", {
      contentType: "image/png",
      buffer: await makeImage("png", "#00ff00")
    });
    imageFixtures.set("/refreshed.png", {
      contentType: "image/png",
      buffer: await makeImage("png", "#ff00ff")
    });
    imageFixtures.set("/not-image", {
      contentType: "text/plain",
      buffer: Buffer.from("not an image")
    });
    imageFixtures.set("/duplicate-a.webp", imageFixtures.get("/sample.webp"));
    imageFixtures.set("/duplicate-b.webp", imageFixtures.get("/sample.webp"));
    imageFixtures.set("/conflict.png", {
      contentType: "image/png",
      buffer: await makeImage("png", "#0000ff")
    });
    imageFixtures.set("/movie.mp4", {
      contentType: "video/mp4",
      buffer: Buffer.from("fake mp4 video content")
    });
    imageFixtures.set("/movie-240p.mp4", {
      contentType: "video/mp4",
      buffer: Buffer.from("fake 240p video")
    });
    imageFixtures.set("/movie-720p.mp4", {
      contentType: "video/mp4",
      buffer: Buffer.from("fake 720p video with more bytes")
    });
    imageFixtures.set("/apac2/99016.mp4", {
      contentType: "video/mp4",
      buffer: Buffer.from("fake javtiful signed mp4 video content")
    });
    imageFixtures.set("/segment-1.ts", {
      contentType: "video/mp2t",
      buffer: Buffer.from("segment-one")
    });
    imageFixtures.set("/segment-2.ts", {
      contentType: "video/mp2t",
      buffer: Buffer.from("segment-two")
    });
    imageFixtures.set("/low-segment.ts", {
      contentType: "video/mp2t",
      buffer: Buffer.from("low-segment")
    });
    imageFixtures.set("/master.m3u8", {
      contentType: "application/vnd.apple.mpegurl",
      buffer: Buffer.from([
        "#EXTM3U",
        "#EXT-X-STREAM-INF:BANDWIDTH=250000,RESOLUTION=426x240",
        "/low.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720",
        "/high.m3u8",
        ""
      ].join("\n"))
    });
    imageFixtures.set("/low.m3u8", {
      contentType: "application/vnd.apple.mpegurl",
      buffer: Buffer.from([
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:4",
        "#EXTINF:4,",
        "/low-segment.ts",
        "#EXT-X-ENDLIST",
        ""
      ].join("\n"))
    });
    imageFixtures.set("/high.m3u8", {
      contentType: "application/vnd.apple.mpegurl",
      buffer: Buffer.from([
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:4",
        "#EXTINF:4,",
        "/segment-1.ts",
        "#EXTINF:4,",
        "/segment-2.ts",
        "#EXT-X-ENDLIST",
        ""
      ].join("\n"))
    });
    imageFixtures.set("/clip.webm", {
      contentType: "video/webm",
      buffer: Buffer.from("fake webm video content")
    });
    imageFixtures.set("/site.webmanifest", {
      contentType: "application/manifest+json",
      buffer: Buffer.from("{}")
    });
    imageFixtures.set("/player-shell", {
      contentType: "text/html; charset=utf-8",
      buffer: Buffer.from("<!doctype html><p>Player shell</p>")
    });
    imageFixtures.set("/video-page", {
      contentType: "text/html; charset=utf-8",
      buffer: Buffer.from(`
        <!doctype html>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="manifest" href="/site.webmanifest">
        <meta property="og:image" content="/sample.png">
        <meta property="og:video:image" content="/sample.png">
        <video src="/movie.mp4" poster="/sample.png"></video>
        <a href="/clip.webm" download="clip.webm">Clip</a>
        <div class="related-video" data-video="/video/related-suggestion">Related</div>
        <div class="advert" data-mp4="/ad-banner.mp4">Ad</div>
      `)
    });
    imageFixtures.set("/video-quality-page", {
      contentType: "text/html; charset=utf-8",
      buffer: Buffer.from(`
        <!doctype html>
        <meta property="og:image" content="/sample.png">
        <video poster="/sample.png">
          <source src="/movie-240p.mp4" type="video/mp4" label="240p">
          <source src="/movie-720p.mp4" type="video/mp4" label="720p">
        </video>
      `)
    });
    imageFixtures.set("/guarded-video-page", {
      contentType: "text/html; charset=utf-8",
      buffer: Buffer.from(`
        <!doctype html>
        <meta property="og:image" content="/sample.png">
        <video src="/movie.mp4" poster="/sample.png"></video>
      `)
    });
    imageFixtures.set("/challenge-video-page", {
      contentType: "text/html; charset=utf-8",
      buffer: Buffer.from(`
        <!doctype html>
        <title>Just a moment...</title>
        <main id="cf-challenge">Checking your browser before accessing this site.</main>
      `)
    });
    imageFixtures.set("/challenge-video-page-with-player", {
      contentType: "text/html; charset=utf-8",
      buffer: Buffer.from(`
        <!doctype html>
        <title>Just a moment...</title>
        <main id="cf-challenge">Checking your browser before accessing this site.</main>
        <iframe src="/iframe-player" title="Video player"></iframe>
      `)
    });
    imageFixtures.set("/iframe-video-page", {
      contentType: "text/html; charset=utf-8",
      buffer: Buffer.from(`
        <!doctype html>
        <meta property="og:image" content="/sample.png">
        <iframe src="/iframe-player" title="Video player"></iframe>
      `)
    });
    imageFixtures.set("/iframe-player", {
      contentType: "text/html; charset=utf-8",
      buffer: Buffer.from(`
        <!doctype html>
        <video src="/movie.mp4" poster="/sample.png"></video>
      `)
    });
    imageFixtures.set("/hls-video-page", {
      contentType: "text/html; charset=utf-8",
      buffer: Buffer.from(`
        <!doctype html>
        <meta property="og:image" content="/sample.png">
        <script>window.player = { sources: [{ file: "/master.m3u8", type: "hls" }] };</script>
      `)
    });
    imageFixtures.set("/video-player-page", {
      contentType: "text/html; charset=utf-8",
      buffer: Buffer.from(`
        <!doctype html>
        <meta property="og:image" content="/sample.png">
        <meta property="og:video:image" content="/sample.png">
        <meta property="og:video" content="/player-shell">
        <script>window.playerConfig = { file: "/movie.mp4?X-Amz-Algorithm=a\\u0026X-Amz-Signature=s" };</script>
        <a class="related-video" href="/clip.webm">Related clip</a>
      `)
    });
    imageFixtures.set("/javtiful-style-page", {
      contentType: "text/html; charset=utf-8",
      buffer: Buffer.from(`
        <!doctype html>
        <meta property="og:image" content="/sample.png">
        <meta property="og:video:image" content="/sample.png">
        <script>
          window.playerConfig = {
            file: "/apac2/99016.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256\\u0026X-Amz-Date=20260702T183930Z\\u0026X-Amz-Expires=3600\\u0026response-content-disposition=inline%3B%20filename%3D%22playback.svg%22\\u0026response-content-type=video%2Fmp4"
          };
        </script>
      `)
    });
    imageFixtures.set("/large-image-page", {
      contentType: "text/html; charset=utf-8",
      buffer: Buffer.from(Array.from(
        { length: 1005 },
        (_, index) => `<img src="/gallery/image-${index + 1}.jpg" alt="Page ${index + 1}">`
      ).join("\n"))
    });
    imageFixtures.set("/titled-gallery", {
      contentType: "text/html; charset=utf-8",
      buffer: Buffer.from('<!doctype html><html><head><title>Artist Album Vol. 1</title></head><body><img src="/sample.png"></body></html>')
    });

    imageServer = http.createServer((request, response) => {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      countRequest(pathname);
      if (pathname === "/expired.png" || pathname === "/unchanged-expired.png") {
        response.writeHead(403, { "Content-Type": "text/plain", Server: "fixture" }).end("Expired");
        return;
      }
      if (pathname === "/refresh-reader") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end('<!doctype html><img src="/refreshed.png" alt="refreshed">');
        return;
      }
      if (pathname === "/unchanged-reader") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end('<!doctype html><img src="/unchanged-expired.png" alt="same">');
        return;
      }
      if (pathname === "/slow-image.png") {
        response.writeHead(200, { "Content-Type": "image/png", "Content-Length": 1024 * 1024 });
        response.write(imageFixtures.get("/sample.png").buffer);
        const timer = setInterval(() => response.write("."), 100);
        response.on("close", () => clearInterval(timer));
        return;
      }
      if (pathname === "/guarded-video-page" && request.headers["sec-fetch-mode"] !== "navigate") {
        response.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden");
        return;
      }
      if (pathname === "/cloudflare-blocked-video-page") {
        response.writeHead(403, {
          "Content-Type": "text/html; charset=utf-8",
          Server: "cloudflare"
        }).end("<!doctype html><title>Blocked</title>");
        return;
      }
      if (pathname === "/slow-video.mp4") {
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": 1024 * 1024
        });
        response.write("partial video data");
        const timer = setInterval(() => {
          response.write(".");
        }, 1000);
        response.on("close", () => clearInterval(timer));
        return;
      }

      const fixture = imageFixtures.get(pathname);
      if (!fixture) {
        response.writeHead(404).end();
        return;
      }

      response.writeHead(200, {
        "Content-Type": fixture.contentType,
        "Content-Length": fixture.buffer.byteLength
      });
      response.end(fixture.buffer);
    });
    imageBaseUrl = await listen(imageServer);
    appContext = await startServer({
      port: 0,
      defaultDownloadDir: path.join(tempRoot, "downloads"),
      assistantDataDir: path.join(tempRoot, "assistant"),
      dht: false,
      lsd: false,
      tracker: false,
      voiceIngressLimits: {
        profile: { fileBytes: 4 * 1024 * 1024, requestBytes: 8 * 1024 * 1024 },
        tts: { fileBytes: 64 * 1024, requestBytes: 256 },
        v2v: { fileBytes: 4 * 1024 * 1024, requestBytes: 8 * 1024 * 1024 },
        song: { fileBytes: 4 * 1024 * 1024, requestBytes: 8 * 1024 * 1024 }
      }
    });
  });

  after(async () => {
    if (appContext) {
      await appContext.close();
    }
    if (imageServer) {
      await new Promise((resolve) => imageServer.close(resolve));
    }
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    if (previousVoiceEngineFake === undefined) {
      delete process.env.MAGIC_BOX_VOICE_ENGINE_FAKE;
    } else {
      process.env.MAGIC_BOX_VOICE_ENGINE_FAKE = previousVoiceEngineFake;
    }
    if (previousVoiceEngineFakeGpu === undefined) {
      delete process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_GPU;
    } else {
      process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_GPU = previousVoiceEngineFakeGpu;
    }
  });

  it("converts downloaded static WebP images to PNG filenames and content", async () => {
    const outputDir = path.join(tempRoot, "webp-output");
    const result = await postJson("/api/images/download", {
      pageUrl: imageBaseUrl,
      outputDir,
      concurrency: 1,
      images: [{ url: `${imageBaseUrl}/sample.webp`, filename: "sample.webp" }]
    });

    assert.equal(result.downloaded, 1);
    assert.equal(result.files[0].contentType, "image/png");
    assert.equal(result.files[0].convertedFrom, "image/webp");
    assert.match(result.files[0].filename, /\.png$/);
    const saved = await fs.readFile(path.join(outputDir, result.files[0].filename));
    assert.equal(saved.subarray(1, 4).toString("ascii"), "PNG");
  });

  it("creates a safe gallery folder from the scanned page title", async () => {
    const scan = await postJson("/api/images/scan", { pageUrl: `${imageBaseUrl}/titled-gallery` });
    assert.equal(scan.galleryName, "Artist Album Vol. 1");

    const galleryRoot = path.join(tempRoot, "gallery-root");
    const result = await postJson("/api/images/download", {
      pageUrl: scan.pageUrl,
      outputDir: galleryRoot,
      galleryName: scan.galleryName,
      concurrency: 1,
      images: scan.images
    });

    const expectedOutputDir = path.join(galleryRoot, "Artist Album Vol. 1");
    assert.equal(result.outputDir, expectedOutputDir);
    assert.equal(result.downloaded, 1);
    assert.ok((await fs.readdir(expectedOutputDir)).length > 0);
  });

  it("reports local Format Factory capabilities", async () => {
    const capabilities = await getJson("/api/format-factory/capabilities");
    assert.equal(capabilities.localOnly, true);
    assert.equal(capabilities.sharp.available, true);
    assert.equal(capabilities.ffmpeg.available, true);
    assert.equal(capabilities.pdf.available, true);
    assert.ok(capabilities.formats.picture.outputs.includes("webp"));
    assert.ok(capabilities.formats.video.outputs.includes("mp4"));
    assert.ok(capabilities.formats.audio.outputs.includes("mp3"));
    assert.ok(capabilities.formats.document.outputs.includes("pdf"));
  });

  it("converts picture and audio files through Format Factory jobs", async () => {
    const outputDir = path.join(tempRoot, "format-factory-media");
    const pictureForm = new FormData();
    pictureForm.append("category", "picture");
    pictureForm.append("outputDir", outputDir);
    pictureForm.append("quality", "high");
    pictureForm.append("targets", JSON.stringify(["webp"]));
    pictureForm.append("files", new Blob([await makeImage("png", "#de7048")], { type: "image/png" }), "sample.png");
    const picture = await waitForFormatFactoryJob(await postForm("/api/format-factory/jobs", pictureForm));
    assert.equal(picture.status, "completed", picture.error || picture.items[0]?.error);
    assert.equal(picture.progress, 100);
    assert.equal(picture.items[0].targetFormat, "webp");
    const pictureBytes = await fs.readFile(picture.outputs[0].path);
    assert.equal(pictureBytes.subarray(8, 12).toString("ascii"), "WEBP");

    const audioForm = new FormData();
    audioForm.append("category", "audio");
    audioForm.append("outputDir", outputDir);
    audioForm.append("quality", "balanced");
    audioForm.append("targets", JSON.stringify(["mp3"]));
    audioForm.append("files", new Blob([makeWav(0.35)], { type: "audio/wav" }), "tone.wav");
    const audio = await waitForFormatFactoryJob(await postForm("/api/format-factory/jobs", audioForm));
    assert.equal(audio.status, "completed", audio.error || audio.items[0]?.error);
    assert.equal(audio.items[0].targetFormat, "mp3");
    assert.equal((await fs.readFile(audio.outputs[0].path)).subarray(0, 3).toString("ascii"), "ID3");
  });

  it("merges PDFs and exports PDF pages as PNG through Format Factory", async () => {
    const sourcePdf = await PDFDocument.create();
    sourcePdf.addPage([240, 160]).drawText("Magic Box Format Factory", { x: 24, y: 86, size: 16 });
    const pdfBytes = await sourcePdf.save();
    const outputDir = path.join(tempRoot, "format-factory-documents");

    const mergeForm = new FormData();
    mergeForm.append("category", "document");
    mergeForm.append("outputDir", outputDir);
    mergeForm.append("mergePdf", "true");
    mergeForm.append("targets", JSON.stringify(["pdf", "pdf"]));
    mergeForm.append("files", new Blob([pdfBytes], { type: "application/pdf" }), "one.pdf");
    mergeForm.append("files", new Blob([pdfBytes], { type: "application/pdf" }), "two.pdf");
    const merged = await waitForFormatFactoryJob(await postForm("/api/format-factory/jobs", mergeForm));
    assert.equal(merged.status, "completed", merged.error || merged.items[0]?.error);
    const mergedPdf = await PDFDocument.load(await fs.readFile(merged.outputs[0].path));
    assert.equal(mergedPdf.getPageCount(), 2);

    const pageForm = new FormData();
    pageForm.append("category", "document");
    pageForm.append("outputDir", outputDir);
    pageForm.append("quality", "balanced");
    pageForm.append("targets", JSON.stringify(["png"]));
    pageForm.append("files", new Blob([pdfBytes], { type: "application/pdf" }), "render-me.pdf");
    const rendered = await waitForFormatFactoryJob(await postForm("/api/format-factory/jobs", pageForm));
    assert.equal(rendered.status, "completed", rendered.items[0]?.error || rendered.error);
    const pageBytes = await fs.readFile(rendered.outputs[0].path);
    assert.equal(pageBytes.subarray(1, 4).toString("ascii"), "PNG");
  });

  it("preserves animated WebP filenames, frames, and bytes", async () => {
    const outputDir = path.join(tempRoot, "animated-webp-output");
    const result = await postJson("/api/images/download", {
      pageUrl: imageBaseUrl,
      outputDir,
      concurrency: 1,
      images: [{ url: `${imageBaseUrl}/animated.webp`, filename: "animated.webp" }]
    });

    assert.equal(result.downloaded, 1);
    assert.equal(result.files[0].contentType, "image/webp");
    assert.equal(result.files[0].convertedFrom, null);
    assert.match(result.files[0].filename, /\.webp$/);
    const saved = await fs.readFile(path.join(outputDir, result.files[0].filename));
    assert.deepEqual(saved, imageFixtures.get("/animated.webp").buffer);
    assert.equal((await sharp(saved, { animated: true }).metadata()).pages, 2);
  });

  it("refreshes an expired image URL from its reader page in the same download", async () => {
    requestCounts.clear();
    const outputDir = path.join(tempRoot, "refreshed-output");
    const result = await postJson("/api/images/download", {
      pageUrl: `${imageBaseUrl}/refresh-reader`,
      outputDir,
      concurrency: 1,
      images: [{
        url: `${imageBaseUrl}/expired.png`,
        referer: `${imageBaseUrl}/refresh-reader`,
        sourcePage: `${imageBaseUrl}/refresh-reader`,
        pageNumber: 1,
        filename: "page-1.png"
      }]
    });

    assert.equal(result.downloaded, 1);
    assert.equal(result.files[0].sourceUrl, `${imageBaseUrl}/refreshed.png`);
    assert.equal(result.files[0].refreshAttempted, true);
    assert.equal(result.files[0].refreshSucceeded, true);
    assert.equal(requestCounts.get("/expired.png"), 1);
    assert.equal(requestCounts.get("/refresh-reader"), 1);
    assert.equal(requestCounts.get("/refreshed.png"), 1);
  });

  it("refreshes an unchanged forbidden URL once without looping", async () => {
    requestCounts.clear();
    const result = await postJson("/api/images/download", {
      pageUrl: `${imageBaseUrl}/unchanged-reader`,
      outputDir: path.join(tempRoot, "unchanged-output"),
      concurrency: 1,
      images: [{
        url: `${imageBaseUrl}/unchanged-expired.png`,
        referer: `${imageBaseUrl}/unchanged-reader`,
        pageNumber: 1
      }]
    });

    assert.equal(result.failed, 1);
    assert.equal(result.failures[0].refreshAttempted, true);
    assert.equal(result.failures[0].refreshSucceeded, false);
    assert.equal(requestCounts.get("/unchanged-expired.png"), 1);
    assert.equal(requestCounts.get("/unchanged-reader"), 1);
  });

  it("tracks background image progress and final per-item states", async () => {
    const initial = await postJson("/api/images/download", {
      pageUrl: imageBaseUrl,
      outputDir: path.join(tempRoot, "background-image-output"),
      concurrency: 2,
      background: true,
      images: [
        { url: `${imageBaseUrl}/sample.png`, filename: "green.png", listIndex: 1 },
        { url: `${imageBaseUrl}/conflict.png`, filename: "blue.png", listIndex: 2 }
      ]
    });
    const { current, snapshots } = await waitForImageJob(initial);
    assert.equal(current.status, "complete");
    assert.equal(current.downloaded, 2);
    assert.equal(current.percent, 100);
    assert.deepEqual(current.items.map((item) => item.status), ["complete", "complete"]);
    for (let index = 1; index < snapshots.length; index += 1) {
      assert.ok(snapshots[index].percent >= snapshots[index - 1].percent);
    }
  });

  it("cancels queued image work while preserving completed files", async () => {
    requestCounts.clear();
    const initial = await postJson("/api/images/download", {
      pageUrl: imageBaseUrl,
      outputDir: path.join(tempRoot, "cancel-image-output"),
      concurrency: 1,
      background: true,
      images: [
        { url: `${imageBaseUrl}/sample.png`, filename: "done.png", listIndex: 1 },
        { url: `${imageBaseUrl}/slow-image.png`, filename: "slow.png", listIndex: 2 },
        { url: `${imageBaseUrl}/refreshed.png`, filename: "never.png", listIndex: 3 }
      ]
    });
    let current = initial;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = await getJson(`/api/images/download/${encodeURIComponent(initial.id)}`);
      if (current.items[0].status === "complete" && current.items[1].status === "downloading") break;
    }
    const cancelled = await postJson(`/api/images/download/${encodeURIComponent(initial.id)}/cancel`, {});
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.items[0].status, "complete");
    assert.equal(cancelled.items[2].status, "cancelled");
    assert.equal(requestCounts.get("/refreshed.png") || 0, 0);
  });

  it("persists complete failure manifests beyond the compact history preview", async () => {
    const failures = Array.from({ length: 81 }, (_item, index) => ({
      url: `${imageBaseUrl}/not-image`,
      filename: `bad-${index + 1}.png`,
      listIndex: index + 1,
      crop: { x: index, y: 0, width: 1, height: 1 }
    }));
    const result = await postJson("/api/images/download", {
      pageUrl: imageBaseUrl,
      outputDir: path.join(tempRoot, "manifest-output"),
      concurrency: 2,
      images: failures
    });
    assert.equal(result.failed, 81);
    const history = await getJson("/api/history");
    const entry = history.find((item) => item.type === "image" && item.outputDir === result.outputDir);
    assert.ok(entry);
    assert.equal(entry.failures.length, 80);
    assert.equal(entry.failureCount, 81);
    const manifest = await getJson(`/api/history/${encodeURIComponent(entry.id)}/failures`);
    assert.equal(manifest.failures.length, 81);
  });

  it("preserves non-WebP raster downloads", async () => {
    const outputDir = path.join(tempRoot, "png-output");
    const result = await postJson("/api/images/download", {
      pageUrl: imageBaseUrl,
      outputDir,
      concurrency: 1,
      images: [{ url: `${imageBaseUrl}/sample.png`, filename: "sample.png" }]
    });

    assert.equal(result.downloaded, 1);
    assert.equal(result.files[0].contentType, "image/png");
    assert.equal(result.files[0].convertedFrom, null);
    assert.match(result.files[0].filename, /\.png$/);
  });

  it("caps image scans at 1000 results", async () => {
    const result = await postJson("/api/images/scan", {
      pageUrl: `${imageBaseUrl}/large-image-page`
    });

    assert.equal(result.count, 1000);
    assert.equal(result.images.length, 1000);
    assert.equal(result.images[0].url, `${imageBaseUrl}/gallery/image-1.jpg`);
    assert.equal(result.images.at(-1).url, `${imageBaseUrl}/gallery/image-1000.jpg`);
  });

  it("skips duplicate output content within a run", async () => {
    const outputDir = path.join(tempRoot, "duplicate-output");
    const result = await postJson("/api/images/download", {
      pageUrl: imageBaseUrl,
      outputDir,
      concurrency: 1,
      images: [
        { url: `${imageBaseUrl}/duplicate-a.webp`, filename: "first.webp" },
        { url: `${imageBaseUrl}/duplicate-b.webp`, filename: "second.webp" }
      ]
    });

    assert.equal(result.downloaded, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.skippedDuplicates[0].reason, "duplicate");
    assert.equal(result.files[0].sha256, result.skippedDuplicates[0].sha256);
  });

  it("renames filename conflicts when content differs", async () => {
    const outputDir = path.join(tempRoot, "conflict-output");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "001-conflict.png"), await makeImage("png", "#ffffff"));

    const result = await postJson("/api/images/download", {
      pageUrl: imageBaseUrl,
      outputDir,
      concurrency: 1,
      images: [{ url: `${imageBaseUrl}/conflict.png`, filename: "conflict.png" }]
    });

    assert.equal(result.downloaded, 1);
    assert.equal(result.files[0].filename, "001-conflict-2.png");
  });

  it("scans downloadable videos from page markup", async () => {
    const result = await postJson("/api/videos/scan", {
      pageUrl: `${imageBaseUrl}/video-page`
    });

    assert.equal(result.count, 1);
    assert.equal(result.videos[0].url, `${imageBaseUrl}/movie.mp4`);
    assert.equal(result.videos[0].poster, `${imageBaseUrl}/sample.png`);
    assert.equal(result.videos[0].kind, "main-video-source");
    assert.equal(result.videos[0].bytes, imageFixtures.get("/movie.mp4").buffer.byteLength);
    assert.equal(result.videos[0].contentType, "video/mp4");
    assert.equal(result.videos[0].displaySize, "22 B");
  });

  it("extracts a video URL from copied share text", async () => {
    const pageUrl = `${imageBaseUrl}/video-page`;
    const result = await postJson("/api/videos/scan", {
      pageUrl: `3.21 复制打开应用，看看这个视频 ${pageUrl} 复制此链接，打开应用搜索。`
    });

    assert.equal(result.pageUrl, pageUrl);
    assert.equal(result.count, 1);
    assert.equal(result.videos[0].url, `${imageBaseUrl}/movie.mp4`);
  });

  it("normalizes a BiliBili BV ID or video URL to its canonical page", () => {
    assert.equal(
      parseVideoPageInput("BV1RyN16qEmB").href,
      "https://www.bilibili.com/video/BV1RyN16qEmB/"
    );
    assert.equal(
      parseVideoPageInput("https://www.bilibili.com/video/BV1RyN16qEmB/XXXX?from=share").href,
      "https://www.bilibili.com/video/BV1RyN16qEmB/"
    );
  });

  it("keeps quality variants and defaults to the highest quality", async () => {
    const result = await postJson("/api/videos/scan", {
      pageUrl: `${imageBaseUrl}/video-quality-page`
    });

    assert.equal(result.count, 1);
    assert.equal(result.videos[0].url, `${imageBaseUrl}/movie-720p.mp4`);
    assert.equal(result.videos[0].qualityLabel, "720p");
    assert.equal(result.videos[0].selectedQualityUrl, `${imageBaseUrl}/movie-720p.mp4`);
    assert.deepEqual(
      result.videos[0].variants.map((variant) => variant.qualityLabel),
      ["720p", "240p"]
    );
    assert.deepEqual(
      result.videos[0].variants.map((variant) => variant.url),
      [`${imageBaseUrl}/movie-720p.mp4`, `${imageBaseUrl}/movie-240p.mp4`]
    );
  });

  it("builds yt-dlp formats as selectable quality variants", () => {
    const result = buildYtDlpScannedVideoResults({
      title: "Extractor Sample",
      webpage_url: "https://example.com/watch/123",
      extractor_key: "Example",
      thumbnail: "https://cdn.example.com/poster.jpg",
      http_headers: {
        "User-Agent": "sample-agent",
        Referer: "https://example.com/watch/123",
        Cookie: "secret"
      },
      formats: [
        {
          format_id: "v1080",
          url: "https://media.example.com/video-1080.mp4",
          ext: "mp4",
          height: 1080,
          width: 1920,
          fps: 30,
          tbr: 4500,
          vcodec: "avc1",
          acodec: "none",
          filesize: 40_000
        },
        {
          format_id: "p720",
          url: "https://media.example.com/video-720.mp4",
          ext: "mp4",
          height: 720,
          width: 1280,
          fps: 30,
          tbr: 2500,
          vcodec: "avc1",
          acodec: "mp4a",
          filesize: 30_000
        },
        {
          format_id: "a128",
          url: "https://media.example.com/audio.m4a",
          ext: "m4a",
          vcodec: "none",
          acodec: "mp4a",
          filesize: 5_000
        }
      ]
    }, "https://example.com/watch/123", {
      cookiesFromBrowser: "edge",
      impersonate: "chrome"
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].extractor, "yt-dlp");
    assert.equal(result[0].formatId, "v1080");
    assert.equal(result[0].qualityLabel, "1080p mp4 + audio");
    assert.equal(result[0].formatSelector, "v1080+bestaudio");
    assert.equal(result[0].httpHeaders.Cookie, undefined);
    assert.deepEqual(
      result[0].variants.map((variant) => variant.formatId),
      ["v1080", "p720"]
    );
    assert.equal(result[0].variants[0].requiresAudioMerge, true);
    assert.equal(result[0].variants[0].cookiesFromBrowser, "edge");
    assert.equal(result[0].variants[0].impersonate, "chrome");
  });

  it("pairs BiliBili embedded DASH streams with audio", () => {
    const html = `
      <!doctype html>
      <title>Sample BiliBili Video_哔哩哔哩_bilibili</title>
      <script>window.__INITIAL_STATE__={"videoData":{"title":"Sample BiliBili Video","pic":"//i0.hdslb.com/poster.jpg"}};</script>
      <script>window.__playinfo__={
        "code":0,
        "data":{
          "timelength":120000,
          "accept_quality":[80,32],
          "accept_description":["HD 1080P","Clear 480P"],
          "dash":{
            "duration":120,
            "video":[
              {
                "id":80,
                "baseUrl":"https://upos.example.com/video-1080.m4s",
                "height":1080,
                "width":1920,
                "bandwidth":2400000,
                "codecs":"avc1"
              },
              {
                "id":32,
                "baseUrl":"https://upos.example.com/video-480.m4s",
                "height":480,
                "width":852,
                "bandwidth":800000,
                "codecs":"avc1"
              }
            ],
            "audio":[
              {
                "id":30280,
                "baseUrl":"https://upos.example.com/audio.m4s",
                "bandwidth":128000,
                "codecs":"mp4a"
              }
            ]
          }
        }
      };</script>
    `;
    const result = buildBilibiliPageScannedVideoResults(html, "https://www.bilibili.com/video/BV123");

    assert.equal(result.length, 1);
    assert.equal(result[0].extractor, "bilibili-page");
    assert.equal(result[0].formatId, "bilibili-80-1");
    assert.equal(result[0].hasAudio, false);
    assert.equal(result[0].requiresAudioMerge, true);
    assert.equal(result[0].audioUrl, "https://upos.example.com/audio.m4s");
    assert.equal(result[0].httpHeaders.Referer, "https://www.bilibili.com/video/BV123");
    assert.deepEqual(
      result[0].variants.map((variant) => variant.qualityLabel),
      ["HD 1080P mp4 DASH + audio", "Clear 480P mp4 DASH + audio", "MP3 audio"]
    );
    assert.equal(result[0].variants[2].extractor, "bilibili-audio");
    assert.equal(result[0].variants[2].filename, "Sample BiliBili Video.mp3");
  });

  it("builds Douyin share payload qualities without browser cookies", () => {
    const routerData = {
      loaderData: {
        videoInfoRes: {
          item_list: [{
            aweme_id: "6961737553342991651",
            desc: "Douyin sample",
            video: {
              width: 1080,
              height: 1920,
              duration: 19000,
              cover: { url_list: [`${imageBaseUrl}/sample.png`] },
              play_addr: { url_list: [`${imageBaseUrl}/movie.mp4`] },
              bit_rate: [{
                gear_name: "normal_720",
                bit_rate: 1500000,
                play_addr: {
                  width: 720,
                  height: 1280,
                  data_size: 32000,
                  url_list: [
                    `${imageBaseUrl}/movie-720p.mp4`,
                    `${imageBaseUrl}/movie-720p.mp4?mirror=2`
                  ]
                }
              }, {
                gear_name: "normal_240",
                bit_rate: 300000,
                play_addr: {
                  width: 240,
                  height: 426,
                  data_size: 8000,
                  url_list: [`${imageBaseUrl}/movie-240p.mp4`]
                }
              }]
            }
          }]
        }
      }
    };
    const html = `<!doctype html><script>window._ROUTER_DATA = ${JSON.stringify(routerData)}</script>`;
    const result = buildDouyinShareScannedVideoResults(html, `${imageBaseUrl}/share/video/6961737553342991651/`);

    assert.equal(result.length, 1);
    assert.equal(result[0].extractor, "douyin-share");
    assert.equal(result[0].qualityLabel, "720p");
    assert.deepEqual(result[0].variants.map((variant) => variant.qualityLabel), ["720p", "240p"]);
    assert.deepEqual(result[0].fallbackUrls, [`${imageBaseUrl}/movie-720p.mp4?mirror=2`]);
  });

  it("decodes MissAV packed HLS sources as one quality group", async () => {
    const html = `
      <!doctype html>
      <title>MissAV Sample</title>
      <script>
        eval(function(p,a,c,k,e,d){return p}('0=\\'/1\\';2=\\'/3\\';4=\\'/5\\';',36,6,'source|master.m3u8|source720|high.m3u8?quality=720|source240|low.m3u8?quality=240'.split('|'),0,{}))
      </script>
    `;
    const result = await buildMissAvPageScannedVideoResults(html, `${imageBaseUrl}/missav-sample`);

    assert.equal(result.length, 1);
    assert.equal(result[0].extractor, "missav-page");
    assert.equal(result[0].impersonate, "chrome");
    assert.equal(result[0].url, `${imageBaseUrl}/high.m3u8`);
    assert.deepEqual(result[0].variants.map((variant) => variant.qualityLabel), ["720p", "240p"]);
  });

  it("prefers Javtiful's rendered main player over preview clips", async () => {
    const html = `
      <!doctype html>
      <title>Javtiful Sample</title>
      <script>window.preview = "${imageBaseUrl}/previews/trailer_preview.mp4";</script>
      <video class="player" src="${imageBaseUrl}/movie-720p.mp4"></video>
    `;
    const result = await buildJavtifulPageScannedVideoResults(html, `${imageBaseUrl}/video/javtiful-sample`);

    assert.equal(result.length, 1);
    assert.equal(result[0].extractor, "javtiful-page");
    assert.equal(result[0].url, `${imageBaseUrl}/movie-720p.mp4`);
    assert.doesNotMatch(result[0].url, /preview/i);
  });

  it("scans Javtiful-style signed script videos instead of poster images", async () => {
    const result = await postJson("/api/videos/scan", {
      pageUrl: `${imageBaseUrl}/javtiful-style-page`
    });

    assert.equal(result.count, 1);
    assert.equal(result.videos[0].url, `${imageBaseUrl}/apac2/99016.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260702T183930Z&X-Amz-Expires=3600&response-content-disposition=inline%3B%20filename%3D%22playback.svg%22&response-content-type=video%2Fmp4`);
    assert.equal(result.videos[0].selectedQualityUrl, result.videos[0].url);
    assert.equal(result.videos[0].qualityLabel, "Source 1");
    assert.equal(result.videos[0].qualityHeight, null);
    assert.equal(result.videos[0].contentType, "video/mp4");
    assert.equal(result.videos[0].kind, "script-video");
    assert.notEqual(result.videos[0].url, `${imageBaseUrl}/sample.png`);
  });

  it("scans guarded pages with browser navigation headers", async () => {
    const result = await postJson("/api/videos/scan", {
      pageUrl: `${imageBaseUrl}/guarded-video-page`
    });

    assert.equal(result.count, 1);
    assert.equal(result.videos[0].url, `${imageBaseUrl}/movie.mp4`);
  });

  it("fails blocked video scans with a friendly access message", async () => {
    const response = await fetch(`${appContext.url}/api/videos/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageUrl: `${imageBaseUrl}/cloudflare-blocked-video-page` })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Site blocked automated access (HTTP 403).");
  });

  it("fails challenge HTML video scans before rendering fallback", async () => {
    const response = await fetch(`${appContext.url}/api/videos/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageUrl: `${imageBaseUrl}/challenge-video-page` })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Site blocked automated access (HTTP 403).");
  });

  it("does not expand player-looking URLs from challenge pages", async () => {
    const response = await fetch(`${appContext.url}/api/videos/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageUrl: `${imageBaseUrl}/challenge-video-page-with-player` })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Site blocked automated access (HTTP 403).");
  });

  it("scans videos inside embedded player iframes", async () => {
    const result = await postJson("/api/videos/scan", {
      pageUrl: `${imageBaseUrl}/iframe-video-page`
    });

    assert.equal(result.count, 1);
    assert.equal(result.videos[0].url, `${imageBaseUrl}/movie.mp4`);
    assert.equal(result.videos[0].sourcePage, `${imageBaseUrl}/iframe-player`);
  });

  it("scans HLS playlists as quality variants", async () => {
    const result = await postJson("/api/videos/scan", {
      pageUrl: `${imageBaseUrl}/hls-video-page`
    });

    assert.equal(result.count, 1);
    assert.equal(result.videos[0].url, `${imageBaseUrl}/high.m3u8`);
    assert.equal(result.videos[0].protocol, "hls");
    assert.equal(result.videos[0].qualityLabel, "720p");
    assert.deepEqual(
      result.videos[0].variants.map((variant) => variant.qualityLabel),
      ["720p", "240p"]
    );
  });

  it("falls back from an HTML player candidate to the playable video source", async () => {
    const result = await postJson("/api/videos/scan", {
      pageUrl: `${imageBaseUrl}/video-player-page`
    });

    assert.equal(result.count, 1);
    assert.equal(result.videos[0].url, `${imageBaseUrl}/movie.mp4?X-Amz-Algorithm=a&X-Amz-Signature=s`);
    assert.equal(result.videos[0].contentType, "video/mp4");
  });

  it("proxies selected video previews", async () => {
    const params = new URLSearchParams({
      url: `${imageBaseUrl}/movie.mp4`,
      referer: `${imageBaseUrl}/video-page`
    });
    const response = await fetch(`${appContext.url}/api/videos/preview?${params.toString()}`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(await response.text(), "fake mp4 video content");
  });

  it("proxies video poster images for the desktop result table", async () => {
    const params = new URLSearchParams({
      url: `${imageBaseUrl}/sample.png`,
      referer: `${imageBaseUrl}/video-page`
    });
    const response = await fetch(`${appContext.url}/api/images/preview?${params.toString()}`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), imageFixtures.get("/sample.png").buffer);
  });

  it("downloads selected videos to disk", async () => {
    const outputDir = path.join(tempRoot, "video-output");
    const result = await postJson("/api/videos/download", {
      pageUrl: imageBaseUrl,
      outputDir,
      concurrency: 1,
      videos: [{ url: `${imageBaseUrl}/movie.mp4`, filename: "movie.mp4" }]
    });

    assert.equal(result.downloaded, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.files[0].contentType, "video/mp4");
    assert.match(result.files[0].filename, /\.mp4$/);
    const saved = await fs.readFile(path.join(outputDir, result.files[0].filename));
    assert.equal(saved.toString("utf8"), "fake mp4 video content");
  });

  it("downloads and muxes BiliBili DASH video with its audio stream", async () => {
    const dash = await makeDashPair();
    imageFixtures.set("/bilibili-video.m4s", {
      contentType: "video/mp4",
      buffer: dash.video
    });
    imageFixtures.set("/bilibili-audio.m4s", {
      contentType: "audio/mp4",
      buffer: dash.audio
    });
    const outputDir = path.join(tempRoot, "bilibili-output");
    const result = await postJson("/api/videos/download", {
      pageUrl: imageBaseUrl,
      outputDir,
      concurrency: 1,
      videos: [{
        url: `${imageBaseUrl}/bilibili-video.m4s`,
        audioUrl: `${imageBaseUrl}/bilibili-audio.m4s`,
        filename: "bilibili-complete.mp4",
        extractor: "bilibili-page",
        requiresAudioMerge: true,
        contentType: "video/mp4",
        audioContentType: "audio/mp4"
      }]
    });

    assert.equal(result.downloaded, 1);
    assert.equal(result.failed, 0);
    const outputPath = path.join(outputDir, result.files[0].filename);
    const { stdout } = await execFileAsync(ffprobePath, [
      "-v", "error",
      "-show_entries", "stream=codec_type",
      "-of", "json",
      outputPath
    ], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.deepEqual(
      JSON.parse(stdout).streams.map((stream) => stream.codec_type).sort(),
      ["audio", "video"]
    );
  });

  it("downloads a BiliBili audio choice as MP3", async () => {
    const dash = await makeDashPair();
    imageFixtures.set("/bilibili-mp3-source.m4s", {
      contentType: "audio/mp4",
      buffer: dash.audio
    });
    const outputDir = path.join(tempRoot, "bilibili-mp3-output");
    const result = await postJson("/api/videos/download", {
      pageUrl: imageBaseUrl,
      outputDir,
      concurrency: 1,
      videos: [{
        url: `${imageBaseUrl}/bilibili-mp3-source.m4s`,
        filename: "bilibili-audio.mp3",
        extractor: "bilibili-audio",
        contentType: "audio/mpeg"
      }]
    });

    assert.equal(result.downloaded, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.files[0].contentType, "audio/mpeg");
    assert.match(result.files[0].filename, /bilibili-audio\.mp3$/);
    const outputPath = path.join(outputDir, result.files[0].filename);
    const { stdout } = await execFileAsync(ffprobePath, [
      "-v", "error",
      "-show_entries", "stream=codec_name,codec_type",
      "-of", "json",
      outputPath
    ], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    const streams = JSON.parse(stdout).streams;
    assert.equal(streams.length, 1);
    assert.equal(streams[0].codec_type, "audio");
    assert.equal(streams[0].codec_name, "mp3");
  });

  it("downloads simple unencrypted HLS playlists to disk", async () => {
    const outputDir = path.join(tempRoot, "hls-output");
    const result = await postJson("/api/videos/download", {
      pageUrl: imageBaseUrl,
      outputDir,
      concurrency: 1,
      videos: [{
        url: `${imageBaseUrl}/high.m3u8`,
        filename: "hls-master.m3u8",
        protocol: "hls",
        contentType: "application/vnd.apple.mpegurl"
      }]
    });

    assert.equal(result.downloaded, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.files[0].contentType, "video/mp2t");
    assert.match(result.files[0].filename, /\.ts$/);
    const saved = await fs.readFile(path.join(outputDir, result.files[0].filename));
    assert.equal(saved.toString("utf8"), "segment-onesegment-two");
  });

  it("tracks background video download progress", async () => {
    const outputDir = path.join(tempRoot, "video-job-output");
    const job = await postJson("/api/videos/download", {
      pageUrl: imageBaseUrl,
      outputDir,
      concurrency: 1,
      background: true,
      videos: [{
        url: `${imageBaseUrl}/movie.mp4`,
        filename: "movie.mp4",
        bytes: imageFixtures.get("/movie.mp4").buffer.byteLength
      }]
    });

    assert.equal(job.requested, 1);
    assert.ok(["queued", "downloading", "complete"].includes(job.status));
    assert.ok(job.id);

    let current = job;
    for (let attempt = 0; attempt < 20 && current.status !== "complete" && current.status !== "failed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      current = await getJson(`/api/videos/download/${encodeURIComponent(job.id)}`);
    }

    assert.equal(current.status, "complete");
    assert.equal(current.percent, 100);
    assert.equal(current.result.downloaded, 1);
    assert.equal(current.bytesTotal, imageFixtures.get("/movie.mp4").buffer.byteLength);
    assert.equal(current.bytesDownloaded, imageFixtures.get("/movie.mp4").buffer.byteLength);
  });

  it("cancels an active background video download", async () => {
    const outputDir = path.join(tempRoot, "video-job-cancel-output");
    const job = await postJson("/api/videos/download", {
      pageUrl: imageBaseUrl,
      outputDir,
      concurrency: 1,
      background: true,
      videos: [{
        url: `${imageBaseUrl}/slow-video.mp4`,
        filename: "slow-video.mp4"
      }]
    });

    assert.ok(job.id);
    const cancelled = await postJson(`/api/videos/download/${encodeURIComponent(job.id)}/cancel`, {});

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.error, "Video download cancelled.");

    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = await getJson(`/api/videos/download/${encodeURIComponent(job.id)}`);
    assert.equal(current.status, "cancelled");
  });

  it("persists a separate output folder for every file-producing tool", async () => {
    const toolPaths = {
      torrents: path.join(tempRoot, "tool-paths", "torrents"),
      images: path.join(tempRoot, "tool-paths", "images"),
      videos: path.join(tempRoot, "tool-paths", "videos"),
      "voice-clone": path.join(tempRoot, "tool-paths", "voice-clone"),
      "file-transfer": path.join(tempRoot, "tool-paths", "file-transfer"),
      "format-factory": path.join(tempRoot, "tool-paths", "format-factory")
    };

    const saved = await postJson("/api/settings", { toolPaths });
    assert.deepEqual(saved.toolPaths, toolPaths);

    const config = await getJson("/api/config");
    assert.deepEqual(config.savedToolPaths, toolPaths);
    assert.equal(new Set(Object.values(config.savedToolPaths)).size, 6);
  });

  it("pairs and transfers files between Windows and an Apple browser room", async () => {
    const created = await postJson("/api/file-transfer/sessions", {
      mode: "lan",
      downloadPath: path.join(tempRoot, "transfer-output")
    });
    const room = created.session;
    assert.equal(room.status, "active");
    assert.match(room.pairingCode, /^\d{6}$/);
    assert.match(room.qrDataUrl, /^data:image\/png;base64,/);
    assert.ok(room.loopbackUrl);

    const mobilePageResponse = await fetch(room.loopbackUrl);
    assert.equal(mobilePageResponse.status, 200);
    assert.match(await mobilePageResponse.text(), /Move files both ways/);

    const roomUrl = new URL(room.loopbackUrl);
    const token = roomUrl.pathname.split("/").pop();
    const wrongPairResponse = await fetch(`${roomUrl.origin}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        code: room.pairingCode === "999999" ? "000000" : "999999",
        deviceName: "Test iPhone"
      })
    });
    assert.equal(wrongPairResponse.status, 403);

    const pairResponse = await fetch(`${roomUrl.origin}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, code: room.pairingCode, deviceName: "Test iPhone" })
    });
    assert.equal(pairResponse.status, 200);
    const paired = await pairResponse.json();
    assert.ok(paired.auth);
    assert.equal(paired.device.name, "Test iPhone");

    const windowsFiles = new FormData();
    windowsFiles.append("files", new Blob(["from Windows"]), "windows-note.txt");
    const shared = await postForm("/api/file-transfer/sessions/current/files", windowsFiles);
    assert.equal(shared.session.sharedFiles.length, 1);

    const remoteFiles = new FormData();
    remoteFiles.append("files", new Blob(["from iPhone"]), "iphone-note.txt");
    const remoteUploadResponse = await fetch(`${roomUrl.origin}/api/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${paired.auth}`,
        "X-Transfer-Token": token
      },
      body: remoteFiles
    });
    assert.equal(remoteUploadResponse.status, 201);
    const remoteUpload = await remoteUploadResponse.json();
    assert.equal(remoteUpload.session.receivedFiles[0].sourceDevice, "Test iPhone");
    assert.equal(remoteUpload.session.receivedFiles[0].path, undefined);

    const sharedFile = shared.session.sharedFiles[0];
    const downloadResponse = await fetch(
      `${roomUrl.origin}/api/files/${encodeURIComponent(sharedFile.id)}/download?token=${encodeURIComponent(token)}&auth=${encodeURIComponent(paired.auth)}`
    );
    assert.equal(downloadResponse.status, 200);
    assert.equal(await downloadResponse.text(), "from Windows");

    const current = await getJson("/api/file-transfer/sessions/current");
    assert.equal(current.session.connectedDevices.length, 1);
    assert.equal(current.session.receivedFiles.length, 1);
    assert.equal(current.session.receivedFiles[0].path, path.join(current.session.receiveDir, "iphone-note.txt"));
    assert.equal(await fs.readFile(path.join(current.session.receiveDir, "iphone-note.txt"), "utf8"), "from iPhone");

    const receivedId = current.session.receivedFiles[0].id;
    const previewResponse = await fetch(
      `${appContext.url}/api/file-transfer/sessions/current/received/${encodeURIComponent(receivedId)}/preview`
    );
    assert.equal(previewResponse.status, 200);
    assert.match(previewResponse.headers.get("content-disposition"), /^inline;/);
    assert.equal(await previewResponse.text(), "from iPhone");

    const copyResponse = await fetch(
      `${appContext.url}/api/file-transfer/sessions/current/received/${encodeURIComponent(receivedId)}/download`
    );
    assert.equal(copyResponse.status, 200);
    assert.match(copyResponse.headers.get("content-disposition"), /^attachment;/);
    assert.equal(await copyResponse.text(), "from iPhone");

    const stopResponse = await fetch(`${appContext.url}/api/file-transfer/sessions/current`, { method: "DELETE" });
    assert.equal(stopResponse.status, 204);
  });

  it("parses Voice Clone emotion tags with aliases and warnings", () => {
    const parsed = parseEmotionSegments("(平静的) 今天出发。(unknown) hello (嬉しい) 最高。");

    assert.deepEqual(parsed.segments.map((segment) => segment.style), ["calm", "neutral", "happy"]);
    assert.equal(parsed.segments[0].text, "今天出发。");
    assert.equal(parsed.warnings.length, 1);
  });

  it("keeps Voice Clone synthesis clauses sentence-safe without isolating short phrases", () => {
    assert.deepEqual(
      splitVoiceSynthesisClauses("Hi! This is the first full sentence. This is the second full sentence."),
      ["Hi! This is the first full sentence.", "This is the second full sentence."]
    );
    assert.deepEqual(
      splitVoiceSynthesisClauses("你好。 这是第一句完整的话。 这是第二句完整的话。"),
      ["你好。这是第一句完整的话。", "这是第二句完整的话。"]
    );
    assert.deepEqual(
      splitVoiceSynthesisClauses("我复活啦！啦啦啦啦啦，我测你的吗！"),
      ["我复活啦！", "啦啦啦啦啦，", "我测你的吗！"]
    );
  });

  it("redacts signed URLs and standalone credentials before launcher-visible diagnostics", () => {
    const canary = "MAGIC_BOX_LOG_SECRET_CANARY";
    const redacted = redactLogText(`preview https://user:pass@example.test/video.mp4?X-Amz-Signature=${canary}&token=${canary} Authorization: Bearer ${canary} cookie=${canary}`);

    assert.doesNotMatch(redacted, new RegExp(canary));
    assert.doesNotMatch(redacted, /user:pass@/);
    assert.match(redacted, /https:\/\/example\.test\/video\.mp4\[redacted\]/);
    assert.match(redacted, /Authorization: \[redacted\]/);
    assert.match(redacted, /cookie=\[redacted\]/);
  });

  it("keeps the overridden IP implementation compatible with UDP tracker parsing", async () => {
    const trackerLib = path.join(process.cwd(), "node_modules", "bittorrent-tracker", "lib");
    const trackerRequire = createRequire(path.join(trackerLib, "server", "parse-udp.js"));
    const ip = trackerRequire("ip");
    const packageInfo = trackerRequire("ip/package.json");
    assert.equal(packageInfo.name, "@eggjs/ip");
    assert.equal(ip.toString(Buffer.from([127, 0, 0, 1])), "127.0.0.1");

    const common = await import(pathToFileURL(path.join(trackerLib, "common.js")).href);
    const parseUdp = (await import(pathToFileURL(path.join(trackerLib, "server", "parse-udp.js")).href)).default;
    const message = Buffer.alloc(98);
    Buffer.from(common.CONNECTION_ID).copy(message, 0);
    message.writeUInt32BE(common.ACTIONS.ANNOUNCE, 8);
    message.writeUInt32BE(42, 12);
    message.writeUInt32BE(0, 80);
    message.writeUInt32BE(0, 84);
    message.writeUInt32BE(7, 88);
    message.writeUInt32BE(2, 92);
    message.writeUInt16BE(6881, 96);
    const parsed = parseUdp(message, { address: "127.0.0.1", port: 51234 });
    assert.equal(parsed.addr, "127.0.0.1:6881");
    assert.equal(parsed.transactionId, 42);
  });

  it("resolves Voice Clone generation language from script text before profile fallback", () => {
    assert.equal(resolveVoiceLanguage({
      requestedLanguage: "auto",
      profileLanguage: "zh",
      text: "Hello from this profile."
    }), "en");
    assert.equal(resolveVoiceLanguage({
      requestedLanguage: "auto",
      profileLanguage: "en",
      text: "今天出发。"
    }), "zh");
    assert.equal(resolveVoiceLanguage({
      requestedLanguage: "auto",
      profileLanguage: "zh",
      text: ""
    }), "zh");
    assert.equal(resolveVoiceLanguage({
      requestedLanguage: "auto",
      profileLanguage: "auto",
      text: "今天出发。"
    }), "zh");
    assert.equal(inferVoiceLanguageFromText("こんにちは"), "ja");
    assert.equal(resolveVoiceLanguage({
      requestedLanguage: "en",
      profileLanguage: "zh",
      text: "今天出发。"
    }), "en");
  });

  it("gives long CPU preparation enough post-separation budget", () => {
    const fiveMinuteCpuBudget = voicePreparationTimeoutForSource(5 * 60, "cpu");
    const fiveMinuteCudaBudget = voicePreparationTimeoutForSource(5 * 60, "cuda");
    const cpuWorkerTimeouts = voicePreparationWorkerTimeoutOptions(5 * 60, "cpu");

    assert.ok(fiveMinuteCpuBudget >= 120 * 60 * 1000, fiveMinuteCpuBudget);
    assert.ok(fiveMinuteCudaBudget >= 30 * 60 * 1000, fiveMinuteCudaBudget);
    assert.ok(fiveMinuteCpuBudget > fiveMinuteCudaBudget, { fiveMinuteCpuBudget, fiveMinuteCudaBudget });
    assert.equal(cpuWorkerTimeouts.timeoutMs, fiveMinuteCpuBudget);
    assert.equal(cpuWorkerTimeouts.idleTimeoutMs, 20 * 60 * 1000);
  });

  it("reports local neural engine state for Voice Clone", async () => {
    const health = await getJson("/api/voice-clone/health");

    assert.equal(health.ffmpegAvailable, true);
    assert.equal(health.ffprobeAvailable, true);
    assert.equal(health.activeEngine, "gpt-sovits-local");
    assert.equal(health.installed, true);
    assert.equal(health.runtimeReady, true);
    assert.equal(health.workerReady, true);
    assert.equal(health.gpuAvailable, true);
    assert.equal(health.engines.openVoiceV2Local.available, true);
    assert.equal(health.engines.gptSoVitsLocal.available, true);
    assert.equal(health.engines.seedVcSingingLocal.available, true);
    assert.equal(health.engines.seedVcSingingLocal.conversionReady, true);
    assert.equal(health.engines.seedVcSingingLocal.separationReady, true);
    assert.equal(health.engines.voicePreparationLocal.available, true);
    assert.equal(health.engines.voicePreparationLocal.separationReady, true);
    assert.equal(health.engines.voicePreparationLocal.asrReady, true);
    assert.equal(health.engines.voicePreparationLocal.gpuAvailable, true);
    assert.equal(health.engines.voicePreparationLocal.device, "cuda");
    assert.match(health.ffmpegSource, /^(bundled|env|package|path)$/);
    assert.match(health.ffprobeSource, /^(bundled|env|package|path)$/);
  });

  it("runs the fake neural model setup job in test mode", async () => {
    const installJob = await postJson("/api/voice-clone/models/install", { engine: "openvoice-v2-local" });
    const installed = await waitForVoiceJob(installJob);

    assert.equal(installed.status, "completed");
    assert.equal(installed.type, "model_install");
    assert.equal(installed.result.installState.engine, "openvoice-v2-local");
    assert.equal(installed.result.installState.installed, true);
    assert.equal(installed.result.installState.runtimeReady, true);

    const seedInstallJob = await postJson("/api/voice-clone/models/install", { engine: "seed-vc-svc-local" });
    const seedInstalled = await waitForVoiceJob(seedInstallJob);
    assert.equal(seedInstalled.status, "completed");
    assert.equal(seedInstalled.result.installState.engine, "seed-vc-svc-local");
    assert.equal(seedInstalled.result.installState.modelVersion, "seed-vc-svc-v1");

    const preparationInstallJob = await postJson("/api/voice-clone/models/install", { engine: "voice-preparation-local" });
    const preparationInstalled = await waitForVoiceJob(preparationInstallJob);
    assert.equal(preparationInstalled.status, "completed");
    assert.equal(preparationInstalled.result.installState.engine, "voice-preparation-local");
  });

  it("requires consent before creating a voice profile", async () => {
    await assert.rejects(
      postJson("/api/voice-clone/profiles", {
        name: "No consent",
        language: "en",
        consentConfirmed: false
      }),
      /permission to clone/
    );
  });

  it("preserves Chinese as the selected Voice Clone profile language", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Chinese Voice",
      language: "zh",
      consentConfirmed: true
    });

    assert.equal(profile.language, "zh");
    const profiles = await getJson("/api/voice-clone/profiles");
    assert.equal(profiles.find((item) => item.id === profile.id)?.language, "zh");

    const dbPath = path.join(tempRoot, "voice_clone", "voice_clone.json");
    await fs.appendFile(dbPath, "}", "utf8");
    const recoveredProfiles = await getJson("/api/voice-clone/profiles");
    assert.equal(recoveredProfiles.find((item) => item.id === profile.id)?.name, "Chinese Voice");
    const repairedDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(repairedDb.profiles.find((item) => item.id === profile.id)?.language, "zh");

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("sanitizes invalid surrogate text before storing voice clone transcripts", async () => {
    assert.equal(sanitizeUnicodeText("hello\udcac"), "hello\ufffd");
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Surrogate Chinese Voice",
      language: "zh",
      consentConfirmed: true
    });

    const form = new FormData();
    form.append("metadataJson", JSON.stringify([{ transcript: "你好\udcac测试", transcriptLanguage: "zh" }]));
    form.append("files", new Blob([makeWav(8.5)], { type: "audio/wav" }), "sample.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    assert.equal(upload.samples[0].transcript.includes("\udcac"), false);
    assert.equal(upload.samples[0].segments[0].transcript.includes("\udcac"), false);
    assert.match(upload.samples[0].segments[0].transcript, /\ufffd/);

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("keeps GPT-SoVITS worker JSON valid when prompt text contains invalid surrogates", async () => {
    const python = process.env.PYTHON || "python";
    if (!await commandAvailable(python)) {
      return;
    }
    const workerPath = path.join(path.resolve(), "server", "voice_engine_worker_gpt_sovits.py");
    const modelDir = await fs.mkdtemp(path.join(tempRoot, "gpt-worker-surrogate-"));
    const referenceAudioPath = path.join(modelDir, "reference.wav");
    const modelPath = path.join(modelDir, "profile.json");
    await fs.writeFile(referenceAudioPath, makeWav(3.5));

    const { line, payload } = await runWorkerRequest(python, [workerPath], {
      id: "worker-surrogate-test",
      action: "build-profile",
      modelDir,
      referenceAudioPath,
      promptText: "你好\udcac，测试。",
      promptLanguage: "zh",
      language: "zh",
      modelPath
    });

    assert.equal(payload.ok, true);
    assert.equal(payload.result.profileModel.promptText.includes("\udcac"), false);
    assert.match(payload.result.profileModel.promptText, /你好/);
    assert.match(payload.result.profileModel.promptText, /测试/);
    assert.match(payload.result.profileModel.promptText, /\ufffd/);
    assert.equal(line.includes("\\udcac"), false);
  });

  it("guards every GPT-SoVITS Chinese sentence start without breaking short comma clauses apart", async () => {
    const python = process.env.PYTHON || "python";
    if (!await commandAvailable(python)) {
      return;
    }
    const workerPath = path.join(path.resolve(), "server", "voice_engine_worker_gpt_sovits.py");
    const text = "\u54d2\u54d2\u54d2\u54d2\u54d2\uff0c\u597d\u60f3\u73a9\u539f\u795e\uff01\u554a\u554a\u554a\u554a\u554a\uff0c\u770b\u7cbe\u5f69\u7eb7\u5448\uff01";
    const { payload } = await runWorkerRequest(python, [workerPath], {
      id: "worker-clause-split-test",
      action: "segment-tts-text",
      modelDir: tempRoot,
      text,
      textLang: "zh"
    });

    assert.equal(payload.ok, true);
    assert.deepEqual(payload.result.sentences, [
      "\u54d2\u54d2\u54d2\u54d2\u54d2\uff0c\u597d\u60f3\u73a9\u539f\u795e\uff01",
      "\u554a\u554a\u554a\u554a\u554a\uff0c\u770b\u7cbe\u5f69\u7eb7\u5448\uff01"
    ]);
    assert.equal(payload.result.preparedSentences.length, 2);
    assert.equal(payload.result.preparedSentences.every((sentence) => sentence.startsWith("\uff0c")), true);
  });

  it("balances the final GPT-SoVITS recovery split without recreating an oversized tail", async () => {
    const python = process.env.PYTHON || "python";
    if (!await commandAvailable(python)) {
      return;
    }
    const workerPath = path.join(path.resolve(), "server", "voice_engine_worker_gpt_sovits.py");
    for (const unitCount of [...Array.from({ length: 7 }, (_, index) => 18 + index), ...Array.from({ length: 7 }, (_, index) => 35 + index)]) {
      const text = `${"语".repeat(unitCount)}。`;
      const { payload } = await runWorkerRequest(python, [workerPath], {
        id: `worker-balanced-split-${unitCount}`,
        action: "segment-tts-text",
        modelDir: tempRoot,
        text,
        textLang: "zh",
        settings: { integrityAttempt: 3 }
      });

      assert.equal(payload.ok, true);
      assert.equal(payload.result.sentences.join(""), text);
      assert.equal(payload.result.sentences.every((sentence) => (sentence.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]/g) || []).length <= 18), true);
    }
  });

  it("pairs short GPT-SoVITS Chinese exclamations so they do not synthesize as isolated fragments", async () => {
    const python = process.env.PYTHON || "python";
    if (!await commandAvailable(python)) {
      return;
    }
    const workerPath = path.join(path.resolve(), "server", "voice_engine_worker_gpt_sovits.py");
    const { payload } = await runWorkerRequest(python, [workerPath], {
      id: "worker-short-exclamation-test",
      action: "segment-tts-text",
      modelDir: tempRoot,
      text: "领域展开！ 无量空处！ 没关系的，因为你们很弱啊！",
      textLang: "zh"
    });

    assert.equal(payload.ok, true);
    assert.deepEqual(payload.result.sentences, [
      "领域展开！无量空处！",
      "没关系的，因为你们很弱啊！"
    ]);
    assert.equal(payload.result.preparedSentences.every((sentence) => sentence.startsWith("，")), true);
  });

  it("keeps an explicitly cancelled style pitch at zero", async () => {
    const python = process.env.PYTHON || "python";
    if (!await commandAvailable(python)) {
      return;
    }
    const workerPath = path.join(path.resolve(), "server", "voice_engine_worker_gpt_sovits.py");
    const probe = [
      "import importlib.util, json, sys",
      "spec = importlib.util.spec_from_file_location('worker', sys.argv[1])",
      "worker = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(worker)",
      "styled = worker.styled_tts_settings({'pitch': 0.5, 'styleStrength': 5.0 / 6.0}, 'sad')",
      "print(json.dumps({'styledPitch': styled['pitchSemitones'], 'appliedPitch': worker.resolved_pitch_semitones(styled)}))"
    ].join("\n");
    const { stdout } = await execFileAsync(python, ["-c", probe, workerPath], {
      windowsHide: true,
      timeout: 5000
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { styledPitch: 0, appliedPitch: 0 });
  });

  it("falls back safely when the GPT-SoVITS English NLTK tagger data is unavailable", async () => {
    const python = process.env.PYTHON || "python";
    if (!await commandAvailable(python)) {
      return;
    }
    const workerPath = path.join(path.resolve(), "server", "voice_engine_worker_gpt_sovits.py");
    const probe = [
      "import importlib.util, json, sys, types",
      "spec = importlib.util.spec_from_file_location('worker', sys.argv[1])",
      "worker = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(worker)",
      "def missing(*args, **kwargs): raise LookupError('missing averaged_perceptron_tagger_eng')",
      "fake = types.SimpleNamespace(pos_tag=missing)",
      "installed = worker.install_nltk_pos_tag_fallback(fake)",
      "print(json.dumps({'installed': installed, 'tags': fake.pos_tag(['read', 'complex']), 'used': worker._nltk_pos_fallback_used}))"
    ].join("\n");
    const { stdout } = await execFileAsync(python, ["-c", probe, workerPath], {
      windowsHide: true,
      timeout: 5000
    });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.installed, true);
    assert.deepEqual(result.tags, [["read", "NN"], ["complex", "NN"]]);
    assert.equal(result.used, true);
  });

  it("prepares uploaded GPT-SoVITS sources as reviewable sentence clips without raw training fallback", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Segmented Chinese Voice",
      language: "zh",
      consentConfirmed: true
    });

    const form = new FormData();
    form.append("files", new Blob([makeWav(18)], { type: "audio/wav" }), "long-sample.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const sample = upload.samples[0];
    assert.ok(sample.segments.length >= 2);
    assert.equal(sample.preparation.status, "ready");
    assert.equal(sample.segments.every((item) => item.qualityVerdict === "eligible" && Number(item.durationSeconds) <= 10), true);
    assert.equal(sample.segments.every((item) => item.audioPath !== sample.storedPath), true);
    assert.equal(sample.gptSoVitsPromptReady, true);

    const segment = sample.segments[0];
    const updated = await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: "你好，我是第一句参考音频。", transcriptLanguage: "zh" })
    }).then((response) => response.json());
    assert.equal(updated.segment.gptSoVitsPromptReady, true);

    const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "gpt-sovits-local",
      qualityMode: "fine"
    });
    const built = await waitForVoiceJob(buildJob);
    assert.equal(built.status, "completed");
    assert.equal(built.result.profile.voiceModel.primarySegmentId, segment.id);
    assert.equal(built.result.profile.voiceModel.promptText, "你好，我是第一句参考音频。");

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("unlocks a boundary and transcript-confidence review clip after its transcript is saved by a human", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Human Reviewed Boundary Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("files", new Blob([makeWav(4)], { type: "audio/wav" }), "boundary-review.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const sample = upload.samples[0];
    const segment = sample.segments[0];
    const dbPath = path.join(tempRoot, "voice_clone", "voice_clone.json");
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const persistedSample = db.samples.find((item) => item.id === sample.id);
    const persistedSegment = persistedSample.segments.find((item) => item.id === segment.id);
    persistedSample.preparation.status = "needs-attention";
    Object.assign(persistedSegment, {
      transcriptConfidence: 0.62,
      boundary: "uncertain",
      boundaryConfidence: 0.62,
      qualityVerdict: "needs-review",
      exclusionReasons: ["transcript_confidence_low", "uncertain_sentence_start", "uncertain_sentence_boundary"],
      includeInTraining: false,
      preferredPrompt: false
    });
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");

    const beforeReviewProfile = (await getJson("/api/voice-clone/profiles"))
      .find((item) => item.id === profile.id);
    const beforeReviewSample = beforeReviewProfile.samples.find((item) => item.id === sample.id);
    const beforeReview = beforeReviewSample.segments.find((item) => item.id === segment.id);
    assert.equal(beforeReviewProfile.preparedSourceCount, 1);
    assert.equal(beforeReviewSample.preparation.status, "ready");
    assert.equal(beforeReview.qualityVerdict, "needs-review");
    assert.equal(beforeReview.includedInFineTraining, false);
    assert.equal(beforeReview.gptSoVitsPromptReady, false);

    const reviewed = await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`,
      { transcript: "I listened to and verified this complete sentence.", transcriptLanguage: "en" }
    );
    assert.equal(reviewed.segment.qualityVerdict, "eligible");
    assert.equal(reviewed.segment.boundary, "complete");
    assert.equal(reviewed.segment.transcriptConfidence, 1);
    assert.ok(reviewed.segment.manualTranscriptReviewedAt);
    assert.deepEqual(reviewed.segment.exclusionReasons, []);
    assert.equal(reviewed.segment.includedInFineTraining, true);
    assert.equal(reviewed.segment.gptSoVitsPromptReady, true);

    const reference = await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`,
      { preferredPrompt: true }
    );
    assert.equal(reference.segment.preferredPrompt, true);
    assert.equal(reference.segment.includedInFineTraining, true);

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("rejects direct reference selection unless a prepared clip meets the GPT-SoVITS prompt rule", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Prompt Contract Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("files", new Blob([makeWav(4)], { type: "audio/wav" }), "prompt-contract.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const sample = upload.samples[0];
    const segment = sample.segments[0];
    const dbPath = path.join(tempRoot, "voice_clone", "voice_clone.json");
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const persistedSegment = db.samples
      .find((item) => item.id === sample.id)
      .segments.find((item) => item.id === segment.id);
    Object.assign(persistedSegment, {
      durationSeconds: 2.75,
      endSeconds: 2.75,
      qualityVerdict: "eligible",
      boundary: "complete",
      boundaryConfidence: 1,
      exclusionReasons: [],
      includeInTraining: true,
      preferredPrompt: false
    });
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");

    const tooShortResponse = await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferredPrompt: true })
    });
    assert.equal(tooShortResponse.status, 400);
    assert.match((await tooShortResponse.json()).error, /3-10 second|matching transcript/i);

    persistedSegment.durationSeconds = 4;
    persistedSegment.endSeconds = 4;
    persistedSegment.transcriptLanguage = "zh";
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
    const languageMismatchResponse = await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferredPrompt: true })
    });
    assert.equal(languageMismatchResponse.status, 400);
    const refreshed = (await getJson("/api/voice-clone/profiles"))
      .find((item) => item.id === profile.id)
      .samples.find((item) => item.id === sample.id)
      .segments.find((item) => item.id === segment.id);
    assert.equal(refreshed.preferredPrompt, false);

    persistedSegment.transcriptLanguage = "en";
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
    const selected = await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`,
      { preferredPrompt: true }
    );
    assert.equal(selected.segment.preferredPrompt, true);
    assert.equal(selected.segment.includedInFineTraining, true);
    const invalidMutation = await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcriptLanguage: "zh" })
    });
    assert.equal(invalidMutation.status, 400);
    assert.match((await invalidMutation.json()).error, /selected GPT-SoVITS prompt|matching transcript/i);
    const preservedReference = (await getJson("/api/voice-clone/profiles"))
      .find((item) => item.id === profile.id)
      .samples.find((item) => item.id === sample.id)
      .segments.find((item) => item.id === segment.id);
    assert.equal(preservedReference.preferredPrompt, true);
    assert.equal(preservedReference.includedInFineTraining, true);
    assert.equal(preservedReference.transcriptLanguage, "en");

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("allows a human-reviewed clip to override soft ASR speech confidence", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Human Speech Review Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("files", new Blob([makeWav(4)], { type: "audio/wav" }), "hard-gate-review.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const sample = upload.samples[0];
    const segment = sample.segments[0];
    const dbPath = path.join(tempRoot, "voice_clone", "voice_clone.json");
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const persistedSegment = db.samples
      .find((item) => item.id === sample.id)
      .segments.find((item) => item.id === segment.id);
    Object.assign(persistedSegment, {
      speechConfidence: 0.42,
      boundary: "uncertain",
      boundaryConfidence: 0.62,
      qualityVerdict: "needs-review",
      exclusionReasons: ["speech_confidence_low", "uncertain_sentence_start", "uncertain_sentence_boundary"],
      includeInTraining: false,
      preferredPrompt: false
    });
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");

    const reviewed = await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`,
      { transcript: "This transcript is human reviewed, but the audio itself is weak.", transcriptLanguage: "en" }
    );
    assert.equal(reviewed.segment.qualityVerdict, "eligible");
    assert.equal(reviewed.segment.boundary, "complete");
    assert.equal(reviewed.segment.exclusionReasons.includes("speech_confidence_low"), false);
    assert.equal(reviewed.segment.exclusionReasons.some((reason) => reason.startsWith("uncertain_sentence")), false);
    assert.equal(reviewed.segment.includedInFineTraining, true);
    assert.equal(reviewed.segment.gptSoVitsPromptReady, true);

    const exclusion = await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`,
      { includeInTraining: false }
    );
    assert.equal(exclusion.segment.includedInFineTraining, false);
    const referenceResponse = await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferredPrompt: true })
    });
    assert.equal(referenceResponse.status, 200);

    const cleared = await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`,
      { transcript: "", transcriptLanguage: "en" }
    );
    assert.equal(cleared.segment.qualityVerdict, "needs-review");
    assert.equal(cleared.segment.exclusionReasons.includes("no_speech_detected"), false);

    const restored = await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`,
      { transcript: "This transcript is human reviewed, but the audio itself is weak.", transcriptLanguage: "en" }
    );
    assert.equal(restored.segment.qualityVerdict, "eligible");
    assert.deepEqual(restored.segment.exclusionReasons, []);

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("normalizes and persists an already-reviewed low-confidence clip without another transcript save", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Existing Human Speech Review Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("files", new Blob([makeWav(4)], { type: "audio/wav" }), "existing-review.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const sample = upload.samples[0];
    const segment = sample.segments[0];
    const dbPath = path.join(tempRoot, "voice_clone", "voice_clone.json");
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const persistedSegment = db.samples
      .find((item) => item.id === sample.id)
      .segments.find((item) => item.id === segment.id);
    const reviewedAt = "2026-07-21T12:32:36.220Z";
    Object.assign(persistedSegment, {
      speechConfidence: 0.646,
      transcriptConfidence: 1,
      boundary: "complete",
      boundaryConfidence: 1,
      qualityVerdict: "needs-review",
      exclusionReasons: ["speech_confidence_low"],
      includeInTraining: false,
      manualTranscriptReviewedAt: reviewedAt
    });
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");

    const profiles = await getJson("/api/voice-clone/profiles");
    const migrated = profiles
      .find((item) => item.id === profile.id)
      .samples.find((item) => item.id === sample.id)
      .segments.find((item) => item.id === segment.id);
    assert.equal(migrated.qualityVerdict, "eligible");
    assert.deepEqual(migrated.exclusionReasons, []);
    assert.equal(migrated.includedInFineTraining, false);
    assert.equal(migrated.manualTranscriptReviewedAt, reviewedAt);

    const inclusion = await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`,
      { includeInTraining: true }
    );
    assert.equal(inclusion.segment.includedInFineTraining, true);
    assert.equal(inclusion.segment.manualTranscriptReviewedAt, reviewedAt);

    const persistedAfterInclusion = JSON.parse(await fs.readFile(dbPath, "utf8"))
      .samples.find((item) => item.id === sample.id)
      .segments.find((item) => item.id === segment.id);
    assert.equal(persistedAfterInclusion.qualityVerdict, "eligible");
    assert.deepEqual(persistedAfterInclusion.exclusionReasons, []);
    assert.equal(persistedAfterInclusion.includeInTraining, true);
    assert.equal(persistedAfterInclusion.manualTranscriptReviewedAt, reviewedAt);

    const afterReload = (await getJson("/api/voice-clone/profiles"))
      .find((item) => item.id === profile.id)
      .samples.find((item) => item.id === sample.id)
      .segments.find((item) => item.id === segment.id);
    assert.equal(afterReload.includedInFineTraining, true);
    assert.equal(afterReload.manualTranscriptReviewedAt, reviewedAt);

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("keeps a prepared clip over ten seconds excluded after a transcript save until it is re-sliced", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Long Clip Reslice Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("files", new Blob([makeWav(12)], { type: "audio/wav" }), "long-review.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const sample = upload.samples[0];
    const segment = sample.segments[0];
    const dbPath = path.join(tempRoot, "voice_clone", "voice_clone.json");
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const persistedSegment = db.samples
      .find((item) => item.id === sample.id)
      .segments.find((item) => item.id === segment.id);
    Object.assign(persistedSegment, {
      durationSeconds: 12,
      endSeconds: 12,
      boundary: "uncertain",
      boundaryConfidence: 0.62,
      qualityVerdict: "needs-review",
      exclusionReasons: ["sentence_too_long", "uncertain_sentence_start", "uncertain_sentence_boundary"],
      includeInTraining: false,
      preferredPrompt: false
    });
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");

    const reviewed = await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`,
      { transcript: "I reviewed this long automatic segment.", transcriptLanguage: "en" }
    );
    assert.equal(reviewed.segment.qualityVerdict, "needs-review");
    assert.equal(reviewed.segment.boundary, "complete");
    assert.equal(reviewed.segment.exclusionReasons.includes("sentence_too_long"), true);
    assert.equal(reviewed.segment.exclusionReasons.some((reason) => reason.startsWith("uncertain_sentence")), false);
    assert.equal(reviewed.segment.includedInFineTraining, false);
    assert.equal(reviewed.segment.gptSoVitsPromptReady, false);

    const inclusion = await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`,
      { includeInTraining: true }
    );
    assert.equal(inclusion.segment.includedInFineTraining, false);

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("keeps source transcripts and raw upload content out of preparation job snapshots", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Preparation Privacy Voice",
      language: "en",
      consentConfirmed: true
    });
    const transcriptCanary = "VOICE_TRANSCRIPT_PRIVATE_CANARY";
    const rawAudioCanary = "VOICE_RAW_AUDIO_PRIVATE_CANARY";
    const form = new FormData();
    form.append("metadataJson", JSON.stringify([{ transcript: transcriptCanary, transcriptLanguage: "en" }]));
    form.append("files", new Blob([makeWav(4), Buffer.from(rawAudioCanary)], { type: "audio/wav" }), "private-fixture.wav");
    const response = await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, {
      method: "POST",
      body: form
    });
    assert.equal(response.status, 202);
    const upload = await response.json();
    const completed = await waitForVoiceJob(upload.job);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.sampleId, upload.samples[0].id);
    assert.equal(completed.result?.preparationStatus, "ready");
    const snapshot = JSON.stringify(completed);
    assert.doesNotMatch(snapshot, new RegExp(transcriptCanary));
    assert.doesNotMatch(snapshot, new RegExp(rawAudioCanary));

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("allocates distinct Voice Preparation revisions for concurrent reprocess requests", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Concurrent Preparation Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("metadataJson", JSON.stringify([{ transcript: "A clear source sentence for concurrent preparation.", transcriptLanguage: "en" }]));
    form.append("files", new Blob([makeWav(4)], { type: "audio/wav" }), "sample.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const sampleId = upload.samples[0].id;

    const [first, second] = await Promise.all([
      postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sampleId)}/reprocess`, {}),
      postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sampleId)}/reprocess`, {})
    ]);
    assert.notEqual(first.job.preparationRevision, second.job.preparationRevision);
    const latest = first.job.preparationRevision > second.job.preparationRevision ? first : second;
    const latestJob = await waitForVoiceJob(latest.job);
    assert.equal(latestJob.status, "completed");
    const profiles = await getJson("/api/voice-clone/profiles");
    const refreshed = profiles.find((item) => item.id === profile.id);
    const refreshedSample = refreshed.samples.find((sample) => sample.id === sampleId);
    assert.equal(refreshedSample.preparation.revision, latest.job.preparationRevision);
    assert.equal(refreshedSample.preparation.status, "ready");

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("re-slices a source from its existing separated vocal without running BGM separation again", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Reusable Vocal Reslice Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("files", new Blob([makeWav(12)], { type: "audio/wav" }), "reusable-vocal.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const sample = upload.samples[0];
    const originalVocalPath = sample.preparation.vocalPath;
    const originalAccompanimentPath = sample.preparation.accompanimentPath;
    await fs.writeFile(originalVocalPath, "reused-vocal-fixture", "utf8");
    await fs.writeFile(originalAccompanimentPath, "reused-accompaniment-fixture", "utf8");

    const reslice = await postJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/reprocess`,
      { reusePreparedVocal: true }
    );
    const completed = await waitForVoiceJob(reslice.job);
    assert.equal(completed.status, "completed");
    const refreshed = (await getJson("/api/voice-clone/profiles"))
      .find((item) => item.id === profile.id)
      .samples.find((item) => item.id === sample.id);
    assert.equal(await fs.readFile(refreshed.preparation.vocalPath, "utf8"), "reused-vocal-fixture");
    assert.equal(await fs.readFile(refreshed.preparation.accompanimentPath, "utf8"), "reused-accompaniment-fixture");
    assert.equal(refreshed.preparation.runtime.reusedPreparedVocal, true);

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("holds queued preparation when an existing clip is edited", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Queued Edit Protection Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("metadataJson", JSON.stringify([{ transcript: "A prepared sentence remains editable after a queued reprocess.", transcriptLanguage: "en" }]));
    form.append("files", new Blob([makeWav(4)], { type: "audio/wav" }), "queued-edit.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const sample = upload.samples[0];
    const segment = sample.segments[0];
    const previousDelay = process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_PREPARATION_DELAY_MS;
    process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_PREPARATION_DELAY_MS = "900";
    try {
      const reprocess = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/reprocess`, {});
      const editedTranscript = "Manual clip edit remains the source of truth.";
      const patched = await patchJson(
        `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`,
        { transcript: editedTranscript, transcriptLanguage: "en" }
      );
      assert.equal(patched.sample.preparation.status, "needs-attention");
      assert.ok(patched.sample.preparation.revision > reprocess.job.preparationRevision);

      const completed = await waitForVoiceJob(reprocess.job);
      assert.equal(completed.status, "completed");
      assert.equal(completed.result?.stale, true);
      const profiles = await getJson("/api/voice-clone/profiles");
      const refreshed = profiles.find((item) => item.id === profile.id);
      const refreshedSample = refreshed.samples.find((item) => item.id === sample.id);
      assert.equal(refreshedSample.preparation.status, "needs-attention");
      assert.equal(refreshedSample.segments.find((item) => item.id === segment.id).transcript, editedTranscript);
    } finally {
      if (previousDelay === undefined) {
        delete process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_PREPARATION_DELAY_MS;
      } else {
        process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_PREPARATION_DELAY_MS = previousDelay;
      }
    }
    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("does not activate a model build whose prepared source changed while it ran", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Revision Safe Build Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("metadataJson", JSON.stringify([{ transcript: "A clean sentence for revision-safe model building.", transcriptLanguage: "en" }]));
    form.append("files", new Blob([makeWav(4)], { type: "audio/wav" }), "sample.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const sampleId = upload.samples[0].id;
    const initialBuildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "openvoice-v2-local",
      qualityMode: "quick"
    });
    const initialBuild = await waitForVoiceJob(initialBuildJob);
    assert.equal(initialBuild.status, "completed");
    const activeReferencePath = initialBuild.result.profile.voiceModel.referenceAudioPath;
    const activeReferenceBytes = await fs.readFile(activeReferencePath);
    const previousBuildDelay = process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_BUILD_DELAY_MS;
    process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_BUILD_DELAY_MS = "1200";
    try {
      const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
        engine: "openvoice-v2-local",
        qualityMode: "quick"
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const reprocess = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sampleId)}/reprocess`, {});
      const built = await waitForVoiceJob(buildJob);
      assert.equal(built.status, "failed");
      assert.match(built.error, /sources changed while this model was building/i);
      const reprocessed = await waitForVoiceJob(reprocess.job);
      assert.equal(reprocessed.status, "completed");
      const profiles = await getJson("/api/voice-clone/profiles");
      const refreshed = profiles.find((item) => item.id === profile.id);
      assert.equal(refreshed.voiceModel?.engine, "openvoice-v2-local");
      assert.equal(refreshed.voiceModel.referenceAudioPath, activeReferencePath);
      assert.deepEqual(await fs.readFile(activeReferencePath), activeReferenceBytes);
      assert.equal(refreshed.samples.find((sample) => sample.id === sampleId).preparation.status, "ready");
    } finally {
      if (previousBuildDelay === undefined) {
        delete process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_BUILD_DELAY_MS;
      } else {
        process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_BUILD_DELAY_MS = previousBuildDelay;
      }
    }
    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("cancels preparation, builds, and TTS without committing stale state or output", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Cancellation Boundary Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("metadataJson", JSON.stringify([{ transcript: "A prepared source for cancellation boundary checks.", transcriptLanguage: "en" }]));
    form.append("files", new Blob([makeWav(4)], { type: "audio/wav" }), "cancellation.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const sampleId = upload.samples[0].id;
    const initialBuild = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "openvoice-v2-local",
      qualityMode: "quick"
    });
    const initialBuilt = await waitForVoiceJob(initialBuild);
    assert.equal(initialBuilt.status, "completed");
    const activeModelVersionId = initialBuilt.result.profile.activeModelVersionId;

    const previousBuildDelay = process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_BUILD_DELAY_MS;
    process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_BUILD_DELAY_MS = "1500";
    try {
      const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
        engine: "openvoice-v2-local",
        qualityMode: "quick"
      });
      await new Promise((resolve) => setTimeout(resolve, 450));
      const cancelledBuild = await postJson(`/api/voice-clone/jobs/${encodeURIComponent(buildJob.id)}/cancel`, {});
      assert.equal(cancelledBuild.status, "cancelled");
      await new Promise((resolve) => setTimeout(resolve, 250));
      const afterBuildCancel = (await getJson("/api/voice-clone/profiles")).find((item) => item.id === profile.id);
      assert.equal(afterBuildCancel.activeModelVersionId, activeModelVersionId);
    } finally {
      if (previousBuildDelay === undefined) {
        delete process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_BUILD_DELAY_MS;
      } else {
        process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_BUILD_DELAY_MS = previousBuildDelay;
      }
    }

    const historyBeforeTtsCancel = await getJson("/api/voice-clone/history");
    const ttsJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "This generated sentence must not be saved after cancellation.",
      language: "en",
      settings: { fakeDelayMs: 1500 }
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    const cancelledTts = await postJson(`/api/voice-clone/jobs/${encodeURIComponent(ttsJob.id)}/cancel`, {});
    assert.equal(cancelledTts.status, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await getJson("/api/voice-clone/history")).length, historyBeforeTtsCancel.length);

    const previousPreparationDelay = process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_PREPARATION_DELAY_MS;
    process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_PREPARATION_DELAY_MS = "1500";
    try {
      const reprocess = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sampleId)}/reprocess`, {});
      let current = reprocess.job;
      for (let attempt = 0; attempt < 30 && current.status !== "preparing"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        current = await getJson(`/api/voice-clone/jobs/${encodeURIComponent(reprocess.job.id)}`);
      }
      assert.equal(current.status, "preparing");
      const activePreparationJobs = await getJson("/api/voice-clone/preparation-jobs");
      assert.ok(activePreparationJobs.some((job) => job.id === reprocess.job.id));
      const cancelledPreparation = await postJson(`/api/voice-clone/jobs/${encodeURIComponent(reprocess.job.id)}/cancel`, {});
      assert.equal(cancelledPreparation.status, "cancelled");
      await new Promise((resolve) => setTimeout(resolve, 250));
      const afterPreparationCancel = (await getJson("/api/voice-clone/profiles")).find((item) => item.id === profile.id);
      const sample = afterPreparationCancel.samples.find((item) => item.id === sampleId);
      assert.equal(sample.preparation.status, "needs-attention");
      assert.match(sample.preparation.failureMessage, /cancelled/i);
      const dismissed = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sampleId)}/preparation-failure/dismiss`, {
        preparationRevision: sample.preparation.revision
      });
      assert.equal(dismissed.sample.preparation.failureMessage, "");
      assert.ok(dismissed.sample.preparation.failureDismissedAt);
      const afterDismissReload = (await getJson("/api/voice-clone/profiles")).find((item) => item.id === profile.id);
      const dismissedSample = afterDismissReload.samples.find((item) => item.id === sampleId);
      assert.equal(dismissedSample.preparation.failureMessage, "");
      assert.ok(dismissedSample.preparation.failureDismissedAt);
      assert.equal(afterPreparationCancel.activeModelVersionId, activeModelVersionId);
    } finally {
      if (previousPreparationDelay === undefined) {
        delete process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_PREPARATION_DELAY_MS;
      } else {
        process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_PREPARATION_DELAY_MS = previousPreparationDelay;
      }
    }
    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("builds a GPT-SoVITS Chinese quick profile and sends Chinese TTS language fields", async () => {
    const outputDir = path.join(tempRoot, "voice-output-gpt-sovits-zh");
    const transcript = "\u4f60\u597d\uff0c\u6211\u662f\u4e00\u6bb5\u4e2d\u6587\u53c2\u8003\u97f3\u9891\u3002";
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "GPT Chinese Voice",
      language: "zh",
      consentConfirmed: true
    });
    assert.equal(profile.engine, "gpt-sovits-local");

    const form = new FormData();
    form.append("metadataJson", JSON.stringify([{ transcript, transcriptLanguage: "zh" }]));
    form.append("files", new Blob([makeWav(8.5)], { type: "audio/wav" }), "sample.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    assert.equal(upload.samples[0].gptSoVitsPromptReady, true);

    const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "gpt-sovits-local",
      qualityMode: "quick"
    });
    const built = await waitForVoiceJob(buildJob);
    assert.equal(built.status, "completed");
    assert.equal(built.result.profile.voiceModel.engine, "gpt-sovits-local");
    assert.equal(built.result.profile.voiceModel.promptLanguage, "zh");
    assert.equal(built.result.profile.voiceModel.promptText, transcript);

    const ttsJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "\u4f60\u597d\uff0c\u6211\u662f\u4e01\u771f\u73cd\u73e0\u3002\u4eca\u5929\u7684\u58f0\u97f3\u6d4b\u8bd5\u5f88\u987a\u5229\u3002",
      language: "zh",
      outputDir,
      settings: { outputFormat: "wav" }
    });
    const tts = await waitForVoiceJob(ttsJob);
    assert.equal(tts.status, "completed");
    assert.equal(tts.result.output.engine, "gpt-sovits-local");
    assert.equal(tts.result.output.language, "zh");
    assert.equal(tts.result.output.settings.gptSoVitsRequest.textLang, "zh");
    assert.equal(tts.result.output.settings.gptSoVitsRequest.promptLang, "zh");
    const metadata = JSON.parse(await fs.readFile(tts.result.output.metadataPath, "utf8"));
    assert.equal(metadata.engine, "gpt-sovits-local");
    assert.equal(metadata.effective_language, "zh");

    const sourceForm = new FormData();
    sourceForm.append("profileId", profile.id);
    sourceForm.append("modelVersionId", built.result.profile.activeModelVersionId);
    sourceForm.append("language", "zh");
    sourceForm.append("outputDir", outputDir);
    sourceForm.append("settingsJson", JSON.stringify({ outputFormat: "wav" }));
    sourceForm.append("sourceTranscript", "\u4f60\u597d\uff0c\u8bf7\u628a\u8fd9\u6bb5\u6e90\u97f3\u9891\u91cd\u65b0\u751f\u6210\u4e3a\u76ee\u6807\u58f0\u97f3\u3002");
    sourceForm.append("sourceAudio", new Blob([makeWav(2.1)], { type: "audio/wav" }), "source.wav");
    const rejectedResponse = await fetch(`${appContext.url}/api/voice-clone/v2v`, {
      method: "POST",
      body: sourceForm
    });
    assert.equal(rejectedResponse.status, 400);
    const rejected = await rejectedResponse.json();
    assert.match(rejected.error, /Text to Voice/);
    assert.match(rejected.error, /RVC\/SVC/);

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("saves the best audible TTS candidate after coverage retries while keeping hard waveform failures closed", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Integrity Gate Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("metadataJson", JSON.stringify([{ transcript: "Prepared local voice sample.", transcriptLanguage: "en" }]));
    form.append("files", new Blob([makeWav(4)], { type: "audio/wav" }), "sample.wav");
    await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "gpt-sovits-local",
      qualityMode: "quick"
    });
    const built = await waitForVoiceJob(buildJob);
    assert.equal(built.status, "completed");
    const historyBefore = await getJson("/api/voice-clone/history");
    const ttsJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "Every requested sentence must remain in the generated voice.",
      language: "en",
      settings: { integrityFixture: "missing" }
    });
    const coverageAdvisory = await waitForVoiceJob(ttsJob);
    assert.equal(coverageAdvisory.status, "completed");
    assert.equal(coverageAdvisory.result.output.settings.synthesisIntegrity.final.advisoryCoverageWarning, true);
    assert.equal(coverageAdvisory.result.output.settings.synthesisIntegrity.clauses[0].selectedAttempt, 1);
    const historyAfterCoverage = await getJson("/api/voice-clone/history");
    assert.equal(historyAfterCoverage.length, historyBefore.length + 1);

    const duplicatedJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "The generated voice must not repeat the entire requested sentence.",
      language: "en",
      settings: { integrityFixture: "excess" }
    });
    const duplicated = await waitForVoiceJob(duplicatedJob);
    assert.equal(duplicated.status, "failed");
    assert.match(duplicated.error, /unexpected_text_excess/);
    assert.equal((await getJson("/api/voice-clone/history")).length, historyAfterCoverage.length);

    const recoveredJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "This is the first complete requested sentence. This is the second complete requested sentence.",
      language: "en",
      settings: { integrityFixture: "clause-2-retry-once" }
    });
    const recovered = await waitForVoiceJob(recoveredJob);
    assert.equal(recovered.status, "completed");
    const integrity = recovered.result.output.settings.synthesisIntegrity;
    assert.equal(integrity.clauses.length, 2);
    assert.deepEqual(integrity.clauses[0].attempts.map((item) => item.accepted), [true]);
    assert.deepEqual(integrity.clauses[1].attempts.map((item) => item.accepted), [false, true]);
    assert.equal(integrity.clauses[0].attempts[0].preset.recoverySplit, "sentence");
    assert.equal(integrity.clauses[1].attempts[1].preset.recoverySplit, "soft-punctuation");

    const remediatedJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "This sentence needs both coverage retry and hum remediation.",
      language: "en",
      settings: { integrityFixture: "missing-hum-retry-once" }
    });
    const remediated = await waitForVoiceJob(remediatedJob);
    assert.equal(remediated.status, "completed");
    const remediationAttempts = remediated.result.output.settings.synthesisIntegrity.clauses[0].attempts;
    assert.equal(remediationAttempts[0].reason, "ordered_text_coverage_low");
    assert.ok(remediationAttempts[1].preset.remediation.includes("notch_60hz"), remediationAttempts);

    const finalAmplitudeJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "Each sentence is complete, and the joined waveform must not be deleted by a rhythm-only warning.",
      language: "en",
      settings: { integrityFixture: "final-tremble" }
    });
    const finalAmplitude = await waitForVoiceJob(finalAmplitudeJob);
    assert.equal(finalAmplitude.status, "completed");
    assert.equal(finalAmplitude.result.output.settings.synthesisIntegrity.final.accepted, true);
    assert.equal(finalAmplitude.result.output.settings.synthesisIntegrity.final.strictValidationAccepted, false);
    assert.equal(finalAmplitude.result.output.settings.synthesisIntegrity.final.advisoryAmplitudeWarning, true);
    assert.deepEqual(finalAmplitude.result.output.settings.synthesisIntegrity.final.reasons, ["unstable_amplitude_detected"]);

    const finalCoverageJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "A final whole-script coverage warning must preserve the best audible output.",
      language: "en",
      settings: { integrityFixture: "final-missing" }
    });
    const finalCoverage = await waitForVoiceJob(finalCoverageJob);
    assert.equal(finalCoverage.status, "completed");
    assert.equal(finalCoverage.result.output.settings.synthesisIntegrity.final.advisoryCoverageWarning, true);

    const rankedAmplitudeJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "Choose the least modulated complete attempt while keeping hard integrity failures closed.",
      language: "en",
      settings: { integrityFixture: "tremble-ranked" }
    });
    const rankedAmplitude = await waitForVoiceJob(rankedAmplitudeJob);
    assert.equal(rankedAmplitude.status, "completed");
    const rankedClause = rankedAmplitude.result.output.settings.synthesisIntegrity.clauses[0];
    assert.deepEqual(rankedClause.attempts.map((item) => item.waveformHealth.modulationScore), [0.61, 0.32, 0.48]);
    assert.deepEqual(rankedClause.attempts.map((item) => item.accepted), [false, false, false]);
    assert.equal(rankedClause.selectedAttempt, 2);
    assert.equal(rankedClause.advisoryAmplitudeWarning, true);

    const retainedAdvisoryJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "Keep an earlier complete advisory attempt when later attempts introduce hard coverage failures.",
      language: "en",
      settings: { integrityFixture: "tremble-then-missing" }
    });
    const retainedAdvisory = await waitForVoiceJob(retainedAdvisoryJob);
    assert.equal(retainedAdvisory.status, "completed");
    const retainedClause = retainedAdvisory.result.output.settings.synthesisIntegrity.clauses[0];
    assert.deepEqual(retainedClause.attempts.map((item) => item.reason), [
      "unstable_amplitude_detected",
      "ordered_text_coverage_low",
      "ordered_text_coverage_low"
    ]);
    assert.equal(retainedClause.selectedAttempt, 1);
    assert.equal(retainedClause.advisoryAmplitudeWarning, true);

    const mixedHardFailureJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "Amplitude cannot hide an electrical hum failure.",
      language: "en",
      settings: { integrityFixture: "tremble+hum" }
    });
    const mixedHardFailure = await waitForVoiceJob(mixedHardFailureJob);
    assert.equal(mixedHardFailure.status, "failed");
    assert.match(mixedHardFailure.error, /line_hum_detected/);

    const malformedMetricJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "A malformed modulation score cannot authorize advisory output.",
      language: "en",
      settings: { integrityFixture: "tremble-malformed-metric" }
    });
    const malformedMetric = await waitForVoiceJob(malformedMetricJob);
    assert.equal(malformedMetric.status, "failed");
    assert.match(malformedMetric.error, /unstable_amplitude_detected/);

    const inconsistentClauseJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "A worker acceptance flag cannot override low clause coverage.",
      language: "en",
      settings: { integrityFixture: "accepted-low-coverage" }
    });
    const inconsistentClause = await waitForVoiceJob(inconsistentClauseJob);
    assert.equal(inconsistentClause.status, "completed");
    assert.equal(inconsistentClause.result.output.settings.synthesisIntegrity.final.advisoryCoverageWarning, true);

    const inconsistentHumJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "A worker acceptance flag cannot override detected electrical hum.",
      language: "en",
      settings: { integrityFixture: "accepted-hum" }
    });
    const inconsistentHum = await waitForVoiceJob(inconsistentHumJob);
    assert.equal(inconsistentHum.status, "failed");
    assert.match(inconsistentHum.error, /line_hum_detected/);

    const inconsistentMetricJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "A worker acceptance flag cannot override a malformed waveform metric.",
      language: "en",
      settings: { integrityFixture: "accepted-malformed-metric" }
    });
    const inconsistentMetric = await waitForVoiceJob(inconsistentMetricJob);
    assert.equal(inconsistentMetric.status, "failed");
    assert.match(inconsistentMetric.error, /speech_integrity_failed/);

    const inconsistentFinalJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "A worker acceptance flag cannot override low final coverage.",
      language: "en",
      settings: { integrityFixture: "final-accepted-low-coverage" }
    });
    const inconsistentFinal = await waitForVoiceJob(inconsistentFinalJob);
    assert.equal(inconsistentFinal.status, "completed");
    assert.equal(inconsistentFinal.result.output.settings.synthesisIntegrity.final.advisoryCoverageWarning, true);

    for (const finalHardFixture of ["final-silent", "final-hum", "final-tremble+hum"]) {
      const finalHardJob = await postJson("/api/voice-clone/tts", {
        profileId: profile.id,
        text: "Final combined audio must keep hard waveform failures closed.",
        language: "en",
        settings: { integrityFixture: finalHardFixture }
      });
      const finalHard = await waitForVoiceJob(finalHardJob);
      assert.equal(finalHard.status, "failed", finalHardFixture);
      assert.match(finalHard.error, /Combined speech did not pass/, finalHardFixture);
    }

    const unsupportedFixtureJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "Unsupported integrity fixtures must fail closed.",
      language: "en",
      settings: { integrityFixture: "missingg" }
    });
    const unsupportedFixture = await waitForVoiceJob(unsupportedFixtureJob);
    assert.equal(unsupportedFixture.status, "failed");
    assert.match(unsupportedFixture.error, /Unsupported fake Voice integrity fixture: missingg/);
    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("keeps full TTS scripts out of saved diagnostics and history", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Private TTS Diagnostics Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("metadataJson", JSON.stringify([{ transcript: "A prepared source for private script diagnostics.", transcriptLanguage: "en" }]));
    form.append("files", new Blob([makeWav(4)], { type: "audio/wav" }), "private-tts.wav");
    await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "openvoice-v2-local",
      qualityMode: "quick"
    });
    assert.equal((await waitForVoiceJob(buildJob)).status, "completed");
    const canary = "VOICE_TTS_SCRIPT_PRIVATE_CANARY";
    const text = `${"A calm generated sentence. ".repeat(12)}${canary} This suffix must stay out of diagnostics.`;
    const ttsJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text,
      language: "en"
    });
    const completed = await waitForVoiceJob(ttsJob);
    assert.equal(completed.status, "completed");
    assert.doesNotMatch(completed.result.output.textPreview, new RegExp(canary));
    assert.doesNotMatch(JSON.stringify(completed), new RegExp(canary));
    const history = await getJson("/api/voice-clone/history");
    assert.doesNotMatch(JSON.stringify(history), new RegExp(canary));
    const database = await fs.readFile(path.join(voiceIngressFixture.voiceRoot, "voice_clone.json"), "utf8");
    assert.doesNotMatch(database, new RegExp(canary));

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("converts Voice to Voice with a saved OpenVoice version while GPT-SoVITS is active", async () => {
    const outputDir = path.join(tempRoot, "voice-output-v2v-version");
    const transcript = "\u4f60\u597d\uff0c\u8fd9\u662f\u540c\u4e00\u4e2a\u58f0\u97f3\u7684\u53c2\u8003\u97f3\u9891\u3002";
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Dual Engine Voice",
      language: "zh",
      consentConfirmed: true
    });

    const form = new FormData();
    form.append("metadataJson", JSON.stringify([{ transcript, transcriptLanguage: "zh" }]));
    form.append("files", new Blob([makeWav(8.5)], { type: "audio/wav" }), "sample.wav");
    await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);

    const openVoiceBuildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "openvoice-v2-local",
      qualityMode: "quick"
    });
    const openVoiceBuilt = await waitForVoiceJob(openVoiceBuildJob);
    assert.equal(openVoiceBuilt.status, "completed");
    assert.equal(openVoiceBuilt.result.profile.voiceModel.engine, "openvoice-v2-local");
    const openVoiceVersionId = openVoiceBuilt.result.profile.activeModelVersionId;

    const gptBuildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "gpt-sovits-local",
      qualityMode: "quick"
    });
    const gptBuilt = await waitForVoiceJob(gptBuildJob);
    assert.equal(gptBuilt.status, "completed");
    assert.equal(gptBuilt.result.profile.voiceModel.engine, "gpt-sovits-local");
    assert.equal(gptBuilt.result.profile.modelVersions.some((version) => version.id === openVoiceVersionId), true);

    const sourceForm = new FormData();
    sourceForm.append("profileId", profile.id);
    sourceForm.append("modelVersionId", openVoiceVersionId);
    sourceForm.append("language", "zh");
    sourceForm.append("outputDir", outputDir);
    sourceForm.append("settingsJson", JSON.stringify({ outputFormat: "wav" }));
    sourceForm.append("sourceAudio", new Blob([makeWav(2.1)], { type: "audio/wav" }), "source.wav");
    const v2vJob = await postForm("/api/voice-clone/v2v", sourceForm);
    const v2v = await waitForVoiceJob(v2vJob);
    assert.equal(v2v.status, "completed");
    assert.equal(v2v.result.output.mode, "v2v");
    assert.equal(v2v.result.output.engine, "openvoice-v2-local");
    assert.equal(v2v.result.output.settings.modelVersionId, openVoiceVersionId);

    await fetch(`${appContext.url}/api/voice-clone/outputs/${encodeURIComponent(v2v.result.output.id)}`, { method: "DELETE" });
    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("replaces song vocals by separating stems before OpenVoice conversion and mixback", async () => {
    const outputDir = path.join(tempRoot, "voice-output-song-v2v");
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Song Target Voice",
      language: "zh",
      consentConfirmed: true
    });

    const form = new FormData();
    form.append("files", new Blob([makeWav(8.5)], { type: "audio/wav" }), "sample.wav");
    await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);

    const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "openvoice-v2-local",
      qualityMode: "quick"
    });
    const built = await waitForVoiceJob(buildJob);
    assert.equal(built.status, "completed");
    const openVoiceVersionId = built.result.profile.activeModelVersionId;

    const songForm = new FormData();
    songForm.append("profileId", profile.id);
    songForm.append("modelVersionId", openVoiceVersionId);
    songForm.append("language", "zh");
    songForm.append("outputDir", outputDir);
    songForm.append("settingsJson", JSON.stringify({
      outputFormat: "wav",
      vocalVolume: 1.1,
      accompanimentVolume: 0.75,
      noiseReduction: true
    }));
    songForm.append("sourceAudio", new Blob([makeStereoSongWav(2.4)], { type: "audio/wav" }), "source-song.wav");
    const songJob = await postForm("/api/voice-clone/song-v2v", songForm);
    const song = await waitForVoiceJob(songJob);
    assert.equal(song.status, "completed");
    assert.equal(song.result.output.mode, "song-v2v");
    assert.equal(song.result.output.engine, "openvoice-v2-local");
    assert.equal(song.result.output.settings.conversionStrategy, "song-vocal-stem-openvoice-v2");
    assert.equal(song.result.output.settings.separationStrategy, "ffmpeg-center-side");
    assert.equal(song.result.output.settings.mixStrategy, "ffmpeg-amix");
    assert.equal(song.result.output.settings.modelVersionId, openVoiceVersionId);
    assert.equal(song.result.output.settings.sourceChannels, 2);
    assert.ok(song.result.output.durationSeconds > 0);
    const outputFile = await fs.readFile(song.result.output.outputPath);
    assert.equal(outputFile.toString("ascii", 0, 4), "RIFF");
    const metadata = JSON.parse(await fs.readFile(song.result.output.metadataPath, "utf8"));
    assert.equal(metadata.mode, "song-v2v");
    assert.equal(metadata.source_audio_name, "source-song.wav");

    await fetch(`${appContext.url}/api/voice-clone/outputs/${encodeURIComponent(song.result.output.id)}`, { method: "DELETE" });
    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("uses Demucs separation and Seed-VC F0 conversion for high-quality song VTV", async () => {
    const outputDir = path.join(tempRoot, "voice-output-song-v2v-seed");
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Seed Song Target Voice",
      language: "zh",
      consentConfirmed: true
    });
    const sampleForm = new FormData();
    sampleForm.append("metadataJson", JSON.stringify([
      { transcript: "第一段清晰目标声音。", transcriptLanguage: "zh" },
      { transcript: "第二段清晰目标声音。", transcriptLanguage: "zh" },
      { transcript: "第三段清晰目标声音。", transcriptLanguage: "zh" }
    ]));
    sampleForm.append("files", new Blob([makeWav(4.2)], { type: "audio/wav" }), "sample-a.wav");
    sampleForm.append("files", new Blob([makeWav(4.2)], { type: "audio/wav" }), "sample-b.wav");
    sampleForm.append("files", new Blob([makeWav(4.2)], { type: "audio/wav" }), "sample-c.wav");
    await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, sampleForm);
    const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "gpt-sovits-local",
      qualityMode: "fine"
    });
    const built = await waitForVoiceJob(buildJob);
    assert.equal(built.status, "completed");
    const targetVersionId = built.result.profile.activeModelVersionId;

    const songForm = new FormData();
    songForm.append("profileId", profile.id);
    songForm.append("modelVersionId", targetVersionId);
    songForm.append("language", "zh");
    songForm.append("outputDir", outputDir);
    songForm.append("settingsJson", JSON.stringify({
      conversionEngine: "seed-vc-svc-local",
      outputFormat: "wav",
      preserveEmotion: true,
      preserveTiming: true,
      diffusionSteps: 50,
      inferenceCfgRate: 0.85,
      chunkCrossfadeMs: 750,
      separationOverlap: 0.5,
      songIntegrityFixture: "fail-first",
      vocalVolume: 1,
      accompanimentVolume: 0.85
    }));
    songForm.append("sourceAudio", new Blob([makeStereoSongWav(2.4)], { type: "audio/wav" }), "source-song.wav");
    const songJob = await postForm("/api/voice-clone/song-v2v", songForm);
    const song = await waitForVoiceJob(songJob);

    assert.equal(song.status, "completed");
    assert.equal(song.result.output.engine, "seed-vc-svc-local");
    assert.equal(song.result.output.settings.conversionEngine, "seed-vc-svc-local");
    assert.equal(song.result.output.settings.conversionStrategy, "demucs-verified-seed-vc-zero-shot-svc-f0");
    assert.equal(song.result.output.settings.separationStrategy, "demucs-htdemucs");
    assert.equal(song.result.output.settings.mixStrategy, "ffmpeg-amix");
    assert.equal(song.result.output.settings.diffusionSteps, 50);
    assert.equal(song.result.output.settings.inferenceCfgRate, 0.85);
    assert.equal(song.result.output.settings.chunkCrossfadeMs, 750);
    assert.equal(song.result.output.settings.separationOverlap, 0.5);
    assert.equal(song.result.output.settings.modelVersionId, targetVersionId);
    assert.ok(song.result.output.durationSeconds > 0);
    assert.equal(song.result.output.settings.songIntegrity.accepted, true);
    assert.equal(song.result.output.settings.songIntegrity.strictValidationAccepted, true);
    assert.equal(song.result.output.settings.songIntegrity.advisoryAccepted, false);
    assert.equal(song.result.output.settings.songIntegrity.repairedPhraseCount, 1);
    assert.equal(song.result.output.settings.songIntegrity.final.accepted, true);
    assert.equal(song.result.output.settings.songIntegrity.attempts.some((attempt) => attempt.accepted === false), true);
    assert.equal(song.result.output.settings.songIntegrity.attempts.some((attempt) => attempt.phase.startsWith("repair-") && attempt.accepted), true);
    assert.equal(song.result.output.settings.songIntegrity.targetReferenceStrategy, "multi-clip-target-reference-v1");
    assert.equal(song.result.output.settings.songIntegrity.targetReferenceClipCount, 3);
    assert.ok(song.result.output.settings.songIntegrity.targetReferenceDurationSeconds >= 12);
    assert.ok(song.result.output.settings.songIntegrity.targetReferenceDurationSeconds <= 18);
    assert.equal(song.result.output.settings.nativeSampleRate, 44100);
    assert.equal(song.result.output.settings.sourceNativeSampleRate, 44100);
    assert.equal(song.result.output.settings.sourceNativeChannels, 2);
    assert.equal(song.result.output.settings.finalMixGate.passed, true);
    assert.equal(song.result.output.settings.vtvCandidates, undefined);

    const repairSelectionForm = new FormData();
    repairSelectionForm.append("profileId", profile.id);
    repairSelectionForm.append("modelVersionId", targetVersionId);
    repairSelectionForm.append("language", "zh");
    repairSelectionForm.append("outputDir", outputDir);
    repairSelectionForm.append("settingsJson", JSON.stringify({
      conversionEngine: "seed-vc-svc-local",
      outputFormat: "wav",
      songIntegrityFixture: "repair-candidate-selection"
    }));
    repairSelectionForm.append("sourceAudio", new Blob([makeStereoSongWav(2.4)], { type: "audio/wav" }), "repair-selection-source-song.wav");
    const repairSelectionJob = await postForm("/api/voice-clone/song-v2v", repairSelectionForm);
    const repairSelection = await waitForVoiceJob(repairSelectionJob);
    assert.equal(repairSelection.status, "completed");
    assert.equal(repairSelection.result.output.settings.songIntegrity.final.accepted, true);
    assert.equal(repairSelection.result.output.settings.songIntegrity.strictValidationAccepted, true);
    assert.equal(repairSelection.result.output.settings.songIntegrity.advisoryAccepted, false);
    assert.equal(repairSelection.result.output.settings.songIntegrity.attempts.some((attempt) => (
      attempt.phase.startsWith("repair-")
        && attempt.accepted === false
        && attempt.selectedForFinalVerification === true
    )), true);

    const historyBeforeAdvisory = await getJson("/api/voice-clone/history");
    const advisoryForm = new FormData();
    advisoryForm.append("profileId", profile.id);
    advisoryForm.append("modelVersionId", targetVersionId);
    advisoryForm.append("language", "zh");
    advisoryForm.append("outputDir", outputDir);
    advisoryForm.append("settingsJson", JSON.stringify({
      conversionEngine: "seed-vc-svc-local",
      outputFormat: "wav",
      songIntegrityFixture: "song-advisory-fallback"
    }));
    advisoryForm.append("sourceAudio", new Blob([makeStereoSongWav(2.4)], { type: "audio/wav" }), "advisory-source-song.wav");
    const advisoryJob = await postForm("/api/voice-clone/song-v2v", advisoryForm);
    const advisory = await waitForVoiceJob(advisoryJob);
    assert.equal(advisory.status, "needs-review");
    assert.equal(advisory.result.output.settings.songIntegrity.accepted, true);
    assert.equal(advisory.result.output.settings.songIntegrity.strictValidationAccepted, false);
    assert.equal(advisory.result.output.settings.songIntegrity.advisoryAccepted, true);
    assert.equal(advisory.result.output.settings.songIntegrity.final.accepted, false);
    assert.deepEqual(advisory.result.output.settings.songIntegrity.advisoryReasons, [
      "pitch_discontinuity",
      "localized_pitch_failure"
    ]);
    assert.equal(advisory.result.output.settings.vtvCandidates, undefined);
    assert.equal((await getJson("/api/voice-clone/history")).length, historyBeforeAdvisory.length + 1);
    assert.equal((await fs.readFile(advisory.result.output.outputPath)).toString("ascii", 0, 4), "RIFF");

    const historyBeforeInvalidAdvisory = await getJson("/api/voice-clone/history");
    const invalidAdvisoryForm = new FormData();
    invalidAdvisoryForm.append("profileId", profile.id);
    invalidAdvisoryForm.append("modelVersionId", targetVersionId);
    invalidAdvisoryForm.append("language", "zh");
    invalidAdvisoryForm.append("outputDir", outputDir);
    invalidAdvisoryForm.append("settingsJson", JSON.stringify({
      conversionEngine: "seed-vc-svc-local",
      outputFormat: "wav",
      songIntegrityFixture: "song-advisory-invalid-metrics"
    }));
    invalidAdvisoryForm.append("sourceAudio", new Blob([makeStereoSongWav(2.4)], { type: "audio/wav" }), "invalid-advisory-source-song.wav");
    const invalidAdvisoryJob = await postForm("/api/voice-clone/song-v2v", invalidAdvisoryForm);
    const invalidAdvisory = await waitForVoiceJob(invalidAdvisoryJob);
    assert.equal(invalidAdvisory.status, "failed");
    assert.match(invalidAdvisory.error, /song_integrity_metrics_invalid/);
    assert.equal((await getJson("/api/voice-clone/history")).length, historyBeforeInvalidAdvisory.length);

    const invalidDomainForm = new FormData();
    invalidDomainForm.append("profileId", profile.id);
    invalidDomainForm.append("modelVersionId", targetVersionId);
    invalidDomainForm.append("language", "zh");
    invalidDomainForm.append("outputDir", outputDir);
    invalidDomainForm.append("settingsJson", JSON.stringify({
      conversionEngine: "seed-vc-svc-local",
      outputFormat: "wav",
      songIntegrityFixture: "song-advisory-invalid-domain"
    }));
    invalidDomainForm.append("sourceAudio", new Blob([makeStereoSongWav(2.4)], { type: "audio/wav" }), "invalid-domain-source-song.wav");
    const invalidDomainJob = await postForm("/api/voice-clone/song-v2v", invalidDomainForm);
    const invalidDomain = await waitForVoiceJob(invalidDomainJob);
    assert.equal(invalidDomain.status, "failed");
    assert.match(invalidDomain.error, /song_integrity_metrics_invalid/);
    assert.equal((await getJson("/api/voice-clone/history")).length, historyBeforeInvalidAdvisory.length);

    const inconsistentStrictForm = new FormData();
    inconsistentStrictForm.append("profileId", profile.id);
    inconsistentStrictForm.append("modelVersionId", targetVersionId);
    inconsistentStrictForm.append("language", "zh");
    inconsistentStrictForm.append("outputDir", outputDir);
    inconsistentStrictForm.append("settingsJson", JSON.stringify({
      conversionEngine: "seed-vc-svc-local",
      outputFormat: "wav",
      songIntegrityFixture: "song-strict-inconsistent"
    }));
    inconsistentStrictForm.append("sourceAudio", new Blob([makeStereoSongWav(2.4)], { type: "audio/wav" }), "inconsistent-strict-source-song.wav");
    const inconsistentStrictJob = await postForm("/api/voice-clone/song-v2v", inconsistentStrictForm);
    const inconsistentStrict = await waitForVoiceJob(inconsistentStrictJob);
    assert.equal(inconsistentStrict.status, "rejected");
    assert.match(inconsistentStrict.error, /target_identity_weak/);
    assert.equal((await getJson("/api/voice-clone/history")).length, historyBeforeInvalidAdvisory.length);

    const inconsistentMetricsForm = new FormData();
    inconsistentMetricsForm.append("profileId", profile.id);
    inconsistentMetricsForm.append("modelVersionId", targetVersionId);
    inconsistentMetricsForm.append("language", "zh");
    inconsistentMetricsForm.append("outputDir", outputDir);
    inconsistentMetricsForm.append("settingsJson", JSON.stringify({
      conversionEngine: "seed-vc-svc-local",
      outputFormat: "wav",
      songIntegrityFixture: "song-strict-inconsistent-metrics"
    }));
    inconsistentMetricsForm.append("sourceAudio", new Blob([makeStereoSongWav(2.4)], { type: "audio/wav" }), "inconsistent-metrics-source-song.wav");
    const inconsistentMetricsJob = await postForm("/api/voice-clone/song-v2v", inconsistentMetricsForm);
    const inconsistentMetrics = await waitForVoiceJob(inconsistentMetricsJob);
    assert.equal(inconsistentMetrics.status, "failed");
    assert.equal((await getJson("/api/voice-clone/history")).length, historyBeforeInvalidAdvisory.length);

    const historyBeforeRejected = await getJson("/api/voice-clone/history");
    const rejectedForm = new FormData();
    rejectedForm.append("profileId", profile.id);
    rejectedForm.append("modelVersionId", targetVersionId);
    rejectedForm.append("language", "zh");
    rejectedForm.append("outputDir", outputDir);
    rejectedForm.append("settingsJson", JSON.stringify({
      conversionEngine: "seed-vc-svc-local",
      outputFormat: "wav",
      songIntegrityFixture: "many-interval-budget"
    }));
    rejectedForm.append("sourceAudio", new Blob([makeStereoSongWav(2.4)], { type: "audio/wav" }), "rejected-source-song.wav");
    const rejectedJob = await postForm("/api/voice-clone/song-v2v", rejectedForm);
    const rejected = await waitForVoiceJob(rejectedJob);
    assert.equal(rejected.status, "rejected");
    assert.match(rejected.error, /Song vocal conversion did not preserve melody and target identity/);
    assert.equal(rejected.diagnostics.songIntegrity.accepted, false);
    assert.equal(rejected.diagnostics.songIntegrity.fullAttemptCount, 2);
    assert.equal(rejected.diagnostics.songIntegrity.phraseConversionBudget, 12);
    assert.equal(rejected.diagnostics.songIntegrity.phraseConversionAttempts, 12);
    assert.equal(rejected.diagnostics.songIntegrity.phraseConversionBudgetExhausted, true);
    assert.equal(rejected.diagnostics.songIntegrity.attempts.filter((attempt) => attempt.phase.startsWith("repair-1-")).length, 9);
    assert.equal(rejected.diagnostics.songIntegrity.attempts.filter((attempt) => attempt.phase.startsWith("repair-2-")).length, 3);
    assert.match(rejected.error, /phrase_repair_budget_exhausted/);
    assert.equal(rejected.diagnostics.songIntegrity.attempts.length > 0, true);
    assert.equal(rejected.diagnostics.songIntegrity.final.accepted, false);
    assert.equal((await getJson("/api/voice-clone/history")).length, historyBeforeRejected.length);

    const historyBeforeCancel = await getJson("/api/voice-clone/history");
    const cancelForm = new FormData();
    cancelForm.append("profileId", profile.id);
    cancelForm.append("modelVersionId", targetVersionId);
    cancelForm.append("language", "zh");
    cancelForm.append("outputDir", outputDir);
    cancelForm.append("settingsJson", JSON.stringify({
      conversionEngine: "seed-vc-svc-local",
      outputFormat: "wav",
      fakeDelayMs: 2000
    }));
    cancelForm.append("sourceAudio", new Blob([makeStereoSongWav(2.4)], { type: "audio/wav" }), "cancel-source-song.wav");
    const cancellableJob = await postForm("/api/voice-clone/song-v2v", cancelForm);
    let cancellableState = cancellableJob;
    for (let attempt = 0; attempt < 80 && cancellableState.progress < 62; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      cancellableState = await getJson(`/api/voice-clone/jobs/${encodeURIComponent(cancellableJob.id)}`);
    }
    const cancelled = await postJson(`/api/voice-clone/jobs/${encodeURIComponent(cancellableJob.id)}/cancel`, {});
    assert.equal(cancelled.status, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const cancelledAfterWorkerDelay = await getJson(`/api/voice-clone/jobs/${encodeURIComponent(cancellableJob.id)}`);
    assert.equal(cancelledAfterWorkerDelay.status, "cancelled");
    const historyAfterCancel = await getJson("/api/voice-clone/history");
    assert.equal(historyAfterCancel.length, historyBeforeCancel.length);

    await fetch(`${appContext.url}/api/voice-clone/outputs/${encodeURIComponent(song.result.output.id)}`, { method: "DELETE" });
    await fetch(`${appContext.url}/api/voice-clone/outputs/${encodeURIComponent(repairSelection.result.output.id)}`, { method: "DELETE" });
    await fetch(`${appContext.url}/api/voice-clone/outputs/${encodeURIComponent(advisory.result.output.id)}`, { method: "DELETE" });
    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("blocks GPT-SoVITS build until an eligible prepared sentence exists", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "No Transcript Chinese Voice",
      language: "zh",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("files", new Blob([makeWav(0.1)], { type: "audio/wav" }), "sample.wav");
    await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "gpt-sovits-local",
      qualityMode: "quick"
    });
    const built = await waitForVoiceJob(buildJob);
    assert.equal(built.status, "failed");
    assert.match(built.error, /sentence clip|eligible|prepared/i);

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("builds GPT-SoVITS Fine Clone dataset metadata from transcript-ready samples", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Fine Chinese Voice",
      language: "zh",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("metadataJson", JSON.stringify([
      { transcript: "\u7b2c\u4e00\u6bb5\u4e2d\u6587\u8bad\u7ec3\u97f3\u9891\u3002", transcriptLanguage: "zh" },
      { transcript: "\u7b2c\u4e8c\u6bb5\u4e2d\u6587\u8bad\u7ec3\u97f3\u9891\u3002", transcriptLanguage: "zh" }
    ]));
    form.append("files", new Blob([makeWav(6.2)], { type: "audio/wav" }), "sample-a.wav");
    form.append("files", new Blob([makeWav(7.1)], { type: "audio/wav" }), "sample-b.wav");
    const uploaded = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const firstSegment = uploaded.samples[0].segments[0];
    const secondSegment = uploaded.samples[1].segments[0];
    const excluded = await patchJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(uploaded.samples[0].id)}/segments/${encodeURIComponent(firstSegment.id)}`, {
      includeInTraining: false
    });
    assert.equal(excluded.segment.includedInFineTraining, false);
    const includedAll = await patchJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/training-clips`, {
      includeAll: true
    });
    assert.equal(includedAll.updatedClipCount, 1);
    const includedFirstSegment = includedAll.profile.samples
      .find((sample) => sample.id === uploaded.samples[0].id)
      .segments.find((segment) => segment.id === firstSegment.id);
    assert.equal(includedFirstSegment.includedInFineTraining, true);
    const reExcluded = await patchJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(uploaded.samples[0].id)}/segments/${encodeURIComponent(firstSegment.id)}`, {
      includeInTraining: false
    });
    assert.equal(reExcluded.segment.includedInFineTraining, false);
    const preferred = await patchJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(uploaded.samples[1].id)}/segments/${encodeURIComponent(secondSegment.id)}`, {
      preferredPrompt: true
    });
    assert.equal(preferred.segment.preferredPrompt, true);
    const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "gpt-sovits-local",
      qualityMode: "fine"
    });
    const built = await waitForVoiceJob(buildJob);
    assert.equal(built.status, "completed");
    assert.equal(built.result.profile.qualityMode, "fine");
    assert.equal(built.result.profile.voiceModel.engine, "gpt-sovits-local");
    assert.equal(built.result.profile.voiceModel.datasetSamples.length, 1);
    assert.equal(built.result.profile.voiceModel.primarySegmentId, secondSegment.id);
    assert.equal(built.result.profile.voiceModel.fineTuneDatasetPrepared, true);
    assert.equal(built.result.profile.voiceModel.fineTuneTrainingCompleted, true);
    assert.ok(built.result.profile.voiceModel.datasetListPath);
    assert.ok(built.result.profile.voiceModel.gptWeightsPath);
    assert.ok(built.result.profile.voiceModel.sovitsWeightsPath);
    assert.equal(built.result.profile.voiceModel.trainingStats.datasetSampleCount, 1);
    assert.equal(built.result.profile.voiceModel.trainingStats.gptCheckpointSelection.selectedBy, "duration-semantic-waveform-gate");
    assert.equal(built.result.profile.voiceModel.trainingStats.gptCheckpointValidation[0].accepted, true);
    assert.equal(built.result.profile.voiceModel.trainingStats.gptCheckpointValidation[0].coverage, 1);

    const ttsJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "(excited) 你好，这段细训语音需要使用训练基线完成最终验证。",
      language: "zh",
      settings: {
        outputFormat: "wav",
        similarityStrength: 0.8,
        styleStrength: 0.9,
        pitch: 1.5,
        forbidEmotionTagExpectedText: true,
        refinementRetryFixture: "fail-first"
      }
    });
    const tts = await waitForVoiceJob(ttsJob);
    assert.equal(tts.status, "completed");
    assert.equal(tts.result.output.settings.synthesisIntegrity.waveformHealth.baselineAudioPathCount, 1);
    assert.equal(tts.result.output.engine, "gpt-sovits-local");
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.applied, true);
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.engine, "seed-vc-svc-local");
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.attemptCount, 2);
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.targetBlendRatio, 1);
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.coverage, 1);
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.identityValidationAccepted, true);
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.sourceTargetSimilarity, 0.4);
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.targetSimilarity, 0.9);
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.identityGain, 0.5);
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.targetReferenceClipCount, 1);
    assert.equal(typeof tts.result.output.settings.gptSoVitsRequest.refinement.waveformHealth, "object");
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.attempts.length, 2);
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.attempts[0].accepted, false);
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.attempts[1].accepted, true);
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.attempts[1].stage, "completed");
    assert.equal(tts.result.output.settings.gptSoVitsRequest.refinement.resourceCoordination.serializedSeedVc, true);
    const styledAttempt = tts.result.output.settings.synthesisIntegrity.clauses[0].attempts[0];
    assert.equal(styledAttempt.preset.style, "excited");
    assert.equal(styledAttempt.preset.styleStrength, 0.9);
    assert.equal(styledAttempt.preset.pitchSemitones, 1.5);

    const coverageRecoveryJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "啦啦啦啦啦，这段细训语音需要在整句转写不确定时保留安全精修。",
      language: "zh",
      settings: {
        outputFormat: "wav",
        similarityStrength: 0.8,
        integrityFixture: "missing"
      }
    });
    const coverageRecovery = await waitForVoiceJob(coverageRecoveryJob);
    assert.equal(coverageRecovery.status, "completed");
    const recoveredRefinement = coverageRecovery.result.output.settings.gptSoVitsRequest.refinement;
    assert.equal(recoveredRefinement.applied, true);
    assert.equal(recoveredRefinement.strictValidationAccepted, false);
    assert.equal(recoveredRefinement.advisoryCoverageWarning, true);
    assert.equal(recoveredRefinement.attemptCount, 2);
    assert.equal(recoveredRefinement.targetBlendRatio, 0.3);
    assert.equal(recoveredRefinement.coverage, 0.5);
    assert.equal(recoveredRefinement.identityValidationAccepted, true);
    assert.equal(recoveredRefinement.targetSimilarity, 0.55);
    assert.match(coverageRecovery.result.warnings.join(" "), /source-dominant Seed-VC blend/u);

    const identityFailureJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "这段细训语音必须真正接近目标声线后才能保存。",
      language: "zh",
      settings: {
        outputFormat: "wav",
        similarityStrength: 0.8,
        refinementIdentityFixture: "flat"
      }
    });
    const identityFailure = await waitForVoiceJob(identityFailureJob);
    assert.equal(identityFailure.status, "failed");
    assert.equal(identityFailure.outputId, null);
    assert.match(identityFailure.error, /identity_validation_failed/u);
    assert.equal(identityFailure.diagnostics.speakerRefinement.attempts.length, 2);
    assert.equal(identityFailure.diagnostics.speakerRefinement.attempts.at(-1).stage, "identity-validation");

    const failedRefinementJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "这段细训语音必须在声线精修成功后才能保存。",
      language: "zh",
      settings: {
        outputFormat: "wav",
        similarityStrength: 0.8,
        refinementFailureFixture: "cuda-oom"
      }
    });
    const failedRefinement = await waitForVoiceJob(failedRefinementJob);
    assert.equal(failedRefinement.status, "failed");
    assert.equal(failedRefinement.outputId, null);
    assert.match(failedRefinement.error, /cuda_out_of_memory/u);
    assert.equal(failedRefinement.diagnostics.speakerRefinement.fallbackSaved, false);
    assert.equal(failedRefinement.diagnostics.speakerRefinement.attempts.length, 2);
    assert.equal(failedRefinement.diagnostics.speakerRefinement.attempts[0].stage, "conversion");
    assert.equal(failedRefinement.diagnostics.speakerRefinement.attempts[0].code, "cuda_out_of_memory");

    const roughRefinementJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "这段细训语音需要拒绝持续的电子高频毛刺。",
      language: "zh",
      settings: {
        outputFormat: "wav",
        similarityStrength: 0.8,
        integrityFixture: "rough"
      }
    });
    const roughRefinement = await waitForVoiceJob(roughRefinementJob);
    assert.equal(roughRefinement.status, "failed");
    assert.equal(roughRefinement.outputId, null);
    assert.match(roughRefinement.error, /waveform_validation_failed/u);
    assert.equal(roughRefinement.diagnostics.speakerRefinement.attempts.at(-1).stage, "coverage-waveform-validation");
    assert.equal(roughRefinement.diagnostics.speakerRefinement.attempts.at(-1).code, "waveform_validation_failed");
    await fetch(`${appContext.url}/api/voice-clone/outputs/${encodeURIComponent(tts.result.output.id)}`, { method: "DELETE" });

    const speechForm = new FormData();
    speechForm.append("profileId", profile.id);
    speechForm.append("modelVersionId", built.result.profile.activeModelVersionId);
    speechForm.append("language", "auto");
    speechForm.append("settingsJson", JSON.stringify({
      conversionEngine: "seed-vc-svc-local",
      outputFormat: "wav",
      conversionRetryFixture: "fail-first"
    }));
    speechForm.append("sourceAudio", new Blob([makeWav(2.2)], { type: "audio/wav" }), "different-speaker.wav");
    const v2vJob = await postForm("/api/voice-clone/v2v", speechForm);
    const v2v = await waitForVoiceJob(v2vJob);
    assert.equal(v2v.status, "completed");
    assert.equal(v2v.result.output.engine, "seed-vc-svc-local");
    assert.equal(v2v.result.output.settings.conversionAttemptCount, 3);
    assert.equal(v2v.result.output.settings.targetBlendRatio, 0);
    assert.equal(v2v.result.output.settings.inferenceCfgRate, 0.5);
    assert.equal(v2v.result.output.settings.conversionCoverage, 1);
    assert.equal(v2v.result.output.settings.conversionStrictValidationAccepted, true);
    assert.equal(v2v.result.output.settings.sourceTranscriptTokenCount, 10);
    assert.equal(v2v.result.output.settings.requestedLanguage, "auto");
    assert.equal(v2v.result.output.settings.sourceDurationSeconds, 2);
    assert.equal(v2v.result.output.settings.convertedDurationSeconds, 2);
    assert.equal(v2v.result.output.settings.conversionOnsetLagMs, 0);
    await fetch(`${appContext.url}/api/voice-clone/outputs/${encodeURIComponent(v2v.result.output.id)}`, { method: "DELETE" });

    for (const conversionContractFixture of [
      "missing-source-count",
      "string-source-count",
      "zero-source-count",
      "duplicate-candidate",
      "partial-candidates",
      "invalid-observed-count",
      "duplicated-observed-count"
    ]) {
      const invalidForm = new FormData();
      invalidForm.append("profileId", profile.id);
      invalidForm.append("modelVersionId", built.result.profile.activeModelVersionId);
      invalidForm.append("language", "auto");
      invalidForm.append("settingsJson", JSON.stringify({ conversionEngine: "seed-vc-svc-local", conversionContractFixture }));
      invalidForm.append("sourceAudio", new Blob([makeWav(2.2)], { type: "audio/wav" }), `${conversionContractFixture}.wav`);
      const invalidJob = await postForm("/api/voice-clone/v2v", invalidForm);
      const invalid = await waitForVoiceJob(invalidJob);
      assert.equal(invalid.status, "failed", conversionContractFixture);
      assert.match(invalid.error, /validation returned/i);
    }

    for (const conversionAlignmentFixture of ["short-duration", "large-lag"]) {
      const unsafeTimingForm = new FormData();
      unsafeTimingForm.append("profileId", profile.id);
      unsafeTimingForm.append("modelVersionId", built.result.profile.activeModelVersionId);
      unsafeTimingForm.append("language", "auto");
      unsafeTimingForm.append("settingsJson", JSON.stringify({ conversionEngine: "seed-vc-svc-local", conversionAlignmentFixture }));
      unsafeTimingForm.append("sourceAudio", new Blob([makeWav(2.2)], { type: "audio/wav" }), `${conversionAlignmentFixture}.wav`);
      const unsafeTimingJob = await postForm("/api/voice-clone/v2v", unsafeTimingForm);
      const unsafeTiming = await waitForVoiceJob(unsafeTimingJob);
      assert.equal(unsafeTiming.status, "failed", conversionAlignmentFixture);
      assert.match(unsafeTiming.error, /timing|out of sync/i);
    }

    const alignedForm = new FormData();
    alignedForm.append("profileId", profile.id);
    alignedForm.append("modelVersionId", built.result.profile.activeModelVersionId);
    alignedForm.append("language", "auto");
    alignedForm.append("settingsJson", JSON.stringify({ conversionEngine: "seed-vc-svc-local", conversionAlignmentFixture: "correctable-lag" }));
    alignedForm.append("sourceAudio", new Blob([makeWav(2.2)], { type: "audio/wav" }), "correctable-lag.wav");
    const alignedJob = await postForm("/api/voice-clone/v2v", alignedForm);
    const aligned = await waitForVoiceJob(alignedJob);
    assert.equal(aligned.status, "completed");
    assert.equal(aligned.result.output.settings.conversionOnsetLagMs, 100);
    await fetch(`${appContext.url}/api/voice-clone/outputs/${encodeURIComponent(aligned.result.output.id)}`, { method: "DELETE" });

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("preserves the active voice for hard checkpoint failures and treats amplitude-only findings as advisory", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Fine Checkpoint Gate Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("metadataJson", JSON.stringify([{ transcript: "A complete prepared sentence for checkpoint quality validation.", transcriptLanguage: "en" }]));
    form.append("files", new Blob([makeWav(4)], { type: "audio/wav" }), "fine-gate.wav");
    await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const quickBuild = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "gpt-sovits-local",
      qualityMode: "quick"
    });
    const quick = await waitForVoiceJob(quickBuild);
    assert.equal(quick.status, "completed");
    const activeModelVersionId = quick.result.profile.activeModelVersionId;
    const previousFixture = process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_FINE_CHECKPOINT_INTEGRITY_FIXTURE;
    try {
      for (const [fixture, expectedReason] of [["missing", "ordered_text_coverage_low"], ["hum", "line_hum_detected"]]) {
        process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_FINE_CHECKPOINT_INTEGRITY_FIXTURE = fixture;
        const fineBuild = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
          engine: "gpt-sovits-local",
          qualityMode: "fine"
        });
        const failed = await waitForVoiceJob(fineBuild);
        assert.equal(failed.status, "failed");
        assert.match(failed.error, new RegExp(expectedReason));
        const refreshed = (await getJson("/api/voice-clone/profiles")).find((item) => item.id === profile.id);
        assert.equal(refreshed.activeModelVersionId, activeModelVersionId);
      }

      process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_FINE_CHECKPOINT_INTEGRITY_FIXTURE = "tremble";
      const advisoryBuild = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
        engine: "gpt-sovits-local",
        qualityMode: "fine"
      });
      const completed = await waitForVoiceJob(advisoryBuild);
      assert.equal(completed.status, "completed");
      assert.notEqual(completed.result.profile.activeModelVersionId, activeModelVersionId);
      const selection = completed.result.profile.voiceModel.trainingStats.gptCheckpointSelection;
      assert.equal(selection.selectedBy, "semantic-complete-least-modulated-fallback");
      assert.equal(selection.advisoryWaveformWarning, true);
      assert.equal(selection.accepted, false);
      assert.equal(selection.activated, true);
      assert.equal(selection.strictValidationAccepted, false);
      assert.deepEqual(completed.result.profile.voiceModel.trainingStats.gptCheckpointValidation[0].reasons, ["unstable_amplitude_detected"]);
    } finally {
      if (previousFixture === undefined) {
        delete process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_FINE_CHECKPOINT_INTEGRITY_FIXTURE;
      } else {
        process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_FINE_CHECKPOINT_INTEGRITY_FIXTURE = previousFixture;
      }
    }
    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("combines training sources added across multiple uploads into one Fine Clone dataset", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Multi-source Fine Voice",
      language: "zh",
      consentConfirmed: true
    });

    const firstUpload = new FormData();
    firstUpload.append("metadataJson", JSON.stringify([
      { transcript: "第一条独立训练来源。", transcriptLanguage: "zh" }
    ]));
    firstUpload.append("files", new Blob([makeWav(6.1)], { type: "audio/wav" }), "source-one.wav");
    const first = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, firstUpload);
    assert.equal(first.samples.length, 1);
    assert.equal(first.profile.sampleCount, 1);

    const secondUpload = new FormData();
    secondUpload.append("metadataJson", JSON.stringify([
      { transcript: "第二条独立训练来源。", transcriptLanguage: "zh" },
      { transcript: "第三条独立训练来源。", transcriptLanguage: "zh" }
    ]));
    secondUpload.append("files", new Blob([makeWav(6.4)], { type: "audio/wav" }), "source-two.wav");
    secondUpload.append("files", new Blob([makeWav(6.7)], { type: "audio/wav" }), "source-three.wav");
    const second = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, secondUpload);
    assert.equal(second.samples.length, 2);
    assert.equal(second.profile.sampleCount, 3);

    const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      engine: "gpt-sovits-local",
      qualityMode: "fine"
    });
    const built = await waitForVoiceJob(buildJob);
    assert.equal(built.status, "completed");
    assert.equal(built.result.profile.voiceModel.datasetSamples.length, 3);
    assert.equal(new Set(built.result.profile.voiceModel.datasetSamples.map((sample) => sample.sampleId)).size, 3);
    assert.deepEqual(
      built.result.profile.voiceModel.datasetSamples.map((sample) => sample.transcript),
      ["第一条独立训练来源。", "第二条独立训练来源。", "第三条独立训练来源。"]
    );
    assert.equal(built.result.profile.voiceModel.trainingStats.datasetSampleCount, 3);

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("uses the script language when TTS request language is auto", async () => {
    const outputDir = path.join(tempRoot, "voice-output-auto-language");
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Chinese Auto Voice",
      language: "zh",
      engine: "openvoice-v2-local",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("files", new Blob([makeWav(12.1)], { type: "audio/wav" }), "sample.wav");
    await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, { qualityMode: "quick" });
    const built = await waitForVoiceJob(buildJob);
    assert.equal(built.status, "completed");

    const ttsJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "Hello from this cloned voice.",
      language: "auto",
      outputDir,
      settings: { outputFormat: "wav" }
    });
    const tts = await waitForVoiceJob(ttsJob);
    assert.equal(tts.status, "completed");
    assert.equal(tts.result.output.language, "en");
    assert.equal(tts.result.output.settings.requestedLanguage, "auto");
    assert.equal(tts.result.output.settings.effectiveLanguage, "en");
    const metadata = JSON.parse(await fs.readFile(tts.result.output.metadataPath, "utf8"));
    assert.equal(metadata.requested_language, "auto");
    assert.equal(metadata.effective_language, "en");

    const retryJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "This is the first complete sentence. This is the second complete sentence.",
      language: "en",
      outputDir,
      settings: { outputFormat: "wav", integrityFixture: "clause-2-retry-once" }
    });
    const retried = await waitForVoiceJob(retryJob);
    assert.equal(retried.status, "completed");
    const secondClauseAttempts = retried.result.output.settings.synthesisIntegrity.clauses[1].attempts;
    assert.deepEqual(secondClauseAttempts.map((item) => item.accepted), [false, true]);
    assert.equal(secondClauseAttempts[0].preset.speed, 1);
    assert.equal(secondClauseAttempts[1].preset.speed, 0.965);

    await fetch(`${appContext.url}/api/voice-clone/outputs/${encodeURIComponent(tts.result.output.id)}`, { method: "DELETE" });
    await fetch(`${appContext.url}/api/voice-clone/outputs/${encodeURIComponent(retried.result.output.id)}`, { method: "DELETE" });
    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("blocks neural profile build when the worker runtime is missing", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Missing Runtime Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("files", new Blob([makeWav(12)], { type: "audio/wav" }), "sample.wav");
    await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);

    const currentFake = process.env.MAGIC_BOX_VOICE_ENGINE_FAKE;
    const currentFakeGpu = process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_GPU;
    delete process.env.MAGIC_BOX_VOICE_ENGINE_FAKE;
    delete process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_GPU;
    try {
      const health = await getJson("/api/voice-clone/health");
      assert.equal(health.workerReady, false);
      const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, { qualityMode: "quick" });
      const built = await waitForVoiceJob(buildJob);
      assert.equal(built.status, "failed");
      assert.match(built.error, /OpenVoice V2 local worker runtime is not ready/);
    } finally {
      process.env.MAGIC_BOX_VOICE_ENGINE_FAKE = currentFake;
      process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_GPU = currentFakeGpu;
      await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
    }
  });

  it("stores Voice Clone sample trim ranges and repaired uploaded filenames", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Trimmed Voice",
      language: "zh",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("trimStartSeconds", "0.5");
    form.append("trimEndSeconds", "2");
    form.append("files", new Blob([await makeMp3(4)], { type: "audio/mpeg" }), "丁真.mp3");

    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const sample = upload.samples[0];

    assert.equal(sample.originalFileName, "丁真.mp3");
    assert.equal(sample.format, "mp3");
    assert.equal(sample.sampleRate, 16000);
    assert.equal(sample.channels, 1);
    assert.equal(sample.trimApplied, true);
    assert.equal(sample.trimStartSeconds, 0.5);
    assert.equal(sample.trimEndSeconds, 2);
    assert.equal(sample.trimDurationSeconds, 1.5);
    assert.equal(sample.durationSeconds, 1.5);
    assert.equal(sample.preparation.runtime.sourceTrimApplied, true);
    assert.equal(sample.preparation.runtime.sourceTrimStartSeconds, 0.5);
    assert.equal(sample.preparation.runtime.sourceTrimEndSeconds, 2);
    assert.ok(sample.segments.every((segment) => segment.startSeconds >= 0 && segment.endSeconds <= 1.5));
    assert.match(sample.warnings.join(" "), /selected trim range/);
    assert.doesNotMatch(sample.warnings.join(" "), /Install FFmpeg/);
    assert.equal(upload.profile.sampleCount, 1);
    const sampleAudio = await fetch(`${appContext.url}/api/voice-clone/samples/${encodeURIComponent(sample.id)}/audio`);
    assert.equal(sampleAudio.status, 200);
    assert.match(sampleAudio.headers.get("content-type"), /audio\/mpeg/);

    const cancellationDbPath = path.join(tempRoot, "voice_clone", "voice_clone.json");
    const cancellationDb = JSON.parse(await fs.readFile(cancellationDbPath, "utf8"));
    const cancelledPreparedSample = cancellationDb.samples.find((item) => item.id === sample.id);
    cancelledPreparedSample.preparation.status = "cancelled";
    cancelledPreparedSample.preparation.failureMessage = "";
    await fs.writeFile(cancellationDbPath, JSON.stringify(cancellationDb, null, 2), "utf8");
    const cancelledProfile = (await getJson("/api/voice-clone/profiles")).find((item) => item.id === profile.id);
    assert.equal(cancelledProfile.preparedSourceCount, 0);
    assert.equal(cancelledProfile.samples.find((item) => item.id === sample.id).preparation.status, "cancelled");
    cancelledPreparedSample.preparation.status = "ready";
    await fs.writeFile(cancellationDbPath, JSON.stringify(cancellationDb, null, 2), "utf8");

    const staleAtFullRange = await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}`,
      { trimStartSeconds: null, trimEndSeconds: null }
    );
    assert.equal(staleAtFullRange.profile.preparedSourceCount, 0);
    assert.equal(staleAtFullRange.sample.preparation.status, "needs-attention");
    assert.equal(staleAtFullRange.sample.segments.length, 0);
    assert.match(staleAtFullRange.sample.preparation.warnings.join(" "), /selected source range changed/i);

    const restoredRange = await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}`,
      { trimStartSeconds: 0.5, trimEndSeconds: 2 }
    );
    assert.equal(restoredRange.profile.preparedSourceCount, 1);
    assert.equal(restoredRange.sample.preparation.status, "ready");
    assert.ok(restoredRange.sample.segments.length > 0);

    const staleAtDifferentRange = await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}`,
      { trimStartSeconds: 0.75, trimEndSeconds: 1.75 }
    );
    assert.equal(staleAtDifferentRange.profile.preparedSourceCount, 0);
    assert.equal(staleAtDifferentRange.sample.segments.length, 0);

    await patchJson(
      `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples/${encodeURIComponent(sample.id)}`,
      { trimStartSeconds: 0.5, trimEndSeconds: 2 }
    );

    const dbPath = path.join(tempRoot, "voice_clone", "voice_clone.json");
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const legacySample = db.samples.find((item) => item.id === sample.id);
    const insideSegment = {
      ...legacySample.segments[0],
      id: "legacy-inside",
      startSeconds: 0.5,
      endSeconds: 2,
      durationSeconds: 1.5
    };
    legacySample.segments = [
      { ...insideSegment, id: "legacy-before-range", startSeconds: 0, endSeconds: 0.4, durationSeconds: 0.4 },
      insideSegment,
      { ...insideSegment, id: "legacy-after-range", startSeconds: 2.1, endSeconds: 3, durationSeconds: 0.9 }
    ];
    delete legacySample.preparation.runtime.sourceTrimApplied;
    delete legacySample.preparation.runtime.sourceTrimStartSeconds;
    delete legacySample.preparation.runtime.sourceTrimEndSeconds;
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");

    const legacyProfile = (await getJson("/api/voice-clone/profiles")).find((item) => item.id === profile.id);
    const legacyPublicSample = legacyProfile.samples.find((item) => item.id === sample.id);
    assert.deepEqual(legacyPublicSample.segments.map((segment) => segment.id), ["legacy-inside"]);
    assert.equal(legacyPublicSample.segments[0].startSeconds, 0);
    assert.equal(legacyPublicSample.segments[0].endSeconds, 1.5);

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
  });

  it("creates, analyzes, builds, and deletes a Voice Clone profile", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Test Voice",
      language: "en",
      consentConfirmed: true
    });

    assert.equal(profile.name, "Test Voice");
    assert.equal(profile.status, "draft");

    const form = new FormData();
    form.append("files", new Blob([makeWav(12.4)], { type: "audio/wav" }), "sample.wav");
    const upload = await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    assert.equal(upload.samples.length, 1);
    assert.equal(upload.profile.sampleCount, 1);
    assert.equal(upload.samples[0].format, "wav");

    const analyzeJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/analyze`, {});
    const analyzed = await waitForVoiceJob(analyzeJob);
    assert.equal(analyzed.status, "completed");
    assert.equal(analyzed.result.profile.status, "analyzed");

    const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, { qualityMode: "quick" });
    const built = await waitForVoiceJob(buildJob);
    assert.equal(built.status, "completed");
    assert.equal(built.result.profile.status, "ready");
    assert.equal(built.result.profile.modelVersions.length, 1);
    assert.equal(built.result.profile.modelVersions[0].active, true);
    const firstVersionId = built.result.profile.activeModelVersionId;
    const firstModelPath = built.result.profile.voiceModel.modelPath;

    const analyzeAgainJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/analyze`, {});
    const analyzedAgain = await waitForVoiceJob(analyzeAgainJob);
    assert.equal(analyzedAgain.status, "completed");
    assert.equal(analyzedAgain.result.profile.status, "ready");
    assert.equal(analyzedAgain.result.profile.activeModelVersionId, firstVersionId);

    const secondBuildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, { qualityMode: "quick" });
    const secondBuilt = await waitForVoiceJob(secondBuildJob);
    assert.equal(secondBuilt.status, "completed");
    assert.equal(secondBuilt.result.profile.modelVersions.length, 2);
    assert.notEqual(secondBuilt.result.profile.activeModelVersionId, firstVersionId);
    const secondVersionId = secondBuilt.result.profile.activeModelVersionId;
    const secondModelPath = secondBuilt.result.profile.voiceModel.modelPath;

    const restored = await patchJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/model-version`, {
      versionId: firstVersionId
    });
    assert.equal(restored.status, "ready");
    assert.equal(restored.activeModelVersionId, firstVersionId);
    assert.equal(restored.voiceModel.modelPath, firstModelPath);
    assert.equal(restored.modelVersions.filter((item) => item.active).length, 1);

    const activeDeleteResponse = await fetch(
      `${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/model-versions/${encodeURIComponent(firstVersionId)}`,
      { method: "DELETE" }
    );
    assert.equal(activeDeleteResponse.status, 409);
    assert.match((await activeDeleteResponse.json()).error, /currently in use/i);

    const deleteVersionResponse = await fetch(
      `${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/model-versions/${encodeURIComponent(secondVersionId)}`,
      { method: "DELETE" }
    );
    assert.equal(deleteVersionResponse.status, 200);
    const deletedVersion = await deleteVersionResponse.json();
    assert.equal(deletedVersion.deletedVersionId, secondVersionId);
    assert.equal(deletedVersion.profile.modelVersions.length, 1);
    assert.equal(deletedVersion.profile.activeModelVersionId, firstVersionId);
    await assert.rejects(fs.access(secondModelPath));

    const voiceDbFile = path.join(path.dirname(process.env.MAGIC_BOX_SETTINGS_FILE), "voice_clone", "voice_clone.json");
    const savedDb = JSON.parse(await fs.readFile(voiceDbFile, "utf8"));
    const savedProfile = savedDb.profiles.find((item) => item.id === profile.id);
    savedProfile.status = "analyzed";
    savedProfile.engine = "";
    savedProfile.qualityMode = "";
    savedProfile.voiceModel = null;
    savedProfile.modelVersion = "";
    savedProfile.activeModelVersionId = firstVersionId;
    await fs.writeFile(voiceDbFile, JSON.stringify(savedDb, null, 2), "utf8");

    const repairedProfiles = await getJson("/api/voice-clone/profiles");
    const repairedProfile = repairedProfiles.find((item) => item.id === profile.id);
    assert.equal(repairedProfile.status, "ready");
    assert.equal(repairedProfile.activeModelVersionId, firstVersionId);
    assert.equal(repairedProfile.voiceModel.modelPath, firstModelPath);
    assert.equal(repairedProfile.modelVersions.filter((item) => item.active).length, 1);

    const repairedTtsJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "Saved profile versions should generate without rebuilding.",
      language: "auto",
      settings: { outputFormat: "wav" }
    });
    const repairedTts = await waitForVoiceJob(repairedTtsJob);
    assert.equal(repairedTts.status, "completed");
    await fetch(`${appContext.url}/api/voice-clone/outputs/${encodeURIComponent(repairedTts.result.output.id)}`, { method: "DELETE" });

    await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
    const profiles = await getJson("/api/voice-clone/profiles");
    assert.equal(profiles.some((item) => item.id === profile.id), false);
  });

  it("validates Voice Clone sample upload types", async () => {
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Upload Guard",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("files", new Blob([Buffer.from("nope")], { type: "text/plain" }), "notes.txt");

    await assert.rejects(
      postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form),
      /Unsupported sample type/
    );

    const trimForm = new FormData();
    trimForm.append("trimStartSeconds", "2");
    trimForm.append("trimEndSeconds", "1");
    trimForm.append("files", new Blob([makeWav(3)], { type: "audio/wav" }), "sample.wav");

    await assert.rejects(
      postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, trimForm),
      /Trim end/
    );
  });

  it("streams Voice Clone ingress with strict aliases, bounded bodies, and durable cleanup", async () => {
    const request = async (pathname, init = {}) => {
      const response = await fetch(`${appContext.url}${pathname}`, init);
      return { response, payload: await response.json().catch(() => ({})) };
    };
    const { voiceRoot, durableProfilePath, orphanIngressPath, orphanJobPath } = voiceIngressFixture;
    assert.equal(await fs.readFile(durableProfilePath, "utf8"), "do-not-delete");
    await assert.rejects(fs.stat(orphanIngressPath), { code: "ENOENT" });
    await assert.rejects(fs.stat(orphanJobPath), { code: "ENOENT" });

    const profileResponse = await request("/api/voice-clone/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ingress guard", language: "en", consentConfirmed: true })
    });
    assert.equal(profileResponse.response.status, 201);
    const profile = profileResponse.payload;

    const validForm = new FormData();
    validForm.append("metadata", JSON.stringify([{ transcript: "Safe local sample", transcriptLanguage: "en" }]));
    validForm.append("trim_start_seconds", "0");
    validForm.append("files", new Blob([makeWav(0.1)], { type: "audio/wav" }), "sample.wav");
    const validUpload = await request(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, { method: "POST", body: validForm });
    assert.equal(validUpload.response.status, 202);
    assert.equal(validUpload.payload.job.type, "prepare-profile-source");
    assert.equal(validUpload.payload.samples.length, 1);
    const originalFiles = await fs.readdir(path.join(voiceRoot, "profiles", profile.id, "samples", "original"));
    assert.equal(originalFiles.length, 1);
    assert.deepEqual(await fs.readdir(path.join(voiceRoot, "temp", "ingress")).catch(() => []), []);

    const oversizedFile = new FormData();
    oversizedFile.append("files", new Blob([Buffer.alloc((4 * 1024 * 1024) + 1)], { type: "audio/wav" }), "too-large.wav");
    const fileTooLarge = await request(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, { method: "POST", body: oversizedFile });
    assert.equal(fileTooLarge.response.status, 413);
    assert.equal(fileTooLarge.payload.code, "file_too_large");

    const oversizedBody = new FormData();
    oversizedBody.append("profile_id", profile.id);
    oversizedBody.append("txt_file", new Blob([Buffer.from("local text")], { type: "text/plain" }), "script.txt");
    const batchTooLarge = await request("/api/voice-clone/tts-file", { method: "POST", body: oversizedBody });
    assert.equal(batchTooLarge.response.status, 413);
    assert.equal(batchTooLarge.payload.code, "batch_too_large");

    const unexpectedField = new FormData();
    unexpectedField.append("rogue", "nope");
    unexpectedField.append("files", new Blob([makeWav(0.1)], { type: "audio/wav" }), "sample.wav");
    const invalidField = await request(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, { method: "POST", body: unexpectedField });
    assert.equal(invalidField.response.status, 400);
    assert.equal(invalidField.payload.code, "invalid_field");

    const songTranscript = new FormData();
    songTranscript.append("profileId", profile.id);
    songTranscript.append("transcript", "not accepted by song replacement");
    songTranscript.append("source_song", new Blob([makeWav(0.1)], { type: "audio/wav" }), "song.wav");
    const rejectedSongTranscript = await request("/api/voice-clone/song-v2v", { method: "POST", body: songTranscript });
    assert.equal(rejectedSongTranscript.response.status, 400);
    assert.equal(rejectedSongTranscript.payload.code, "invalid_field");
    assert.deepEqual(await fs.readdir(path.join(voiceRoot, "temp", "ingress")).catch(() => []), []);
  });

  it("generates OpenVoice-style TTS and V2V outputs with metadata and history", async () => {
    const outputDir = path.join(tempRoot, "voice-output");
    const profile = await postJson("/api/voice-clone/profiles", {
      name: "Generated Voice",
      language: "en",
      consentConfirmed: true
    });
    const form = new FormData();
    form.append("files", new Blob([makeWav(12.2)], { type: "audio/wav" }), "sample.wav");
    await postForm(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, form);
    const buildJob = await postJson(`/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, { qualityMode: "quick" });
    const built = await waitForVoiceJob(buildJob);
    assert.equal(built.status, "completed");
    assert.equal(built.result.profile.engine, "openvoice-v2-local");
    assert.equal(built.result.profile.voiceModel.engine, "openvoice-v2-local");
    assert.equal(built.result.profile.voiceModel.modelVersion, "openvoice-v2-fake-ci");
    assert.ok(built.result.profile.voiceModel.speakerEmbeddingPath);

    const ttsJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "(excited) Let's go!",
      language: "en",
      outputDir,
      settings: { outputFormat: "wav" }
    });
    const tts = await waitForVoiceJob(ttsJob);
    assert.equal(tts.status, "completed");
    assert.equal(tts.result.output.aiGenerated, true);
    assert.equal(tts.result.output.engine, "openvoice-v2-local");
    assert.equal(tts.result.output.settings.modelVersion, "openvoice-v2-fake-ci");
    assert.equal(tts.result.warnings.some((warning) => warning.includes("first-party signal-matching")), false);
    const ttsFile = await fs.readFile(tts.result.output.outputPath);
    assert.equal(ttsFile.toString("ascii", 0, 4), "RIFF");
    const metadata = JSON.parse(await fs.readFile(tts.result.output.metadataPath, "utf8"));
    assert.equal(metadata.ai_generated, true);
    assert.equal(metadata.mode, "tts");
    assert.equal(metadata.engine, tts.result.output.engine);
    assert.equal(metadata.model_version, "openvoice-v2-fake-ci");

    const sourceForm = new FormData();
    sourceForm.append("profileId", profile.id);
    sourceForm.append("language", "en");
    sourceForm.append("outputDir", outputDir);
    sourceForm.append("settingsJson", JSON.stringify({ outputFormat: "wav" }));
    sourceForm.append("sourceAudio", new Blob([makeWav(2.1)], { type: "audio/wav" }), "source.wav");
    const v2vJob = await postForm("/api/voice-clone/v2v", sourceForm);
    const v2v = await waitForVoiceJob(v2vJob);
    assert.equal(v2v.status, "completed");
    assert.equal(v2v.result.output.mode, "v2v");
    assert.equal(v2v.result.output.engine, "openvoice-v2-local");

    const history = await getJson("/api/voice-clone/history");
    assert.ok(history.some((item) => item.id === tts.result.output.id));
    assert.ok(history.some((item) => item.id === v2v.result.output.id));

    const concurrentJobs = await Promise.all([
      postJson("/api/voice-clone/tts", {
        profileId: profile.id,
        text: "The first concurrent voice output must remain in History.",
        language: "en",
        settings: { outputFormat: "wav", fakeDelayMs: 300 }
      }),
      postJson("/api/voice-clone/tts", {
        profileId: profile.id,
        text: "The second concurrent voice output must remain in History.",
        language: "en",
        settings: { outputFormat: "wav", fakeDelayMs: 300 }
      })
    ]);
    const concurrentOutputs = await Promise.all(concurrentJobs.map(waitForVoiceJob));
    assert.ok(concurrentOutputs.every((item) => item.status === "completed"));
    const historyAfterConcurrent = await getJson("/api/voice-clone/history");
    for (const item of concurrentOutputs) {
      assert.ok(historyAfterConcurrent.some((output) => output.id === item.result.output.id));
      await fetch(`${appContext.url}/api/voice-clone/outputs/${encodeURIComponent(item.result.output.id)}`, { method: "DELETE" });
    }

    const audioResponse = await fetch(`${appContext.url}${tts.result.output.audioUrl}`);
    assert.equal(audioResponse.status, 200);
    assert.match(audioResponse.headers.get("content-type"), /audio\/wav/);

    const deleteResponse = await fetch(`${appContext.url}/api/voice-clone/outputs/${encodeURIComponent(tts.result.output.id)}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 204);
    const nextHistory = await getJson("/api/voice-clone/history");
    assert.equal(nextHistory.some((item) => item.id === tts.result.output.id), false);

    const historyBeforeProfileDelete = await getJson("/api/voice-clone/history");
    const lateJob = await postJson("/api/voice-clone/tts", {
      profileId: profile.id,
      text: "This late output must not survive profile deletion.",
      language: "en",
      settings: { outputFormat: "wav", fakeDelayMs: 1200 }
    });
    const deletedProfile = await fetch(`${appContext.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
    assert.equal(deletedProfile.status, 204);
    const late = await waitForVoiceJob(lateJob);
    assert.equal(late.status, "failed");
    const historyAfterProfileDelete = await getJson("/api/voice-clone/history");
    assert.equal(historyAfterProfileDelete.length, historyBeforeProfileDelete.length);
  });
});

describe("Magic Box server helpers", () => {
  it("computes public profile lineage from only that profile's samples", () => {
    const profile = {
      id: "profile-lineage-a",
      name: "Profile A",
      language: "zh",
      qualityMode: "fine",
      engine: "gpt-sovits-local",
      voiceModel: {
        engine: "gpt-sovits-local",
        qualityMode: "fine",
        trainingParameters: {}
      }
    };
    const ownSample = { id: "sample-a", profileId: profile.id, createdAt: "2026-08-24T00:00:00.000Z" };
    const unrelatedSample = { id: "sample-b", profileId: "profile-lineage-b", createdAt: "2026-08-24T00:00:00.000Z" };
    profile.voiceModel.datasetSnapshotHash = voiceCloneLineage(profile, [ownSample]).currentSnapshotHash;

    const result = publicVoiceProfile(profile, [ownSample, unrelatedSample]);

    assert.equal(result.voiceCloneLineage.modelState, "active");
    assert.equal(result.voiceCloneLineage.currentSnapshotHash, profile.voiceModel.datasetSnapshotHash);
  });

  it("resolves a voice output file to its containing folder when requested", () => {
    const filePath = path.join("C:\\MagicBox", "voice-clone-outputs", "2026-08-24", "output.wav");
    assert.equal(
      resolveLocalOpenTarget(filePath, { openFolder: true, isFile: true }),
      path.dirname(filePath)
    );
    assert.equal(
      resolveLocalOpenTarget(filePath, { openFolder: false, isFile: true }),
      filePath
    );
    assert.equal(
      resolveLocalOpenTarget(path.dirname(filePath), { openFolder: true, isFile: false }),
      path.dirname(filePath)
    );
  });

  it("allows a locally usable Song phrase repair to reach strict full-stem verification", () => {
    const realShortRepairMetrics = {
      durationDeltaPercent: 0.4237,
      onsetLagMs: 10,
      voicedDropoutPercent: 7.438,
      pitchOver100CentsPercent: 2.6786,
      abruptPitchJumpCount: 2,
      sourceTargetSimilarity: 0.353931,
      targetSimilarity: 0.482081,
      targetSimilarityFloor: 0.55
    };
    assert.equal(isSeedSongRepairCandidateUsable({ metrics: realShortRepairMetrics }), true);
    assert.equal(isSeedSongRepairCandidateUsable({
      metrics: { ...realShortRepairMetrics, abruptPitchJumpCount: 4 }
    }), false);
    assert.equal(isSeedSongRepairCandidateUsable({
      metrics: { ...realShortRepairMetrics, targetSimilarity: 0.39 }
    }), false);
    assert.equal(isSeedSongRepairCandidateUsable({
      metrics: {
        ...realShortRepairMetrics,
        sourceTargetSimilarity: 0.85,
        targetSimilarity: 0.84,
        targetSimilarityFloor: 0.82
      }
    }), true);
    assert.equal(isSeedSongRepairCandidateUsable({
      metrics: {
        ...realShortRepairMetrics,
        sourceTargetSimilarity: 0.45,
        targetSimilarity: 0.49,
        targetSimilarityFloor: 0.6
      }
    }), false);
  });

  it("recognizes the owner-reported full-song metrics as a usable advisory fallback", () => {
    const ownerReportedMetrics = {
      sourceDurationSeconds: 273.1947,
      convertedDurationSeconds: 273.1944,
      durationDeltaPercent: 0.0001,
      onsetLagMs: 10,
      sourceVoicedFrames: 19792,
      pairedVoicedFrames: 19554,
      voicedDropoutPercent: 1.2025,
      medianPitchErrorCents: 8.938,
      pitchOver100CentsPercent: 1.8922,
      abruptPitchJumpCount: 54,
      abruptPitchJumpsPerMinute: 11.8597,
      sourceTargetSimilarity: 0.244066,
      targetSimilarity: 0.605314,
      targetSimilarityFloor: 0.55,
      targetReferenceCount: 3
    };
    const ownerReportedValidation = {
      accepted: false,
      score: 0.402775,
      reasons: ["pitch_discontinuity", "localized_pitch_failure"],
      metrics: ownerReportedMetrics
    };
    assert.equal(isSeedSongAdvisoryCandidateUsable(ownerReportedValidation), true);
    assert.equal(isSeedSongStrictlyAccepted(ownerReportedValidation), false);
    assert.equal(isSeedSongAdvisoryCandidateUsable({
      ...ownerReportedValidation,
      metrics: { ...ownerReportedMetrics, voicedDropoutPercent: 9 }
    }), false);
    assert.equal(isSeedSongAdvisoryCandidateUsable({
      ...ownerReportedValidation,
      metrics: { ...ownerReportedMetrics, targetSimilarity: 0.49 }
    }), false);
    assert.equal(isSeedSongAdvisoryCandidateUsable({
      ...ownerReportedValidation,
      reasons: ["target_identity_weak"]
    }), false);
    assert.equal(isSeedSongAdvisoryCandidateUsable({
      ...ownerReportedValidation,
      metrics: { ...ownerReportedMetrics, targetSimilarity: null }
    }), false);
    assert.equal(isSeedSongAdvisoryCandidateUsable({
      ...ownerReportedValidation,
      metrics: { ...ownerReportedMetrics, voicedDropoutPercent: "1.2" }
    }), false);
    assert.equal(isSeedSongAdvisoryCandidateUsable({
      ...ownerReportedValidation,
      metrics: { ...ownerReportedMetrics, medianPitchErrorCents: -1 }
    }), false);
    assert.equal(isSeedSongAdvisoryCandidateUsable({
      ...ownerReportedValidation,
      metrics: { ...ownerReportedMetrics, abruptPitchJumpCount: -5 }
    }), false);
    assert.equal(isSeedSongAdvisoryCandidateUsable({
      ...ownerReportedValidation,
      metrics: { ...ownerReportedMetrics, sourceTargetSimilarity: 2 }
    }), false);
    assert.equal(isSeedSongAdvisoryCandidateUsable({
      ...ownerReportedValidation,
      score: "0.4"
    }), false);
  });

  it("aborts Song FFmpeg work promptly when its job is cancelled", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const running = runFfmpegVoiceCommand([
      "-re",
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=20",
      "-f", "null",
      "-"
    ], { timeoutMs: 30000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(running, (error) => error?.name === "AbortError" || error?.code === "ABORT_ERR");
    assert.ok(Date.now() - startedAt < 3000);
  });

  it("builds a truthful 12-18 second Song target reference from contributing clips", () => {
    const selected = selectSeedSongReferenceClips([
      { audioPath: "one.wav", durationSeconds: 2.5 },
      { audioPath: "two.wav", durationSeconds: 2.5 },
      { audioPath: "three.wav", durationSeconds: 2.5 },
      { audioPath: "four.wav", durationSeconds: 5.5 },
      { audioPath: "unused.wav", durationSeconds: 6 }
    ]);
    assert.equal(selected.durationSeconds, 13);
    assert.deepEqual(selected.clips.map((clip) => clip.audioPath), ["one.wav", "two.wav", "three.wav", "four.wav"]);
    assert.equal(selected.clips.every((clip) => clip.contributionSeconds > 0), true);
    const insufficient = selectSeedSongReferenceClips([
      { audioPath: "short-one.wav", durationSeconds: 2.5 },
      { audioPath: "short-two.wav", durationSeconds: 2.5 }
    ]);
    assert.deepEqual(insufficient, { clips: [], durationSeconds: 0 });
  });

  it("selects Fine checkpoints strictly first and fails closed around advisory waveform metrics", () => {
    const advisory = (source, modulationScore, overrides = {}) => ({
      source,
      path: `${source}.ckpt`,
      durationScore: 0.2,
      durationAccepted: true,
      coverage: 1,
      accepted: false,
      reasons: ["unstable_amplitude_detected"],
      waveformHealth: { modulationScore },
      ...overrides
    });

    const ranked = selectFineCheckpointCandidate([
      advisory("new-e15", 0.62, { durationScore: 0.01 }),
      advisory("new-e5", 0.31, { durationScore: 0.9 }),
      advisory("new-e10", 0.48, { durationScore: 0.1 })
    ]);
    assert.equal(ranked.advisoryWaveformFallback, true);
    assert.equal(ranked.selected.source, "new-e5");

    const strict = advisory("new-e10", 0.7, { accepted: true, reasons: [], durationScore: 0.8 });
    const strictFirst = selectFineCheckpointCandidate([advisory("new-e5", 0.1), strict]);
    assert.equal(strictFirst.advisoryWaveformFallback, false);
    assert.equal(strictFirst.selected.source, "new-e10");

    for (const invalidScore of [undefined, null, Number.NaN, "0.3", -0.01, 1.01]) {
      assert.equal(selectFineCheckpointCandidate([advisory("new-e5", invalidScore)]).selected, null);
    }
    const hardFailures = [
      advisory("new-e5", 0.3, { reasons: ["unstable_amplitude_detected", "line_hum_detected"] }),
      advisory("new-e5", 0.3, { reasons: ["unstable_amplitude_detected", "speech_activity_low"] }),
      advisory("new-e5", 0.3, { coverage: 0.91 }),
      advisory("new-e5", 0.3, { durationAccepted: false })
    ];
    for (const report of hardFailures) {
      assert.equal(selectFineCheckpointCandidate([report]).selected, null);
    }
  });

  it("caps compact history to the newest 100 entries", () => {
    const history = Array.from({ length: 105 }, (_item, index) => ({ id: `item-${index}` }));
    const compacted = compactHistory(history);
    assert.equal(compacted.length, 100);
    assert.equal(compacted[0].id, "item-0");
    assert.equal(compacted.at(-1).id, "item-99");
  });

  it("normalizes WebP preferred filenames when PNG output is used", () => {
    assert.equal(filenameWithOutputExtension("cover.webp", "image/png"), "cover.png");
    assert.equal(filenameWithOutputExtension("cover", "image/png"), "cover.png");
    assert.equal(filenameWithOutputExtension("cover.jpg", "image/jpeg"), "cover.jpg");
    assert.equal(filenameWithOutputExtension("animated.jpg", "image/webp"), "animated.webp");
  });

  it("applies torrent file selections by index", () => {
    const calls = [];
    const torrent = {
      files: [0, 1, 2].map((index) => ({
        select: () => calls.push(`select-${index}`),
        deselect: () => calls.push(`deselect-${index}`)
      }))
    };

    const selected = applyTorrentFileSelection(torrent, [0, 2, 2, 99]);
    assert.deepEqual(selected, [0, 2]);
    assert.deepEqual(calls, ["select-0", "deselect-1", "select-2"]);
  });

  it("falls back to browser rendering for recoverable video page transport failures", () => {
    assert.equal(shouldRenderVideoPageAfterFetchError({ code: "ETIMEDOUT" }), true);
    assert.equal(shouldRenderVideoPageAfterFetchError({ code: "ENOTFOUND" }), true);
    assert.equal(shouldRenderVideoPageAfterFetchError({ statusCode: 504 }), true);
    assert.equal(shouldRenderVideoPageAfterFetchError({ accessBlocked: true, statusCode: 403 }), false);
    assert.equal(shouldRenderVideoPageAfterFetchError({ code: "INVALID_URL" }), false);
  });
});
