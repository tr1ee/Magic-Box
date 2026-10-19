import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeYingMusicSettings } from "../server/voice/vtv/engines/yingmusic-svc/presets.mjs";
import { buildYingMusicReferenceArtifact, validateYingMusicReferenceArtifact } from "../server/voice/vtv/engines/yingmusic-svc/reference-artifact.mjs";

function pcmWavWithPause({ voicedSeconds = 4, pauseSeconds = 1, sampleRate = 44100 } = {}) {
  const voicedSamples = Math.floor(voicedSeconds * sampleRate);
  const pauseSamples = Math.floor(pauseSeconds * sampleRate);
  const samples = voicedSamples + pauseSamples;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0, 4, "ascii");
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8, 4, "ascii");
  buffer.write("fmt ", 12, 4, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, 4, "ascii");
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < voicedSamples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * 220) * 9000), 44 + index * 2);
  }
  return buffer;
}

test("YingMusic reference artifact rejects the old short prompt", () => {
  assert.equal(validateYingMusicReferenceArtifact({ durationSec: 6.76, voicedDurationSec: 6.76, validation: { valid: true } }).valid, false);
});

test("YingMusic settings expose automatic F0 adjustment explicitly", () => {
  assert.equal(normalizeYingMusicSettings({ preset: "balanced" }).autoF0Adjust, true);
  assert.equal(normalizeYingMusicSettings({ preset: "rawMelody" }).autoF0Adjust, false);
});

test("YingMusic distinguishes automatic F0 matching from an explicit pitch shift", () => {
  const automatic = normalizeYingMusicSettings({ preset: "balanced", pitchMode: "auto", pitchShift: 6 });
  assert.equal(automatic.autoF0Adjust, true);
  assert.equal(automatic.forcedPitchShift, null);
  const manual = normalizeYingMusicSettings({ preset: "balanced", pitchMode: "manual", pitchShift: 6 });
  assert.equal(manual.autoF0Adjust, false);
  assert.equal(manual.forcedPitchShift, 6);
});

test("YingMusic reference compacts long pauses and keeps 20-25 voiced seconds", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-ying-reference-"));
  try {
    const sourcePaths = [];
    for (let index = 0; index < 6; index += 1) {
      const sourcePath = path.join(root, `clip-${index}.wav`);
      await fs.writeFile(sourcePath, pcmWavWithPause());
      sourcePaths.push(sourcePath);
    }
    const artifact = await buildYingMusicReferenceArtifact({ sourcePaths, outputDir: path.join(root, "artifact"), profileId: "profile-a" });
    assert.equal(validateYingMusicReferenceArtifact(artifact).valid, true);
    assert.ok(artifact.durationSec >= 20 && artifact.durationSec <= 25);
    assert.ok(artifact.voicedDurationSec >= 20);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
