import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import readline from "node:readline";
import process from "node:process";
import { promisify } from "node:util";
import { evaluateStemGate } from "../server/voice/vtv/song-quality.mjs";

const execFileAsync = promisify(execFile);

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

const sourceAudioPath = path.resolve(arg("--source", "artifacts/voice-poc/full-single-inference.wav"));
const outputDir = path.resolve(arg("--output-dir", "artifacts/vtv-benchmarks/separator-bakeoff"));
const pythonPath = path.resolve(arg("--python", "MagicBoxData/voice_clone/voice_engine/seed-vc/runtime/python/python.exe"));
const workerPath = path.resolve(arg("--worker", "MagicBoxData/voice_clone/voice_engine/seed-vc/runtime/seed_vc_worker.py"));
const modelDir = path.resolve(arg("--model-dir", "MagicBoxData/voice_clone/voice_engine/seed-vc/models/seed-vc-svc-v1"));
const repoDir = path.resolve(arg("--repo-dir", "MagicBoxData/voice_clone/voice_engine/seed-vc/runtime/seed-vc"));
const roformerRoot = path.resolve(arg("--roformer-root", "MagicBoxData/voice_clone/voice_engine/seed-vc/models/vtv-separators/bs-roformer"));
const ffmpegPath = path.resolve(arg("--ffmpeg", "release/chromium/MagicBox/vendor/ffmpeg/bin/ffmpeg.exe"));
const ffprobePath = path.resolve(arg("--ffprobe", "release/chromium/MagicBox/vendor/ffmpeg/bin/ffprobe.exe"));

await fs.access(sourceAudioPath);
await fs.mkdir(outputDir, { recursive: true });

function pcm16Wav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not_a_wav");
  }
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  if (bitsPerSample !== 16 || channels < 1) throw new Error("unsupported_wav_format");
  let cursor = 12;
  let dataOffset = -1;
  let dataSize = 0;
  while (cursor + 8 <= buffer.length) {
    const id = buffer.toString("ascii", cursor, cursor + 4);
    const size = buffer.readUInt32LE(cursor + 4);
    if (id === "data") {
      dataOffset = cursor + 8;
      dataSize = Math.min(size, buffer.length - dataOffset);
      break;
    }
    cursor += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error("wav_data_chunk_missing");
  const frames = Math.floor(dataSize / (channels * 2));
  const mono = new Float32Array(frames);
  let clipped = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const value = buffer.readInt16LE(dataOffset + (frame * channels + channel) * 2) / 32768;
      sum += value;
      if (Math.abs(value) >= 0.999969) clipped += 1;
    }
    mono[frame] = sum / channels;
  }
  return {
    sampleRate,
    channels,
    frames,
    durationSeconds: frames / sampleRate,
    clippingRatio: clipped / Math.max(1, frames * channels),
    mono
  };
}

function correlation(first, second) {
  const length = Math.min(first.length, second.length);
  if (length < 100) return null;
  let firstMean = 0;
  let secondMean = 0;
  for (let index = 0; index < length; index += 1) {
    firstMean += first[index];
    secondMean += second[index];
  }
  firstMean /= length;
  secondMean /= length;
  let numerator = 0;
  let firstEnergy = 0;
  let secondEnergy = 0;
  for (let index = 0; index < length; index += 1) {
    const left = first[index] - firstMean;
    const right = second[index] - secondMean;
    numerator += left * right;
    firstEnergy += left * left;
    secondEnergy += right * right;
  }
  return Math.abs(numerator / Math.max(1e-9, Math.sqrt(firstEnergy * secondEnergy)));
}

