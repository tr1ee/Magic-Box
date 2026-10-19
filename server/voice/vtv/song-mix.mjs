import { normalizeRvcSettings } from "./engines/rvc-v2/presets.mjs";
import { normalizeYingMusicSettings } from "./engines/yingmusic-svc/presets.mjs";

function optionalNumber(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Use the same pitch interpretation for vocal evaluation and accompaniment.
// Number(null) must not override an explicitly configured transposition with 0.
export function resolveSongPitchShift({ engineId, settings = {}, converted = {} } = {}) {
  const reported = optionalNumber(converted.engineMetrics?.reportedPitchShift);
  if (reported !== null) return Math.max(-24, Math.min(24, reported));
  const engineSettings = { ...settings, ...(settings.engineSettings?.[engineId] || {}) };
  if (engineId === "rvc-v2-finetuned") return normalizeRvcSettings(engineSettings).pitchShiftSemitones;
  if (engineId === "yingmusic-svc-zero-shot-v1") {
    return normalizeYingMusicSettings(engineSettings).forcedPitchShift ?? 0;
  }
  return Math.max(-24, Math.min(24, optionalNumber(engineSettings.pitchShift) ?? 0));
}

export function buildSongMixPlan({ vocalVolume = 1, accompanimentVolume = 0.9, vocalPitchShiftSemitones = 0 } = {}) {
  const shift = optionalNumber(vocalPitchShiftSemitones) ?? 0;
  // Octave register changes preserve the key. Choose the nearest equivalent
  // key for the backing track to avoid unnecessary octave-wide processing.
  let accompanimentPitchShiftSemitones = shift % 12;
  if (accompanimentPitchShiftSemitones > 6) accompanimentPitchShiftSemitones -= 12;
  if (accompanimentPitchShiftSemitones < -6) accompanimentPitchShiftSemitones += 12;
  accompanimentPitchShiftSemitones = Number(accompanimentPitchShiftSemitones.toFixed(6));
  const pitchRatio = 2 ** (accompanimentPitchShiftSemitones / 12);
  const transpose = Math.abs(accompanimentPitchShiftSemitones) > 0.000001
    ? `rubberband=tempo=1:pitch=${pitchRatio.toFixed(12)}:channels=together,`
    : "";
  const gain = (value, fallback) => Math.max(0, Math.min(3, optionalNumber(value) ?? fallback));
  return {
    vocalPitchShiftSemitones: shift,
    accompanimentPitchShiftSemitones,
    pitchRatio,
    pitchPolicy: "follow-vocal-key-preserve-octave-register",
    filter: [
      `[0:a]${transpose}volume=${gain(accompanimentVolume, 0.9)}[acc]`,
      `[1:a]volume=${gain(vocalVolume, 1)}[vox]`,
      "[acc][vox]amix=inputs=2:duration=longest:dropout_transition=0,alimiter=limit=0.95,loudnorm=I=-16:TP=-1.5:LRA=11[out]"
    ].join(";")
  };
}
