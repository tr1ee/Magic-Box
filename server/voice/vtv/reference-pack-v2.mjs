import { createHash } from "node:crypto";
import { VTV_PIPELINE_VERSION, VTV_REFERENCE_PACK_SCHEMA } from "./constants.mjs";

function hashText(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function number(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function durationSeconds(clip) {
  return number(clip?.durationSeconds, number(clip?.durationMs) / 1000);
}

function voicedDurationSeconds(clip) {
  return number(clip?.voicedDurationSeconds, number(clip?.voicedDurationMs) / 1000 || durationSeconds(clip));
}

/** Build a deterministic, mode-specific pack from already-QC'd clip records. */
export function createVtvReferencePackV2({
  profileId,
  modelVersionId,
  mode,
  clips = [],
  speakerCentroids = {},
  qualitySummary = {},
  evaluatorVersions = {},
  minimumVoicedSeconds = mode === "song" ? 20 : 15,
  maximumClips = 8
} = {}) {
  const eligible = (Array.isArray(clips) ? clips : [])
    .filter((clip) => clip && clip.quality?.passed !== false && clip.speakerConsistency?.passed !== false)
    .filter((clip) => voicedDurationSeconds(clip) > 0)
    .map((clip) => ({
      artifactId: String(clip.artifactId || clip.id || ""),
      relativePath: String(clip.relativePath || "").replaceAll("\\", "/"),
      sha256: String(clip.sha256 || hashText(`${clip.artifactId || clip.id}:${clip.relativePath}`)).toLowerCase(),
      durationMs: Math.round(durationSeconds(clip) * 1000),
      voicedDurationMs: Math.round(voicedDurationSeconds(clip) * 1000),
      language: String(clip.language || "auto"),
      pitchRange: clip.pitchRange || null,
      recordingDomainId: String(clip.recordingDomainId || "")
    }))
    .filter((clip) => clip.artifactId && clip.relativePath && /^[a-f0-9]{64}$/iu.test(clip.sha256))
    .sort((left, right) => right.voicedDurationMs - left.voicedDurationMs || left.artifactId.localeCompare(right.artifactId));
  const selected = [];
  const domains = new Set();
  for (const clip of eligible) {
    if (selected.length >= Math.max(1, maximumClips)) break;
    if (clip.recordingDomainId && domains.has(clip.recordingDomainId) && selected.length < Math.min(2, maximumClips)) continue;
    selected.push(clip);
    if (clip.recordingDomainId) domains.add(clip.recordingDomainId);
  }
  const voicedDurationMs = selected.reduce((sum, clip) => sum + clip.voicedDurationMs, 0);
  const safeSpeakerCentroids = {
    campplus: String(speakerCentroids?.campplus || ""),
    eres2netv2: String(speakerCentroids?.eres2netv2 || "")
  };
  const safeQualitySummary = qualitySummary && typeof qualitySummary === "object" ? qualitySummary : {};
  const pack = {
    schemaVersion: VTV_REFERENCE_PACK_SCHEMA,
    pipelineVersion: VTV_PIPELINE_VERSION,
    packId: `vtv-refpack-${hashText(`${profileId}:${modelVersionId}:${mode}:${selected.map((clip) => clip.sha256).join("|")}`).slice(0, 24)}`,
    profileId: String(profileId || ""),
    modelVersionId: String(modelVersionId || ""),
    mode: String(mode || ""),
    artifactIds: selected.map((clip) => clip.artifactId),
    clipSha256: selected.map((clip) => clip.sha256),
    artifacts: selected,
    speakerCentroids: safeSpeakerCentroids,
    qualitySummary: safeQualitySummary,
    evaluatorVersions: evaluatorVersions && typeof evaluatorVersions === "object" ? evaluatorVersions : {},
    totalDurationSec: Number((selected.reduce((sum, clip) => sum + clip.durationMs, 0) / 1000).toFixed(3)),
    totalVoicedDurationSec: Number((voicedDurationMs / 1000).toFixed(3)),
    health: {
      status: voicedDurationMs / 1000 >= minimumVoicedSeconds ? "ready" : "insufficient",
      selectedClipCount: selected.length,
      requiredVoicedDurationSec: minimumVoicedSeconds,
      languageCount: new Set(selected.map((clip) => clip.language)).size,
      recordingDomainCount: domains.size
    },
    sha256: hashText(JSON.stringify({ selected, speakerCentroids: safeSpeakerCentroids, qualitySummary: safeQualitySummary, evaluatorVersions })),
    createdAt: new Date().toISOString()
  };
  return pack;
}

export function validateVtvReferencePackV2(pack, { profileId = "", modelVersionId = "", mode = "", requireReady = true } = {}) {
  const errors = [];
  if (pack?.schemaVersion !== VTV_REFERENCE_PACK_SCHEMA) errors.push("schema_version_mismatch");
  if (pack?.pipelineVersion !== VTV_PIPELINE_VERSION) errors.push("pipeline_version_mismatch");
  if (profileId && pack?.profileId !== profileId) errors.push("profile_mismatch");
  if (modelVersionId && pack?.modelVersionId !== modelVersionId) errors.push("model_version_mismatch");
  if (mode && pack?.mode !== mode) errors.push("mode_mismatch");
  if (!Array.isArray(pack?.artifacts) || pack.artifacts.length < 2) errors.push("clip_count_insufficient");
  if (requireReady && pack?.health?.status !== "ready") errors.push("reference_pack_not_ready");
  if ((pack?.artifacts || []).some((artifact) => !artifact.relativePath || !/^[a-f0-9]{64}$/iu.test(artifact.sha256 || ""))) errors.push("artifact_lineage_incomplete");
  if (requireReady && (!pack?.speakerCentroids?.campplus || !pack?.speakerCentroids?.eres2netv2)) errors.push("speaker_centroid_evidence_missing");
  return { valid: errors.length === 0, errors };
}
