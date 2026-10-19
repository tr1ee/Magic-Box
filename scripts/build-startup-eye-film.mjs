// Bake the eyelids into one color-calibrated portrait, then interpolate motion.
// No runtime alpha stack or eye patches are needed by the startup component.
// Usage: node scripts/build-startup-eye-film.mjs [--manifest poses.json] [--work-dir /tmp/…]
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const WIDTH = 588;
const HEIGHT = 1130;
const CHANNELS = 3;
const FPS = 60;
const FRAME_COUNT = 96;
const CLOSED_HOLD = 0.15;
const OPENING_SECONDS = 1.22;
const CROP = { left: 160, top: 220, width: 340, height: 220 };
const EYES = [
  { cx: 256, cy: 319, rx: 74, ry: 60, angle: 17 },
  { cx: 402, cy: 354, rx: 76, ry: 58, angle: 10 }
];
const DEFAULT_POSES = [
  [0, "magic-box-girl-closed.png"], [10, "magic-box-eye-slit-v4.webp"],
  // Filenames retain the generation brief; measured aperture determines order.
  [25, "magic-box-girl-quarter.png"], [20, "magic-box-eye-twenty-v6.webp"],
  [40, "magic-box-eye-mid-v4.webp"], [50, "magic-box-eye-fifty-v6.webp"],
  [60, "magic-box-girl-half.png"], [68, "magic-box-eye-sixtyeight-v6.webp"],
  [75, "magic-box-eye-three-quarter-v4.webp"], [90, "magic-box-eye-almost-v4.webp"],
  [82, "magic-box-eye-eightytwo-v6.webp"], [100, "magic-box-girl.jpg"]
].map(([amount, name]) => ({ amount, src: `public/assets/${name}` }));

function argument(name, fallback) {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
}

function ellipseRadius(x, y, eye) {
  const radians = eye.angle * Math.PI / 180;
  const dx = x - eye.cx;
  const dy = y - eye.cy;
  const ex = (dx * Math.cos(radians) + dy * Math.sin(radians)) / eye.rx;
  const ey = (-dx * Math.sin(radians) + dy * Math.cos(radians)) / eye.ry;
  return Math.hypot(ex, ey);
}

function smoothstep(value) { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); }
function median(values) { values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)] ?? 0; }
function clamp(value) { return Math.min(255, Math.max(0, Math.round(value))); }

function irisOpeningScore(frame) {
  let score = 0;
  for (const eye of EYES) for (let y = eye.cy - 40; y < eye.cy + 40; y++) for (let x = eye.cx - 45; x < eye.cx + 45; x++) {
    const p = (y * WIDTH + x) * CHANNELS;
    const [r, g, b] = frame.subarray(p, p + CHANNELS);
    // The original and all edited poses retain the same pink irises.
    if (r > g + 20 && b > g + 12 && r > b - 15 && r > 100) score++;
  }
  return score;
}

async function pixels(src) {
  return sharp(path.resolve(ROOT, src)).resize(WIDTH, HEIGHT, { fit: "fill", kernel: "lanczos3" })
    .removeAlpha().toColourspace("srgb").raw().toBuffer();
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", data => { errors = (errors + data).slice(-16000); });
    child.once("error", reject);
    child.once("close", code => code ? reject(new Error(`${path.basename(command)} exited ${code}: ${errors}`)) : resolve());
  });
}

