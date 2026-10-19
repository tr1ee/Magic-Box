import { createHash } from "node:crypto";
import { VTV_PIPELINE_VERSION, VTV_PRESETS } from "./constants.mjs";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function uint32FromHash(value) {
  const digest = createHash("sha256").update(String(value), "utf8").digest();
  return digest.readUInt32BE(0);
}

export function deriveVtvJobSeed({
  sourceSha256 = "",
  referencePackSha256 = "",
  modelCheckpointSha256 = "",
  pipelineVersion = VTV_PIPELINE_VERSION,
  normalizedSettings = {}
} = {}) {
  return uint32FromHash(stableJson({ sourceSha256, referencePackSha256, modelCheckpointSha256, pipelineVersion, normalizedSettings }));
}

export function deriveVtvCandidateSeed(jobBaseSeed, candidateIndex, presetId = "identity-first") {
  return uint32FromHash(stableJson({ jobBaseSeed: Number(jobBaseSeed) >>> 0, candidateIndex: Number(candidateIndex) || 0, presetId }));
}

export function deriveVtvRepairSeed(candidateSeed, intervalStartMs, repairIndex) {
  return uint32FromHash(stableJson({ candidateSeed: Number(candidateSeed) >>> 0, intervalStartMs: Number(intervalStartMs) || 0, repairIndex: Number(repairIndex) || 0 }));
}

export function normalizeVtvSettings(settings = {}, { mode = "speech" } = {}) {
  const normalizedMode = String(mode || settings.mode || "speech").trim().toLowerCase();
  const requestedPreset = String(settings.qualityPreset || settings.presetId || "identity-first").trim().toLowerCase();
  const presetId = VTV_PRESETS[requestedPreset] ? requestedPreset : "identity-first";
  const preset = VTV_PRESETS[presetId];
  const requestedBudget = Number(settings.candidateBudget);
  const candidateBudget = Number.isInteger(requestedBudget)
    ? Math.max(1, Math.min(3, requestedBudget))
    : preset.candidateBudget;
  const debugRetention = ["none", "failed", "all"].includes(String(settings.debugRetention || "failed"))
    ? String(settings.debugRetention || "failed")
    : "failed";
  return {
    pipelineVersion: VTV_PIPELINE_VERSION,
    mode: normalizedMode,
    qualityPreset: presetId,
    presetId,
    candidateBudget,
    allowNeedsReview: settings.allowNeedsReview !== false && preset.allowNeedsReview,
    sourceEnhancementPolicy: ["auto", "never", "required"].includes(String(settings.sourceEnhancementPolicy || "auto")) ? String(settings.sourceEnhancementPolicy || "auto") : "auto",
    separatorPolicy: ["auto", "htdemucs", "fixed"].includes(String(settings.separatorPolicy || "auto")) ? String(settings.separatorPolicy || "auto") : "auto",
    debugRetention,
    nativeSampleRate: normalizedMode === "song" ? 44100 : 32000
  };
}

export function planVtvCandidates({ jobBaseSeed, candidateBudget = 3, presetId = "identity-first", kind = "full" } = {}) {
  const budget = Math.max(1, Math.min(3, Math.round(Number(candidateBudget) || 3)));
  return Array.from({ length: budget }, (_, index) => ({
    candidateId: `vtv-${kind}-${index + 1}`,
    candidateIndex: index,
    presetId,
    seed: deriveVtvCandidateSeed(jobBaseSeed, index, presetId)
  }));
}
