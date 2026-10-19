import { createHash } from "node:crypto";
import { VTV_PIPELINE_VERSION } from "./constants.mjs";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

function hash(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function number(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clipRecord(sample, mode, index) {
  const preparation = sample?.preparation || {};
  const durationSeconds = number(sample?.durationSeconds, number(sample?.durationMs) / 1000);
  const voicedDurationSeconds = number(sample?.voicedDurationSeconds, number(sample?.voicedDurationMs) / 1000 || durationSeconds);
  return {
    id: String(sample?.id || `clip-${index + 1}`),
    sourceSha256: String(sample?.sha256 || sample?.sourceSha256 || ""),
    audioSha256: String(sample?.audioSha256 || sample?.preparedSha256 || preparation.vocalSha256 || ""),
    relativePath: String(sample?.relativePath || sample?.audioPath || preparation.vocalRelativePath || "").replaceAll("\\", "/"),
    durationSeconds,
    voicedDurationSeconds,
    sampleRate: Math.max(0, Math.round(number(sample?.sampleRate, number(sample?.nativeSampleRate)))),
    language: String(sample?.language || sample?.transcriptLanguage || "auto"),
    transcript: String(sample?.transcript || "").trim(),
    mode,
    speakerConsistency: sample?.speakerConsistency || null,
    quality: sample?.quality || null,
    preparationStatus: String(preparation.status || sample?.status || "")
  };
}

function deterministicSplit(record, index, lockedTestRatio) {
  const digest = hash({ id: record.id, sourceSha256: record.sourceSha256, audioSha256: record.audioSha256 });
  const bucket = parseInt(digest.slice(0, 8), 16) / 0xffffffff;
  if (bucket < lockedTestRatio) return "locked-test";
  if (bucket < lockedTestRatio + 0.2) return "validation";
  return "train";
}

export function buildVtvFineTuneDataset({ profileId, modelVersionId, mode, samples = [], lockedTestRatio = 0.2 } = {}) {
  const normalizedMode = mode === "song" ? "song" : "speech";
  const normalized = (Array.isArray(samples) ? samples : [])
    .map((sample, index) => clipRecord(sample, normalizedMode, index))
    .filter((clip) => clip.relativePath && clip.audioSha256 && clip.durationSeconds > 0)
    .filter((clip) => clip.durationSeconds >= 1 && clip.durationSeconds <= 30)
    .filter((clip) => clip.voicedDurationSeconds > 0)
    .filter((clip) => clip.preparationStatus ? ["ready", "completed", "prepared"].includes(clip.preparationStatus) : true)
    .sort((left, right) => left.id.localeCompare(right.id));
  const sourceOwners = new Map();
  for (const clip of normalized) {
    const owner = clip.sourceSha256 || clip.id;
    const previous = sourceOwners.get(owner);
    if (previous && previous !== clip.id) clip.leakageGroup = owner;
    sourceOwners.set(owner, clip.id);
  }
  const entries = normalized.map((clip) => ({
    ...clip,
    split: deterministicSplit(clip, normalized.indexOf(clip), lockedTestRatio)
  }));
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.sourceSha256 || entry.id;
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const split = group[0].split;
    for (const entry of group) entry.split = split;
  }
  // The hash bucket is deterministic, but small real profiles can
  // legitimately land with no validation bucket. Preserve leakage safety
  // while guaranteeing that a usable dataset has all three required splits.
  const groupsById = [...groups.values()].sort((left, right) => left[0].id.localeCompare(right[0].id));
  const moveFirstEligibleGroup = (targetSplit, preferredSplits) => {
    if (entries.some((entry) => entry.split === targetSplit)) return;
    const group = groupsById.find((candidate) => preferredSplits.includes(candidate[0].split));
    if (!group) return;
    for (const entry of group) entry.split = targetSplit;
  };
  moveFirstEligibleGroup("validation", ["train"]);
  moveFirstEligibleGroup("locked-test", ["train", "validation"]);
  moveFirstEligibleGroup("train", ["validation", "locked-test"]);
  const dataset = {
    schemaVersion: "vtv-finetune-dataset-v1",
    pipelineVersion: VTV_PIPELINE_VERSION,
    datasetId: `vtv-dataset-${hash({ profileId, modelVersionId, mode: normalizedMode, entries }).slice(0, 24)}`,
    profileId: String(profileId || ""),
    modelVersionId: String(modelVersionId || ""),
    mode: normalizedMode,
    entries,
    splits: {
      train: entries.filter((entry) => entry.split === "train"),
      validation: entries.filter((entry) => entry.split === "validation"),
      lockedTest: entries.filter((entry) => entry.split === "locked-test")
    },
    totals: {
      clipCount: entries.length,
      durationSeconds: Number(entries.reduce((sum, entry) => sum + entry.durationSeconds, 0).toFixed(3)),
      voicedDurationSeconds: Number(entries.reduce((sum, entry) => sum + entry.voicedDurationSeconds, 0).toFixed(3))
    },
    leakageGroups: [...groups.keys()],
    createdAt: new Date().toISOString(),
    snapshotHash: hash(entries)
  };
  const errors = [];
  if (entries.length < 3) errors.push("dataset_clip_count_insufficient");
  if (!dataset.splits.validation.length) errors.push("validation_split_missing");
  if (!dataset.splits.lockedTest.length) errors.push("locked_test_split_missing");
  if (!dataset.splits.train.length) errors.push("train_split_missing");
  if (normalizedMode === "speech" && dataset.totals.voicedDurationSeconds < 60) errors.push("speech_vtv_training_seconds_below_minimum");
  if (normalizedMode === "song" && dataset.totals.voicedDurationSeconds < 60) errors.push("song_vtv_training_seconds_below_minimum");
  if (normalizedMode === "song" && entries.some((entry) => entry.sampleRate !== 44100)) errors.push("song_training_sample_rate_not_44100");
  dataset.gate = { passed: errors.length === 0, errors };
  return dataset;
}

export function createVtvCheckpointManifest({ dataset, baseModelManifestHash = "", checkpointPath = "", checkpointSha256 = "", configSha256 = "", validationReportId = "", mode = dataset?.mode } = {}) {
  return {
    schemaVersion: "vtv-finetune-checkpoint-v1",
    pipelineVersion: VTV_PIPELINE_VERSION,
    artifactType: mode === "song" ? "seed-vc-song-finetune-v1" : "seed-vc-speech-finetune-v1",
    profileId: dataset?.profileId || "",
    modelVersionId: dataset?.modelVersionId || "",
    mode,
    baseModelManifestHash,
    checkpointPath: String(checkpointPath || "").replaceAll("\\", "/"),
    checkpointSha256,
    configSha256,
    datasetManifestSha256: dataset?.snapshotHash || "",
    validationReportId,
    recommendedReferencePackId: "",
    promotionStatus: "candidate",
    createdAt: new Date().toISOString()
  };
}

export function selectVtvCheckpointForPromotion({ checkpoints = [], lockedTestReports = [] } = {}) {
  const eligible = (Array.isArray(checkpoints) ? checkpoints : []).map((checkpoint) => {
    const report = (Array.isArray(lockedTestReports) ? lockedTestReports : []).find((item) => item.checkpointSha256 === checkpoint.checkpointSha256);
    const hardPassed = report?.hardGatesPassed === true;
    const score = hardPassed ? number(report?.targetIdentityP10) * 0.5 + number(report?.contentScore) * 0.25 + number(report?.perceptualScore) * 0.25 : -1;
    return { checkpoint, report, hardPassed, score };
  }).filter((item) => item.hardPassed).sort((left, right) => right.score - left.score);
  const selected = eligible[0]?.checkpoint || null;
  return {
    selected,
    promotionStatus: selected ? "promoted" : "rejected",
    candidates: eligible,
    reason: selected ? "best_locked_test_score_after_hard_gates" : "no_checkpoint_passed_locked_test_hard_gates"
  };
}