function stemMetrics(source, vocal, accompaniment) {
  const length = Math.min(source.mono.length, vocal.mono.length, accompaniment.mono.length);
  const reconstructedSamples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) reconstructedSamples[index] = vocal.mono[index] + accompaniment.mono[index];
  const stride = Math.max(64, Math.floor(length / 20000));
  let bestLag = 0;
  let bestCorrelation = -1;
  for (let lag = -2048; lag <= 2048; lag += 128) {
    const sourceStart = Math.max(0, lag);
    const reconstructedStart = Math.max(0, -lag);
    const alignedLength = Math.min(length - sourceStart, length - reconstructedStart);
    let sourceMean = 0;
    let reconstructedMean = 0;
    let count = 0;
    for (let index = 0; index < alignedLength; index += stride) {
      sourceMean += source.mono[sourceStart + index] || 0;
      reconstructedMean += reconstructedSamples[reconstructedStart + index] || 0;
      count += 1;
    }
    sourceMean /= Math.max(1, count);
    reconstructedMean /= Math.max(1, count);
    let numerator = 0;
    let sourceVariance = 0;
    let reconstructedVariance = 0;
    for (let index = 0; index < alignedLength; index += stride) {
      const sourceValue = (source.mono[sourceStart + index] || 0) - sourceMean;
      const reconstructedValue = (reconstructedSamples[reconstructedStart + index] || 0) - reconstructedMean;
      numerator += sourceValue * reconstructedValue;
      sourceVariance += sourceValue ** 2;
      reconstructedVariance += reconstructedValue ** 2;
    }
    const currentCorrelation = numerator / Math.max(1e-9, Math.sqrt(sourceVariance * reconstructedVariance));
    if (currentCorrelation > bestCorrelation) {
      bestCorrelation = currentCorrelation;
      bestLag = lag;
    }
  }
  const sourceStart = Math.max(0, bestLag);
  const reconstructedStart = Math.max(0, -bestLag);
  const alignedLength = Math.min(length - sourceStart, length - reconstructedStart);
  let sourceEnergy = 0;
  let errorEnergy = 0;
  for (let index = 0; index < alignedLength; index += 1) {
    const original = source.mono[sourceStart + index];
    const reconstruction = reconstructedSamples[reconstructedStart + index];
    sourceEnergy += original * original;
    errorEnergy += (original - reconstruction) ** 2;
  }
  const errorDb = 20 * Math.log10(
    Math.sqrt(errorEnergy / Math.max(1, length))
      / Math.max(1e-6, Math.sqrt(sourceEnergy / Math.max(1, length)))
  );
  const backgroundLeakRatio = correlation(vocal.mono, accompaniment.mono);
  return {
    errorDb: Number(errorDb.toFixed(6)),
    backgroundLeakRatio: Number((backgroundLeakRatio ?? 0).toFixed(6)),
    vocalResidualRatio: Number((backgroundLeakRatio ?? 0).toFixed(6)),
    alignmentLagSamples: bestLag,
    alignmentCorrelation: Number(bestCorrelation.toFixed(6))
  };
}

