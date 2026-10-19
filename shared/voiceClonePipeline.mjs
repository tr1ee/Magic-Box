import path from "node:path";
import { createHash } from "node:crypto";

export const voiceClonePipelineSchemaVersion = "voice-clone-pipeline-v2";

export const voiceCloneErrorCodes = Object.freeze({
  artifactNotFound: "VOICE_ARTIFACT_NOT_FOUND",
  artifactHashMismatch: "VOICE_ARTIFACT_HASH_MISMATCH",
  artifactOutsideManagedRoot: "VOICE_ARTIFACT_OUTSIDE_MANAGED_ROOT",
  referencePackIncomplete: "VOICE_REFERENCE_PACK_INCOMPLETE",
  datasetSnapshotStale: "VOICE_DATASET_SNAPSHOT_STALE",
  fineDatasetInsufficient: "VOICE_FINE_DATASET_INSUFFICIENT",
  qualityEvaluatorUnavailable: "VOICE_QUALITY_EVALUATOR_UNAVAILABLE",
  candidateRejected: "VOICE_CANDIDATE_REJECTED"
});

function asString(value) {
  return String(value ?? "");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256Text(value) {
  return createHash("sha256").update(asString(value), "utf8").digest("hex");
}

export function voiceCloneFeatureFlags(env = {}) {
  const enabled = (name, fallback) => {
    const value = env[name];
    if (value === undefined || value === null || value === "") return fallback;
    return ["1", "true", "yes", "on", "enabled"].includes(asString(value).trim().toLowerCase());
  };
  return {
    pipelineV2: enabled("VOICE_CLONE_PIPELINE_V2_ENABLED", true),
    vtvPipelineV2: enabled("MAGICBOX_VTV_PIPELINE_V2", true),
    vtvStrictFailClosed: enabled("MAGICBOX_VTV_STRICT_FAIL_CLOSED", true),
    vtvDeterministic: enabled("MAGICBOX_VTV_DETERMINISTIC", true),
    vtvNativeSong44k: enabled("MAGICBOX_VTV_NATIVE_SONG_44K", true),
    vtvMultiEngine: enabled("VTV_MULTI_ENGINE_ENABLED", true),
    vtvRvc: enabled("VTV_RVC_ENABLED", true),
    vtvYingMusic: enabled("VTV_YINGMUSIC_ENABLED", true),
    vtvCompareMode: enabled("VTV_COMPARE_MODE_ENABLED", true),
    vtvDebugRetention: ["none", "failed", "all"].includes(asString(env.MAGICBOX_VTV_DEBUG_RETENTION || "none").trim().toLowerCase())
      ? asString(env.MAGICBOX_VTV_DEBUG_RETENTION || "none").trim().toLowerCase()
      : "none",
    referenceStrict: enabled("VOICE_CLONE_REFERENCE_STRICT_ENABLED", true),
    datasetSnapshot: enabled("VOICE_CLONE_DATASET_SNAPSHOT_ENABLED", true),
    persistAttempts: enabled("VOICE_CLONE_PERSIST_ATTEMPTS_ENABLED", true),
    dualSpeakerGate: enabled("VOICE_CLONE_DUAL_SPEAKER_GATE_ENABLED", false),
    perceptualGate: enabled("VOICE_CLONE_PERCEPTUAL_GATE_ENABLED", false),
    // Pipeline V2 keeps both content evaluators and warm worker sessions in
    // shadow mode by default.  They can still be disabled explicitly for a
    // constrained machine or a legacy rollback run.
    secondaryAsr: enabled("VOICE_CLONE_SECONDARY_ASR_ENABLED", true),
    // VTV can keep its heavyweight Seed-VC process warm between conversions.
    // It remains an explicit opt-in for machines that do not have spare GPU RAM.
    vtvPersistentWorker: enabled("MAGICBOX_VTV_PERSISTENT_WORKER", false),
    // The pool is production-ready but opt-in until the host owns an
    // explicit shutdown lifecycle for all desktop test/server embeddings.
    persistentWorkers: enabled("VOICE_CLONE_PERSISTENT_WORKERS_ENABLED", false),
    legacyBlend: enabled("VOICE_CLONE_LEGACY_BLEND_ENABLED", true)
  };
}

export function normalizeVoiceQualityMode(value, fallback = "strict") {
  const normalized = asString(value).trim().toLowerCase();
  return normalized === "balanced" ? "balanced" : normalized === "strict" ? "strict" : fallback;
}

function sampleSnapshot(sample, profileLanguage = "") {
  const preparation = sample?.preparation || {};
  return {
    id: asString(sample?.id),
    revision: Number(preparation.revision) || 1,
    sourceSha256: asString(sample?.sha256 || sample?.sourceSha256 || sample?.contentHash),
    updatedAt: asString(sample?.updatedAt),
    transcript: asString(sample?.transcript).trim(),
    transcriptLanguage: asString(sample?.transcriptLanguage || profileLanguage),
    trimStartSeconds: sample?.trimStartSeconds ?? null,
    trimEndSeconds: sample?.trimEndSeconds ?? null,
    preparation: {
      status: asString(preparation.status),
      revision: Number(preparation.revision) || 1,
      vocalSha256: asString(preparation.vocalSha256 || preparation.vocalHash),
      pipelineVersion: asString(preparation.pipelineVersion || "voice-preparation-v2")
    },
    segments: (Array.isArray(sample?.segments) ? sample.segments : [])
      .map((segment) => ({
        id: asString(segment?.id),
        audioSha256: asString(segment?.sha256 || segment?.contentHash || segment?.audioSha256),
        audioPath: asString(segment?.relativePath || segment?.audioPath),
        transcript: asString(segment?.transcript).trim(),
        transcriptLanguage: asString(segment?.transcriptLanguage || profileLanguage),
        qualityVerdict: asString(segment?.qualityVerdict),
        includeInTraining: segment?.includeInTraining !== false,
        preferredPrompt: segment?.preferredPrompt === true,
        boundary: asString(segment?.boundary),
        updatedAt: asString(segment?.updatedAt)
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  };
}

export function computeDatasetSnapshotHash({
  profileId = "",
  profileLanguage = "",
  samples = [],
  preparationPipelineVersion = "voice-preparation-v2",
  trainingEngine = "",
  trainingParameters = {},
  schemaVersion = voiceClonePipelineSchemaVersion
} = {}) {
  return sha256Text(stableJson({
    schemaVersion,
    profileId: asString(profileId),
    profileLanguage: asString(profileLanguage),
    preparationPipelineVersion,
    trainingEngine: asString(trainingEngine),
    trainingParameters: stableValue(trainingParameters),
    samples: (Array.isArray(samples) ? samples : [])
      .map((sample) => sampleSnapshot(sample, profileLanguage))
      .sort((left, right) => left.id.localeCompare(right.id))
  }));
}

export function datasetSnapshotState({ profile = {}, samples = [], trainingEngine = "", trainingParameters = {} } = {}) {
  const currentHash = computeDatasetSnapshotHash({
    profileId: profile.id,
    profileLanguage: profile.language,
    samples,
    trainingEngine: trainingEngine || profile.voiceModel?.engine || profile.engine,
    trainingParameters
  });
  const model = profile.voiceModel || {};
  const modelHash = asString(model.datasetSnapshotHash || model.trainingInputFingerprint);
  if (!modelHash) {
    return {
      modelState: "untracked",
      retrainRequired: true,
      currentSnapshotHash: currentHash,
      modelSnapshotHash: "",
      staleReasons: ["dataset_snapshot_missing"]
    };
  }
  if (modelHash !== currentHash) {
    return {
      modelState: "stale",
      retrainRequired: true,
      currentSnapshotHash: currentHash,
      modelSnapshotHash: modelHash,
      staleReasons: ["dataset_snapshot_changed"]
    };
  }
  return {
    modelState: "active",
    retrainRequired: false,
    currentSnapshotHash: currentHash,
    modelSnapshotHash: modelHash,
    staleReasons: []
  };
}

export function normalizeRelativeArtifactPath(value) {
  const normalized = asString(value).replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) return "";
  return normalized;
}

export function resolveManagedArtifactPath(managedRoot, relativePath) {
  const normalized = normalizeRelativeArtifactPath(relativePath);
  if (!normalized) {
    const error = new Error("Voice artifact path must be relative to the managed voice data root.");
    error.code = voiceCloneErrorCodes.artifactOutsideManagedRoot;
    throw error;
  }
  const root = path.resolve(asString(managedRoot));
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    const error = new Error("Voice artifact is outside the managed voice data root.");
    error.code = voiceCloneErrorCodes.artifactOutsideManagedRoot;
    throw error;
  }
  return resolved;
}

export function createArtifactRecord({
  artifactId,
  profileId,
  kind,
  relativePath,
  sha256,
  byteSize = 0,
  durationMs = 0,
  nativeSampleRate = 0,
  channels = 1,
  createdAt = new Date().toISOString()
} = {}) {
  const safeRelativePath = normalizeRelativeArtifactPath(relativePath);
  if (!safeRelativePath) throw new Error("Voice artifact relativePath is required.");
  return {
    artifactId: asString(artifactId || `artifact_${sha256Text(`${profileId}:${safeRelativePath}`).slice(0, 18)}`),
    profileId: asString(profileId),
    kind: asString(kind || "voice_artifact"),
    relativePath: safeRelativePath,
    sha256: asString(sha256).toLowerCase(),
    byteSize: Math.max(0, Math.round(Number(byteSize) || 0)),
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    nativeSampleRate: Math.max(0, Math.round(Number(nativeSampleRate) || 0)),
    channels: Math.max(1, Math.round(Number(channels) || 1)),
    createdAt: asString(createdAt) || new Date().toISOString()
  };
}

export function createReferencePackManifest({
  referencePackId,
  profileId,
  modelVersionId,
  datasetSnapshotHash,
  purpose = "seed_inference",
  language = "auto",
  recordingDomainId = "",
  artifacts = [],
  selectionPolicyVersion = "reference-selection-v2"
} = {}) {
  const safeArtifacts = (Array.isArray(artifacts) ? artifacts : []).filter(Boolean).map((artifact) => ({
    artifactId: asString(artifact.artifactId || artifact.id),
    relativePath: normalizeRelativeArtifactPath(artifact.relativePath),
    sha256: asString(artifact.sha256).toLowerCase()
  }));
  return {
    referencePackId: asString(referencePackId || `refpack_${sha256Text(`${profileId}:${purpose}:${safeArtifacts.map((item) => item.artifactId).join("|")}`).slice(0, 18)}`),
    profileId: asString(profileId),
    modelVersionId: asString(modelVersionId),
    datasetSnapshotHash: asString(datasetSnapshotHash),
    purpose: asString(purpose),
    language: asString(language || "auto"),
    recordingDomainId: asString(recordingDomainId),
    artifactIds: safeArtifacts.map((artifact) => artifact.artifactId).filter(Boolean),
    artifacts: safeArtifacts,
    totalDurationMs: Math.max(0, Math.round((Array.isArray(artifacts) ? artifacts : []).reduce((total, artifact) => total + (Number(artifact?.durationMs) || 0), 0))),
    sha256: sha256Text(stableJson(safeArtifacts)),
    selectionPolicyVersion: asString(selectionPolicyVersion),
    createdAt: new Date().toISOString()
  };
}

export function validateReferencePackManifest(pack, {
  expectedProfileId = "",
  expectedModelVersionId = "",
  expectedDatasetSnapshotHash = "",
  minimumArtifacts = 1,
  requireHashes = true
} = {}) {
  const errors = [];
  if (!pack || typeof pack !== "object") errors.push(voiceCloneErrorCodes.referencePackIncomplete);
  if (expectedProfileId && asString(pack?.profileId) !== asString(expectedProfileId)) errors.push("profile_mismatch");
  if (expectedModelVersionId && asString(pack?.modelVersionId) !== asString(expectedModelVersionId)) errors.push("model_version_mismatch");
  if (expectedDatasetSnapshotHash && asString(pack?.datasetSnapshotHash) !== asString(expectedDatasetSnapshotHash)) errors.push("dataset_snapshot_mismatch");
  const artifacts = Array.isArray(pack?.artifacts) ? pack.artifacts : [];
  if (artifacts.length < minimumArtifacts) errors.push("artifact_count_insufficient");
  if (artifacts.some((artifact) => !normalizeRelativeArtifactPath(artifact?.relativePath))) errors.push("relative_path_missing");
  if (requireHashes && artifacts.some((artifact) => !/^[a-f0-9]{64}$/iu.test(asString(artifact?.sha256)))) errors.push("artifact_hash_missing");
  return { valid: errors.length === 0, errors };
}

export function validateFineDataset(samples = [], {
  minimumSeconds = 90,
  minimumSegments = 20,
  holdoutRatio = 0.15
} = {}) {
  const eligible = (Array.isArray(samples) ? samples : []).flatMap((sample) => (
    (Array.isArray(sample?.segments) ? sample.segments : [])
      .filter((segment) => segment?.qualityVerdict === "eligible" && segment?.includeInTraining !== false && String(segment?.transcript || "").trim())
      .map((segment) => ({ sample, segment }))
  ));
  const totalSeconds = eligible.reduce((total, item) => total + (Number(item.segment.durationSeconds) || 0), 0);
  const holdoutCount = Math.max(1, Math.ceil(eligible.length * holdoutRatio));
  const missing = [];
  if (totalSeconds < minimumSeconds) missing.push(`minimum ${minimumSeconds}s clean speech (current ${Number(totalSeconds.toFixed(2))}s)`);
  if (eligible.length < minimumSegments) missing.push(`minimum ${minimumSegments} eligible segments (current ${eligible.length})`);
  if (holdoutCount < 1) missing.push("a hold-out split");
  return {
    valid: missing.length === 0,
    totalSeconds: Number(totalSeconds.toFixed(3)),
    eligibleSegmentCount: eligible.length,
    holdoutCount,
    holdoutRatio,
    missing
  };
}

function candidatePassed(candidate) {
  return candidate?.contentPassed !== false
    && candidate?.artifactPassed !== false
    && candidate?.naturalnessPassed !== false
    && candidate?.identity?.encoderA?.passed !== false
    && candidate?.identity?.encoderB?.passed !== false;
}

export function candidatePassesVoiceGates(candidate, {
  requireDualEncoder = false,
  requirePerceptual = false
} = {}) {
  if (!candidate || candidate.contentPassed === false || candidate.artifactPassed === false || candidate.naturalnessPassed === false) {
    return false;
  }
  if (candidate.identity?.encoderA?.passed === false) return false;
  if (requireDualEncoder && candidate.identity?.encoderB?.passed !== true) return false;
  if (requirePerceptual && candidate.perceptual?.passed !== true) return false;
  return true;
}

export function selectVoiceCandidate(candidates = [], {
  qualityMode = "strict",
  baseline = null,
  requireDualEncoder = false,
  requirePerceptual = false
} = {}) {
  const mode = normalizeVoiceQualityMode(qualityMode);
  const all = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const accepted = all.filter((candidate) => candidatePassesVoiceGates(candidate, {
    requireDualEncoder,
    requirePerceptual
  }));
  const rank = (candidate) => [
    (() => {
      const scores = [Number(candidate.identity?.encoderA?.score), Number(candidate.identity?.encoderB?.score)].filter(Number.isFinite);
      return scores.length ? Math.min(...scores) : 0;
    })(),
    Number(candidate.naturalness?.score) || 0,
    Number(candidate.identity?.stability) || 0,
    -Math.max(0, Math.round(Number(candidate.processingSteps) || 0)),
    Math.max(0, Math.round(Number(candidate.nativeSampleRate) || 0))
  ];
  const compare = (left, right) => {
    const leftRank = rank(left);
    const rightRank = rank(right);
    for (let index = 0; index < leftRank.length; index += 1) {
      if (leftRank[index] !== rightRank[index]) return rightRank[index] - leftRank[index];
    }
    return String(left.id || "").localeCompare(String(right.id || ""));
  };
  if (accepted.length) {
    const selected = [...accepted].sort(compare)[0];
    return { selected, accepted: true, degraded: false, warnings: [], rejected: all.filter((candidate) => !accepted.includes(candidate)) };
  }
  if (mode === "balanced" && baseline && candidatePassesVoiceGates(baseline, {
    requireDualEncoder,
    requirePerceptual
  })) {
    return {
      selected: baseline,
      accepted: true,
      degraded: true,
      warnings: ["No refined candidate passed every quality gate; the validated baseline was retained."],
      rejected: all
    };
  }
  const error = new Error("No voice candidate passed the layered content, artifact, identity, and naturalness gates.");
  error.code = voiceCloneErrorCodes.candidateRejected;
  error.details = all.map((candidate) => ({
    id: candidate.id || "unknown",
    reasons: candidate.reasons || [],
    content: candidate.qualityReport?.content || null,
    artifacts: candidate.qualityReport?.artifacts || null,
    identity: {
      encoderA: candidate.identity?.encoderA || null,
      encoderB: candidate.identity?.encoderB || null,
      stability: Number(candidate.identity?.stability) || 0
    },
    perceptual: candidate.perceptual
      ? {
          available: candidate.perceptual.available === true,
          score: Number.isFinite(Number(candidate.perceptual.utmos)) ? Number(candidate.perceptual.utmos) : null,
          evaluatorVersion: candidate.perceptual.evaluatorVersion || ""
        }
      : null,
    qualityReasons: candidate.qualityReport?.decision?.reasons || []
  }));
  throw error;
}