const manifest = argument("--manifest");
const poses = manifest ? JSON.parse(await fs.readFile(path.resolve(ROOT, manifest), "utf8")) : DEFAULT_POSES;
assert(poses.length >= 4 && poses[0].amount === 0 && poses.at(-1).amount === 100, "Poses must span closed to open.");
assert(poses.every(pose => pose.amount >= 0 && pose.amount <= 100), "Pose generation briefs must use an aperture from 0 to 100.");
const explicitWorkDir = argument("--work-dir");
const workDir = path.resolve(explicitWorkDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-eye-film-v6-")));
const output = path.resolve(argument("--output", "public/assets/magic-box-eye-opening-v6.mp4"));
const poster = path.resolve(argument("--poster", "public/assets/magic-box-eye-opening-v6.webp"));
await fs.mkdir(workDir, { recursive: true });
for (const sub of ["keys", "flow", "frames"]) await fs.mkdir(path.join(workDir, sub), { recursive: true });
const original = await pixels("public/assets/magic-box-girl.jpg");
const alpha = new Float32Array(WIDTH * HEIGHT);
const radii = new Float32Array(WIDTH * HEIGHT);
for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
  const radius = Math.min(...EYES.map(eye => ellipseRadius(x + 0.5, y + 0.5, eye)));
  radii[y * WIDTH + x] = radius;
  alpha[y * WIDTH + x] = 1 - smoothstep((radius - 0.88) / 0.12);
}

function calibration(source) {
  const samples = [[], [], []];
  for (let i = 0; i < alpha.length; i++) {
    // A skin-only ring avoids sampling the moving lashes, iris, or dark bangs.
    if (radii[i] < 0.76 || radii[i] > 1.12) continue;
    const p = i * CHANNELS;
    const [r, g, b] = original.subarray(p, p + CHANNELS);
    if (r < 90 || g < 105 || b < 105 || r / g < 0.7 || b / g > 1.18 || Math.max(r, g, b) - Math.min(r, g, b) > 65) continue;
    if ([0, 1, 2].some(c => Math.abs(original[p + c] - source[p + c]) > 35)) continue;
    for (let c = 0; c < CHANNELS; c++) samples[c].push(original[p + c] - source[p + c]);
  }
  assert(samples[0].length > 150, "Insufficient unchanged skin for color calibration.");
  return { rgbDelta: samples.map(median), sampleCount: samples[0].length };
}

const metrics = { width: WIDTH, height: HEIGHT, fps: FPS, frameCount: FRAME_COUNT, duration: FRAME_COUNT / FPS,
  closedHold: CLOSED_HOLD, openingSeconds: OPENING_SECONDS, poses: [], outsideChangedPixels: 0, finalFrameExactOriginal: false };
