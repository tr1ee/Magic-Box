import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

const mode = arg("--mode", "speech") === "song" ? "song" : "speech";
const sourceAudioPath = path.resolve(arg("--source"));
const targetReferenceAudioPath = path.resolve(arg("--reference"));
const targetReferenceAudioPaths = [...new Set([targetReferenceAudioPath, ...arg("--references", "").split("|").map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value))])];
const outputPath = path.resolve(arg("--output", `artifacts/vtv-gpu-regression/${mode}-candidate.wav`));
const steps = Math.max(4, Math.min(50, Number(arg("--steps", "12")) || 12));
const repeatCount = Math.max(1, Math.min(3, Number(arg("--repeat", "2")) || 2));
const cfgRate = Math.max(0, Math.min(1, Number(arg("--cfg", mode === "song" ? "0.85" : "0.5")) || 0));
const seed = Number.isInteger(Number(arg("--seed", "31001"))) ? Number(arg("--seed", "31001")) : 31001;
const crossfadeMs = Math.max(180, Math.min(1200, Number(arg("--crossfade-ms", "750")) || 750));
const checkpointPath = arg("--checkpoint", "");
const configPath = arg("--config", "");
const pythonPath = path.resolve(arg("--python", "MagicBoxData/voice_clone/voice_engine/seed-vc/runtime/python/python.exe"));
const workerPath = path.resolve(arg("--worker", "MagicBoxData/voice_clone/voice_engine/seed-vc/runtime/seed_vc_worker.py"));
if (!sourceAudioPath || !targetReferenceAudioPath || !(await fs.stat(sourceAudioPath).catch(() => null)) || !(await Promise.all(targetReferenceAudioPaths.map((filePath) => fs.stat(filePath).catch(() => null))).then((items) => items.every(Boolean)))) {
  console.error("Usage: node scripts/run-vtv-gpu-regression.mjs --mode speech|song --source <wav> --reference <wav> [--output <wav>] [--steps 12] [--crossfade-ms 750] [--checkpoint <pth> --config <yml>]");
  process.exit(2);
}

const sourceBytes = await fs.readFile(sourceAudioPath);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
const referenceSha256 = createHash("sha256").update(await fs.readFile(targetReferenceAudioPath)).digest("hex");
const referenceSha256s = await Promise.all(targetReferenceAudioPaths.map(async (filePath) => createHash("sha256").update(await fs.readFile(filePath)).digest("hex")));
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const child = spawn(pythonPath, [workerPath], {
  cwd: path.dirname(workerPath),
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"]
});
function pcmMetrics(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataOffset = buffer.indexOf(Buffer.from("data"), 36, "ascii");
  if (dataOffset < 0 || ![16, 32].includes(bitsPerSample) || !channels) return null;
  const dataSize = Math.min(buffer.readUInt32LE(dataOffset + 4), buffer.length - dataOffset - 8);
  return { channels, sampleRate, bitsPerSample, bytesPerSample: bitsPerSample / 8, sampleCount: Math.floor(dataSize / (bitsPerSample / 8) / channels), data: buffer.subarray(dataOffset + 8, dataOffset + 8 + dataSize) };
}

function compareWavs(buffers) {
  const metrics = buffers.map(pcmMetrics);
  if (metrics.some((item) => !item)) return { comparable: false, reason: "wav_pcm_metrics_unavailable" };
  const first = metrics[0];
  const comparison = metrics.slice(1).map((current) => {
    const sampleCount = Math.min(first.sampleCount, current.sampleCount);
    let maxAbsSampleDelta = 0;
    let sumAbsSampleDelta = 0;
    for (let index = 0; index < sampleCount * first.channels; index += 1) {
      const offsetA = index * first.bytesPerSample;
      const offsetB = index * current.bytesPerSample;
      const firstValue = first.bitsPerSample === 16 ? first.data.readInt16LE(offsetA) / 32768 : first.data.readFloatLE(offsetA);
      const currentValue = current.bitsPerSample === 16 ? current.data.readInt16LE(offsetB) / 32768 : current.data.readFloatLE(offsetB);
      const delta = Math.abs(firstValue - currentValue);
      maxAbsSampleDelta = Math.max(maxAbsSampleDelta, delta);
      sumAbsSampleDelta += delta;
    }
    return {
      sampleRateMatch: first.sampleRate === current.sampleRate,
      channelMatch: first.channels === current.channels,
      sampleCountDelta: Math.abs(first.sampleCount - current.sampleCount),
      maxAbsSampleDelta,
      meanAbsSampleDelta: Number((sumAbsSampleDelta / Math.max(1, sampleCount * first.channels)).toFixed(6))
    };
  });
  return { comparable: true, format: { sampleRate: first.sampleRate, channels: first.channels, bitsPerSample: first.bitsPerSample }, comparison };
}
const lines = readline.createInterface({ input: child.stdout });
const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
let nextId = 1;
const send = (request) => new Promise((resolve, reject) => {
  const id = `vtv-regression-${nextId++}`;
  const timer = setTimeout(() => reject(new Error(`VTV worker timed out: ${request.action}`)), 15 * 60 * 1000);
  const listener = (line) => {
    let payload;
    try { payload = JSON.parse(line); } catch { return; }
    if (payload.id !== id) return;
    if (payload.event === "progress") return;
    clearTimeout(timer);
    lines.off("line", listener);
    if (payload.ok === false) reject(new Error(payload.error || `VTV worker failed: ${request.action}`));
    else resolve(payload.result);
  };
  lines.on("line", listener);
  child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
});

