import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { VtvEngineError } from "../../engine-errors.mjs";

function wavMetadata(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let format = 0;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataBytes = 0;
  let dataOffset = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 24 <= buffer.length) {
      format = buffer.readUInt16LE(offset + 8);
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bits = buffer.readUInt16LE(offset + 22);
    }
    if (id === "data") {
      dataBytes = Math.min(size, buffer.length - offset - 8);
      dataOffset = offset + 8;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  const bytesPerSample = bits / 8;
  const bytesPerSecond = sampleRate * channels * bytesPerSample;
  if (!sampleRate || !channels || !bytesPerSample || !dataBytes) return null;
  return { format, sampleRate, channels, bits, dataOffset, dataBytes, bytesPerSample, frameCount: Math.floor(dataBytes / (channels * bytesPerSample)), durationSec: bytesPerSecond ? dataBytes / bytesPerSecond : 0 };
}

function decodeMonoPcm(buffer, metadata) {
  if (!metadata || metadata.channels !== 1 || ![1, 3].includes(metadata.format) || ![16, 32].includes(metadata.bits)) return null;
  const samples = new Float32Array(metadata.frameCount);
  for (let frame = 0; frame < metadata.frameCount; frame += 1) {
    const position = metadata.dataOffset + frame * metadata.bytesPerSample;
    if (metadata.bits === 16) samples[frame] = buffer.readInt16LE(position) / 32768;
    else if (metadata.format === 3) samples[frame] = buffer.readFloatLE(position);
    else samples[frame] = buffer.readInt32LE(position) / 2147483648;
  }
  return samples;
}

function trimSilence(samples, sampleRate) {
  const threshold = 0.01;
  let first = 0;
  let last = samples.length - 1;
  while (first < samples.length && Math.abs(samples[first]) < threshold) first += 1;
  while (last > first && Math.abs(samples[last]) < threshold) last -= 1;
  const context = Math.floor(sampleRate * 0.08);
  first = Math.max(0, first - context);
  last = Math.min(samples.length - 1, last + context);
  return samples.slice(first, last + 1);
}

function compactLongSilences(samples, sampleRate) {
  const windowSize = Math.max(1, Math.floor(sampleRate * 0.02));
  const windows = Math.ceil(samples.length / windowSize);
  const voiced = new Array(windows).fill(false);
  for (let window = 0; window < windows; window += 1) {
    const start = window * windowSize;
    const end = Math.min(samples.length, start + windowSize);
    let energy = 0;
    for (let index = start; index < end; index += 1) energy += samples[index] * samples[index];
    voiced[window] = Math.sqrt(energy / Math.max(1, end - start)) >= 0.01;
  }
  const contextWindows = 5;
  const bridgeWindows = 10;
  const keep = new Array(windows).fill(false);
  for (let window = 0; window < windows; window += 1) {
    if (!voiced[window]) continue;
    for (let context = Math.max(0, window - contextWindows); context <= Math.min(windows - 1, window + contextWindows); context += 1) keep[context] = true;
  }
  let previousKept = -1;
  for (let window = 0; window < windows; window += 1) {
    if (!keep[window]) continue;
    if (previousKept >= 0 && window - previousKept <= bridgeWindows + 1) {
      for (let bridge = previousKept + 1; bridge < window; bridge += 1) keep[bridge] = true;
    }
    previousKept = window;
  }
  const compacted = [];
  for (let window = 0; window < windows; window += 1) {
    if (!keep[window]) continue;
    const start = window * windowSize;
    const end = Math.min(samples.length, start + windowSize);
    for (let index = start; index < end; index += 1) compacted.push(samples[index]);
  }
  return Float32Array.from(compacted);
}

function crossfadeAppend(output, input, sampleRate) {
  const overlap = Math.min(Math.floor(sampleRate * 0.1), Math.floor(output.length / 2), Math.floor(input.length / 2));
  if (!overlap) return output.concat(Array.from(input));
  const start = output.length - overlap;
  const merged = output.slice(0, start);
  for (let index = 0; index < overlap; index += 1) {
    const theta = (index / Math.max(1, overlap - 1)) * (Math.PI / 2);
    merged.push(output[start + index] * Math.cos(theta) + input[index] * Math.sin(theta));
  }
  return merged.concat(Array.from(input.slice(overlap)));
}

function encodeMonoWav(samples, sampleRate) {
  const output = Buffer.alloc(44 + samples.length * 2);
  output.write("RIFF", 0, 4, "ascii");
  output.writeUInt32LE(36 + samples.length * 2, 4);
  output.write("WAVE", 8, 4, "ascii");
  output.write("fmt ", 12, 4, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, 4, "ascii");
  output.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(Number(sample || 0) * 32767))), 44 + index * 2));
  return output;
}

function voicedDuration(samples, sampleRate) {
  const windowSize = Math.max(1, Math.floor(sampleRate * 0.02));
  let voiced = 0;
  for (let start = 0; start < samples.length; start += windowSize) {
    const end = Math.min(samples.length, start + windowSize);
    let energy = 0;
    for (let index = start; index < end; index += 1) energy += samples[index] * samples[index];
    if (Math.sqrt(energy / Math.max(1, end - start)) >= 0.01) voiced += end - start;
  }
  return voiced / sampleRate;
}