const composed = [];
for (const pose of poses) {
  const source = await pixels(pose.src);
  const correction = pose.amount === 100 ? { rgbDelta: [0, 0, 0], sampleCount: 0 } : calibration(source);
  const frame = Buffer.from(original);
  if (pose.amount !== 100) for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] === 0) continue;
    const p = i * CHANNELS;
    for (let c = 0; c < CHANNELS; c++) frame[p + c] = clamp(original[p + c] * (1 - alpha[i]) + clamp(source[p + c] + correction.rgbDelta[c]) * alpha[i]);
  }
  for (let i = 0; i < alpha.length; i++) if (alpha[i] === 0) for (let c = 0; c < CHANNELS; c++) assert(frame[i * CHANNELS + c] === original[i * CHANNELS + c]);
  const boundaryErrors = [];
  for (let i = 0; i < alpha.length; i++) {
    if (radii[i] < 0.99 || radii[i] > 1.01) continue;
    const p = i * CHANNELS;
    boundaryErrors.push((Math.abs(frame[p] - original[p]) + Math.abs(frame[p + 1] - original[p + 1]) + Math.abs(frame[p + 2] - original[p + 2])) / CHANNELS);
  }
  composed.push(frame);
  metrics.poses.push({ amount: pose.amount, src: pose.src, ...correction,
    boundaryMeanAbsoluteRgbError: boundaryErrors.reduce((a, b) => a + b, 0) / boundaryErrors.length,
    irisOpeningScore: irisOpeningScore(frame) });
  await sharp(frame, { raw: { width: WIDTH, height: HEIGHT, channels: CHANNELS } }).png()
    .toFile(path.join(workDir, "keys", `${String(composed.length - 1).padStart(3, "0")}.png`));
}
await sharp(composed[0], { raw: { width: WIDTH, height: HEIGHT, channels: CHANNELS } }).webp({ quality: 95 }).toFile(poster);
const ffmpeg = path.resolve("node_modules/ffmpeg-static/ffmpeg");
const openingRange = metrics.poses.at(-1).irisOpeningScore - metrics.poses[0].irisOpeningScore;
assert(openingRange > 0, "The original iris must be more open than the closed pose.");
let keyTime = 0;
const concat = ["ffconcat version 1.0"];
for (let i = 0; i < poses.length; i++) {
  const irisDelta = i === poses.length - 1 ? 0 : metrics.poses[i + 1].irisOpeningScore - metrics.poses[i].irisOpeningScore;
  assert(irisDelta >= 0, `Pose ${i + 1} would visibly close the eyes again; reorder the manifest.`);
  metrics.poses[i].at = keyTime;
  // Keep every pose for at least ~2.3 frames, while giving larger eye movements
  // more time. This prevents the final jump to the original fully open lashes.
  const duration = i === poses.length - 1 ? 0.4 : OPENING_SECONDS * (0.35 / (poses.length - 1) + 0.65 * irisDelta / openingRange);
  concat.push(`file '${path.join(workDir, "keys", `${String(i).padStart(3, "0")}.png`).replaceAll("'", "'\\''")}'`, "option framerate 1000", `duration ${duration}`);
  keyTime += duration;
}
// Repeat the open image to satisfy motion estimation's look-ahead window.
concat.push(`file '${path.join(workDir, "keys", `${String(poses.length - 1).padStart(3, "0")}.png`).replaceAll("'", "'\\''")}'`, "option framerate 1000");
await fs.writeFile(path.join(workDir, "keys.ffconcat"), concat.join("\n") + "\n");
const filters = [
  `crop=${CROP.width}:${CROP.height}:${CROP.left}:${CROP.top}`,
  "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:me=epzs:mb_size=8:search_param=24:vsbmc=1:scd=none",
  `tpad=start_mode=clone:start_duration=${CLOSED_HOLD}:stop_mode=clone:stop_duration=0.4`,
  "fps=60", "format=rgb24"
].join(",");
await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", path.join(workDir, "keys.ffconcat"), "-vf", filters, "-frames:v", String(FRAME_COUNT), path.join(workDir, "flow", "%03d.png")]);
const flowFiles = (await fs.readdir(path.join(workDir, "flow"))).filter(file => file.endsWith(".png")).sort();
assert.equal(flowFiles.length, FRAME_COUNT, "Film must contain 96 real frames.");
for (let index = 0; index < flowFiles.length; index++) {
  const cropPixels = await sharp(path.join(workDir, "flow", flowFiles[index])).removeAlpha().raw().toBuffer();
  const frame = Buffer.from(original);
  for (let y = 0; y < CROP.height; y++) for (let x = 0; x < CROP.width; x++) {
    const i = (CROP.top + y) * WIDTH + CROP.left + x;
    if (alpha[i] === 0) continue;
    const p = (y * CROP.width + x) * CHANNELS;
    for (let c = 0; c < CHANNELS; c++) frame[i * CHANNELS + c] = cropPixels[p + c];
  }
  // Hold the unmodified original from the first fully open frame onwards.
  if (index / FPS >= CLOSED_HOLD + OPENING_SECONDS) original.copy(frame);
  if (index === FRAME_COUNT - 1) metrics.finalFrameExactOriginal = frame.equals(original);
  await sharp(frame, { raw: { width: WIDTH, height: HEIGHT, channels: CHANNELS } }).png()
    .toFile(path.join(workDir, "frames", `${String(index).padStart(3, "0")}.png`));
}
await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS), "-i", path.join(workDir, "frames", "%03d.png"),
  "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", output]);
metrics.bytes = (await fs.stat(output)).size;
metrics.motionInterpolation = "FFmpeg minterpolate mci / aobmc / bidir / 8px variable blocks";
await fs.writeFile(path.join(workDir, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
console.log(JSON.stringify({ output, poster, workDir, ...metrics }, null, 2));