let report;
try {
  const health = await send({ action: "health", modelDir: path.dirname(workerPath) });
  const conversions = [];
  const outputPaths = [];
  for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
    const repeatOutputPath = repeatIndex === 0
      ? outputPath
      : outputPath.replace(/\.wav$/iu, `-repeat-${repeatIndex + 1}.wav`);
    outputPaths.push(repeatOutputPath);
    conversions.push(await send({
      action: "convert",
      sourceAudioPath,
      targetReferenceAudioPath,
      outputPath: repeatOutputPath,
      modelDir: path.dirname(workerPath),
      settings: {
        seed,
        diffusionSteps: steps,
        preserveEmotion: mode === "song",
        inferenceCfgRate: cfgRate,
        chunkCrossfadeMs: crossfadeMs,
        outputSampleRate: mode === "song" ? 44100 : 32000,
        nativeSampleRate: mode === "song" ? 44100 : 32000,
        ...(checkpointPath ? { checkpointPath: path.resolve(checkpointPath) } : {}),
        ...(configPath ? { configPath: path.resolve(configPath) } : {})
      }
    }));
  }
  const conversion = conversions[0];
  const outputHashes = await Promise.all(outputPaths.map(async (filePath) => createHash("sha256").update(await fs.readFile(filePath)).digest("hex")));
  const waveformComparison = compareWavs(await Promise.all(outputPaths.map((filePath) => fs.readFile(filePath))));
  let evaluation = null;
  let perceptual = null;
  let artifacts = null;
  if (mode === "speech") {
    evaluation = await send({
      action: "analyze-speaker-identity-batch",
      sourceAudioPath,
      targetReferenceAudioPaths,
      candidates: [{ id: "gpu-regression-candidate", audioPath: outputPath }],
      modelDir: path.dirname(workerPath)
    });
  } else {
    evaluation = await send({
      action: "analyze-song-conversion",
      sourceAudioPath,
      convertedAudioPath: outputPath,
      targetReferenceAudioPath,
      targetReferenceAudioPaths,
      modelDir: path.dirname(workerPath),
      settings: { preserveEmotion: true }
    });
  }
  perceptual = await send({
    action: "evaluate-quality-batch",
    sourceAudioPath,
    targetReferenceAudioPaths,
    candidates: [{ id: "gpu-regression-candidate", audioPath: outputPath }],
    modelDir: path.dirname(workerPath)
  });
  artifacts = await send({
    action: "analyze-waveform-artifacts",
    candidates: [{ id: "gpu-regression-candidate", audioPath: outputPath }],
    modelDir: path.dirname(workerPath)
  });
  report = {
    schemaVersion: "vtv-gpu-regression-report-v1",
    mode,
    sourceAudioPath,
    sourceSha256,
    targetReferenceAudioPath,
    targetReferenceSha256: referenceSha256,
    targetReferenceAudioPaths,
    targetReferenceSha256s: referenceSha256s,
    outputPath,
    seed,
    diffusionSteps: steps,
    inferenceCfgRate: cfgRate,
    chunkCrossfadeMs: crossfadeMs,
    health,
    conversion,
    repeats: conversions,
    determinism: {
      repeatCount,
      outputPaths,
      outputSha256: outputHashes,
      waveformComparison,
      level: outputHashes.every((value) => value === outputHashes[0])
        ? "bit-exact"
        : waveformComparison.comparable && waveformComparison.comparison.every((item) => item.maxAbsSampleDelta === 0 && item.sampleCountDelta === 0)
          ? "waveform-exact-metadata-diff"
          : "metrics-only"
    },
    evaluation,
    perceptual,
    artifacts,
    stderr: stderr.join("").slice(-5000),
    passed: health.gpuAvailable === true && health.fcpeReady === true && Boolean(conversion?.outputPath)
      && (mode === "speech"
        ? evaluation?.results?.[0]?.accepted === true
        : evaluation?.accepted === true && evaluation?.f0Evaluators?.fcpe?.available === true)
      && perceptual?.available === true
      && artifacts?.results?.[0]?.passed === true,
    createdAt: new Date().toISOString()
  };
} finally {
  child.stdin.end();
  lines.close();
}
const reportPath = outputPath.replace(/\.wav$/iu, ".report.json");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ reportPath, passed: report.passed, device: report.health?.device, outputPath }, null, 2));
if (!report.passed) process.exitCode = 1;
