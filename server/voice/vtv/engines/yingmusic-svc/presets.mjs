export const YINGMUSIC_PRESETS = Object.freeze({
  official: { diffusionSteps: 100, cfgRate: 0.7, autoF0Adjust: true, maxShiftSemitones: 24, forcedPitchShift: null, fp16: true },
  balanced: { diffusionSteps: 50, cfgRate: 0.7, autoF0Adjust: true, maxShiftSemitones: 12, forcedPitchShift: null, fp16: true },
  rawMelody: { diffusionSteps: 50, cfgRate: 0.7, autoF0Adjust: false, maxShiftSemitones: 0, forcedPitchShift: 0, fp16: true }
});

export function normalizeYingMusicSettings(settings = {}) {
  const preset = YINGMUSIC_PRESETS[settings.preset] ? settings.preset : "balanced";
  const pitchMode = settings.pitchMode === "manual"
    ? "manual"
    : settings.pitchMode === "auto"
      ? "auto"
      : YINGMUSIC_PRESETS[preset].autoF0Adjust ? "auto" : "manual";
  const explicitForcedPitch = Object.prototype.hasOwnProperty.call(settings, "forcedPitchShift")
    ? settings.forcedPitchShift
    : settings.pitchShift;
  const forcedPitchShift = pitchMode === "manual" && Number.isFinite(Number(explicitForcedPitch))
    ? Math.max(-24, Math.min(24, Math.round(Number(explicitForcedPitch))))
    : null;
  return {
    ...YINGMUSIC_PRESETS[preset],
    ...settings,
    autoF0Adjust: pitchMode === "auto",
    forcedPitchShift,
    pitchMode,
    preset,
    lengthAdjust: 1
  };
}