export async function buildYingMusicReferenceArtifact({ sourcePath, sourcePaths = [], outputDir, profileId = "", profileVersionId = "", artifactId = `ying-ref-${Date.now()}` } = {}) {
  const requestedPaths = sourcePaths.length ? sourcePaths : [sourcePath];
  if (requestedPaths.length > 6) throw new VtvEngineError("TARGET_REFERENCE_INVALID", "YingMusic requires one to six reference clips.");
  const paths = requestedPaths.filter(Boolean);
  if (!paths.length) throw new VtvEngineError("TARGET_REFERENCE_INVALID", "YingMusic requires one to six reference clips.");
  const clips = [];
  for (const inputPath of paths) {
    const source = await fs.readFile(inputPath).catch(() => null);
    const metadata = wavMetadata(source);
    const samples = decodeMonoPcm(source, metadata);
    if (!source || !metadata || !samples || metadata.sampleRate !== 44100 || metadata.channels !== 1) throw new VtvEngineError("TARGET_REFERENCE_INVALID", "Every YingMusic reference clip must be a readable 44.1 kHz mono PCM WAV.");
    const trimmed = trimSilence(samples, metadata.sampleRate);
    const compacted = compactLongSilences(trimmed, metadata.sampleRate);
    if (compacted.length) clips.push({ source, samples: compacted, hash: createHash("sha256").update(source).digest("hex") });
  }
  if (!clips.length) throw new VtvEngineError("TARGET_REFERENCE_INVALID", "YingMusic reference clips contain no usable audio.");
  let combined = [];
  const sourceClips = [];
  const maximumSamples = Math.floor(44100 * 24.8);
  for (const clip of clips) {
    if (combined.length >= maximumSamples) break;
    const startSec = combined.length / 44100;
    const overlapSamples = combined.length ? Math.floor(44100 * 0.1) : 0;
    const availableSamples = maximumSamples - combined.length + overlapSamples;
    combined = crossfadeAppend(combined, clip.samples.slice(0, Math.max(0, availableSamples)), 44100);
    sourceClips.push({ sha256: clip.hash, startSec: Number(startSec.toFixed(3)), endSec: Number((combined.length / 44100).toFixed(3)) });
  }
  const durationSec = combined.length / 44100;
  const voicedDurationSec = voicedDuration(combined, 44100);
  if (durationSec < 20 || voicedDurationSec < 20) throw new VtvEngineError("YINGMUSIC_REFERENCE_TOO_SHORT", `YingMusic target reference must contain 20–25 seconds of valid voiced audio (total ${durationSec.toFixed(2)} s, voiced ${voicedDurationSec.toFixed(2)} s).`);
  if (durationSec > 25) throw new VtvEngineError("YINGMUSIC_REFERENCE_TOO_LONG", "YingMusic target reference must not exceed 25 seconds.");
  const targetBuffer = encodeMonoWav(combined, 44100);
  const dir = path.resolve(outputDir);
  await fs.mkdir(dir, { recursive: true });
  const targetPath = path.join(dir, "target-timbre.wav");
  await fs.writeFile(targetPath, targetBuffer);
  const targetHash = createHash("sha256").update(targetBuffer).digest("hex");
  const manifest = { schemaVersion: 1, engineId: "yingmusic-svc-zero-shot-v1", artifactId, profileId, profileVersionId, audioPath: "target-timbre.wav", sha256: targetHash, sampleRate: 44100, channels: 1, durationSec: Number(durationSec.toFixed(3)), voicedDurationSec: Number(voicedDurationSec.toFixed(3)), sourceClips, validation: { valid: true, speakerConsistency: { status: "not-automatically-scored" }, snr: { status: "not-automatically-scored" }, errors: [], warnings: [] } };
  await fs.writeFile(path.join(dir, "artifact-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { ...manifest, directory: dir, audioPath: targetPath };
}

export function validateYingMusicReferenceArtifact(manifest = {}) {
  const duration = Number(manifest.durationSec) || 0;
  const voiced = Number(manifest.voicedDurationSec) || 0;
  const errors = [];
  if (duration < 20 || voiced < 20) errors.push("YINGMUSIC_REFERENCE_TOO_SHORT");
  if (duration > 25) errors.push("YINGMUSIC_REFERENCE_TOO_LONG");
  if (Number(manifest.sampleRate) !== 44100 || Number(manifest.channels) !== 1) errors.push("TARGET_REFERENCE_INVALID");
  if (manifest.validation?.valid === false) errors.push(...(manifest.validation.errors || ["TARGET_REFERENCE_INVALID"]));
  return { valid: errors.length === 0, errors };
}

export async function inspectYingMusicReferenceSource(filePath) {
  const source = await fs.readFile(filePath);
  const metadata = wavMetadata(source);
  const samples = decodeMonoPcm(source, metadata);
  if (!metadata || !samples) throw new VtvEngineError("TARGET_REFERENCE_INVALID", "YingMusic reference source must be a readable mono PCM WAV.");
  return {
    durationSec: metadata.durationSec,
    voicedDurationSec: voicedDuration(samples, metadata.sampleRate),
    sampleRate: metadata.sampleRate,
    channels: metadata.channels
  };
}
