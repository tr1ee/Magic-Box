export const RVC_PRESETS = Object.freeze({
  clean: { f0Method: "rmvpe", indexRate: 0.5, filterRadius: 3, rmsMixRate: 0.25, protect: 0.25, pitchShiftSemitones: 0, chunkSeconds: 30, chunkContextSeconds: 3, chunkCrossfadeSeconds: 0.1 },
  balanced: { f0Method: "rmvpe", indexRate: 0.65, filterRadius: 3, rmsMixRate: 0.25, protect: 0.33, pitchShiftSemitones: 0, chunkSeconds: 30, chunkContextSeconds: 3, chunkCrossfadeSeconds: 0.1 },
  identity: { f0Method: "rmvpe", indexRate: 0.75, filterRadius: 3, rmsMixRate: 0.25, protect: 0.33, pitchShiftSemitones: 0, chunkSeconds: 30, chunkContextSeconds: 3, chunkCrossfadeSeconds: 0.1 }
});

export function normalizeRvcSettings(settings = {}) {
  const preset = RVC_PRESETS[settings.preset] ? settings.preset : "identity";
  const requestedPitch = settings.pitchShiftSemitones ?? settings.pitchShift;
  const pitchShiftSemitones = Number.isFinite(Number(requestedPitch))
    ? Math.max(-24, Math.min(24, Math.round(Number(requestedPitch))))
    : RVC_PRESETS[preset].pitchShiftSemitones;
  return { ...RVC_PRESETS[preset], ...settings, pitchShiftSemitones, preset };
}