const sourceSha256 = createHash("sha256").update(await fs.readFile(sourceAudioPath)).digest("hex");
const analysisSourceAudioPath = path.join(outputDir, ".source-44100-stereo.wav");
await execFileAsync(ffmpegPath, [
  "-y", "-v", "error", "-i", sourceAudioPath,
  "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", analysisSourceAudioPath
], { windowsHide: true });
const source = pcm16Wav(await fs.readFile(analysisSourceAudioPath));
const analysisSourceSha256 = createHash("sha256").update(await fs.readFile(analysisSourceAudioPath)).digest("hex");
const child = spawn(pythonPath, [workerPath], { cwd: path.dirname(workerPath), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
const lines = readline.createInterface({ input: child.stdout });
let nextId = 1;
const send = (request) => new Promise((resolve, reject) => {
  const id = `separator-bakeoff-${nextId++}`;
  const timer = setTimeout(() => reject(new Error(`worker_timeout:${request.action}`)), 15 * 60 * 1000);
  const listener = (line) => {
    let payload;
    try { payload = JSON.parse(line); } catch { return; }
    if (payload.id !== id || payload.event === "progress") return;
    clearTimeout(timer);
    lines.off("line", listener);
    if (payload.ok === false) reject(new Error(payload.error || `worker_failed:${request.action}`));
    else resolve(payload.result);
  };
  lines.on("line", listener);
  child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
});

async function runSeparator(id, action, extra = {}) {
  const vocalPath = path.join(outputDir, `${id}-vocals.wav`);
  const accompanimentPath = path.join(outputDir, `${id}-accompaniment.wav`);
  try {
    const separation = await send({
      action,
      modelDir,
      repoDir,
      sourceAudioPath: analysisSourceAudioPath,
      vocalPath,
      accompanimentPath,
      workingDir: outputDir,
      device: "cuda",
      ffmpegPath,
      ffprobePath,
      roformerRoot,
      separationModel: "htdemucs",
      segmentSeconds: 7,
      separationOverlap: 0.5,
      separationShifts: 1,
      ...extra
    });
    const vocal = pcm16Wav(await fs.readFile(vocalPath));
    const accompaniment = pcm16Wav(await fs.readFile(accompanimentPath));
    const reconstruction = stemMetrics(source, vocal, accompaniment);
    const gate = evaluateStemGate({
      vocal: { durationSeconds: vocal.durationSeconds, clipping: vocal.clippingRatio > 0 },
      accompaniment: { durationSeconds: accompaniment.durationSeconds, clipping: accompaniment.clippingRatio > 0 },
      reconstruction
    });
    return {
      id,
      status: "completed",
      separation,
      gate,
      sourceSha256,
      vocal: { sampleRate: vocal.sampleRate, channels: vocal.channels, durationSeconds: vocal.durationSeconds, clippingRatio: vocal.clippingRatio, sha256: createHash("sha256").update(await fs.readFile(vocalPath)).digest("hex") },
      accompaniment: { sampleRate: accompaniment.sampleRate, channels: accompaniment.channels, durationSeconds: accompaniment.durationSeconds, clippingRatio: accompaniment.clippingRatio, sha256: createHash("sha256").update(await fs.readFile(accompanimentPath)).digest("hex") },
      reconstruction,
      conversionReportPath: await fs.access(path.join(outputDir, `${id}-converted-vocals.report.json`)).then(() => path.join(outputDir, `${id}-converted-vocals.report.json`)).catch(() => "")
    };
  } catch (error) {
    return { id, status: "failed", error: String(error.message || error), sourceSha256 };
  }
}

let report;
try {
  const health = await send({ action: "health", modelDir, repoDir, roformerRoot });
  const demucs = await runSeparator("demucs-htdemucs", "separate-stems");
  const roformer = await runSeparator("bs-roformer", "separate-stems-roformer");
  const candidates = [demucs, roformer];
  const completed = candidates.filter((candidate) => candidate.status === "completed");
  const selected = completed
    .filter((candidate) => candidate.gate?.passed === true)
    .sort((left, right) => (left.reconstruction.errorDb - right.reconstruction.errorDb))[0] || null;
  report = {
    schemaVersion: "vtv-separator-bakeoff-report-v1",
    sourceAudioPath,
    sourceSha256,
    analysisSourceAudioPath,
    analysisSourceSha256,
    analysisSampleRate: source.sampleRate,
    health,
    candidates,
    selectedSeparator: selected?.id || "",
    promotionStatus: selected ? "candidate" : "blocked",
    promotionReason: selected ? "best_stem_gate_candidate_requires_full_song_validation_and_human_review" : "no_separator_passed_stem_gate",
    createdAt: new Date().toISOString()
  };
} finally {
  child.stdin.end();
  lines.close();
}

const reportPath = path.join(outputDir, "separator-bakeoff.report.json");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ reportPath, selectedSeparator: report.selectedSeparator, promotionStatus: report.promotionStatus }, null, 2));
if (report.promotionStatus === "blocked") process.exitCode = 1;
