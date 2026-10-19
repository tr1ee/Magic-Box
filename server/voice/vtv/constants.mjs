export const VTV_PIPELINE_VERSION = "vtv-pipeline-v2";
export const VTV_REFERENCE_PACK_SCHEMA = "vtv-reference-pack-v2";
export const VTV_SPEECH_SAMPLE_RATE = 32000;
export const VTV_SONG_SAMPLE_RATE = 44100;

export const VTV_MODES = Object.freeze(["speech", "song"]);
export const VTV_TERMINAL_STATUSES = Object.freeze([
  "completed",
  "needs-review",
  "rejected",
  "failed",
  "cancelled"
]);

export const VTV_PRESETS = Object.freeze({
  "identity-first": Object.freeze({ candidateBudget: 3, allowNeedsReview: true }),
  balanced: Object.freeze({ candidateBudget: 2, allowNeedsReview: true }),
  "source-prosody": Object.freeze({ candidateBudget: 2, allowNeedsReview: true })
});

export function isVtvMode(value) {
  return VTV_MODES.includes(String(value || "").trim().toLowerCase());
}

export function isVtvTerminalStatus(value) {
  return VTV_TERMINAL_STATUSES.includes(String(value || "").trim().toLowerCase());
}
