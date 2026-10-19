import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { buildSongMixPlan, resolveSongPitchShift } from "../server/voice/vtv/song-mix.mjs";

test("mixback follows each engine's effective pitch, including null reports and octave shifts", () => {
  const settings = { engineSettings: {
    "rvc-v2-finetuned": { pitchShiftSemitones: 3 },
    "yingmusic-svc-zero-shot-v1": { pitchMode: "manual", forcedPitchShift: -4 }
  } };
  for (const [engineId, expected] of [["rvc-v2-finetuned", 3], ["yingmusic-svc-zero-shot-v1", -4]]) {
    assert.equal(resolveSongPitchShift({ engineId, settings, converted: { engineMetrics: { reportedPitchShift: null } } }), expected);
    assert.equal(resolveSongPitchShift({ engineId, settings, converted: { engineMetrics: { reportedPitchShift: 0 } } }), 0);
    assert.equal(resolveSongPitchShift({ engineId, settings, converted: { engineMetrics: { reportedPitchShift: 12 } } }), 12);
  }
  for (const shift of [-24, -12, 0, 12, 24]) {
    const plan = buildSongMixPlan({ vocalPitchShiftSemitones: shift });
    assert.equal(plan.accompanimentPitchShiftSemitones, 0);
    assert.doesNotMatch(plan.filter, /rubberband/);
  }
  assert.equal(buildSongMixPlan({ vocalPitchShiftSemitones: 15 }).accompanimentPitchShiftSemitones, 3);
  assert.equal(buildSongMixPlan({ vocalPitchShiftSemitones: -15 }).accompanimentPitchShiftSemitones, -3);
});

test("bundled FFmpeg transposes accompaniment by three semitones without changing tempo or stereo", () => {
  const plan = buildSongMixPlan({ vocalPitchShiftSemitones: 3, vocalVolume: 0 });
  const pcm = execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=44100",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=4",
    "-filter_complex", plan.filter, "-map", "[out]", "-ar", "44100", "-ac", "2", "-f", "f32le", "pipe:1"
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  assert.ok(Math.abs(pcm.length / 8 / 44100 - 4) < 0.03, "tempo/duration must stay fixed");
  let crossings = 0;
  let peak = 0;
  for (let frame = 44100; frame < 3 * 44100; frame++) {
    const left = pcm.readFloatLE(frame * 8);
    const right = pcm.readFloatLE(frame * 8 + 4);
    assert.ok(Number.isFinite(left) && Number.isFinite(right));
    assert.ok(Math.abs(left - right) < 1e-6, "centered input must remain centered");
    peak = Math.max(peak, Math.abs(left));
    if (pcm.readFloatLE((frame - 1) * 8) <= 0 && left > 0) crossings++;
  }
  assert.ok(Math.abs(crossings / 2 - 440 * 2 ** (3 / 12)) < 1, `measured ${crossings / 2} Hz`);
  assert.ok(peak > 0.01 && peak < 0.99);
});
