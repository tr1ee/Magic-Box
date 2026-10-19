import { createHash } from "node:crypto";

export const VTV_CORPUS_SCHEMA = "vtv-corpus-manifest-v1";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function hash(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function positiveNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeCase(item, mode, index) {
  const categories = Array.isArray(item?.categories)
    ? item.categories.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
    : [String(item?.category || "").trim().toLowerCase()].filter(Boolean);
  return {
    id: String(item?.id || `${mode}-${index + 1}`),
    mode,
    path: String(item?.path || item?.relativePath || "").replaceAll("\\", "/"),
    sha256: String(item?.sha256 || "").toLowerCase(),
    sourceSha256: String(item?.sourceSha256 || item?.sha256 || "").toLowerCase(),
    targetProfileId: String(item?.targetProfileId || ""),
    targetReferencePath: String(item?.targetReferencePath || "").replaceAll("\\", "/"),
    targetReferencePaths: [...new Set((Array.isArray(item?.targetReferencePaths) ? item.targetReferencePaths : [item?.targetReferencePath]).map((value) => String(value || "").replaceAll("\\", "/")).filter(Boolean))],
    categories: [...new Set(categories)],
    durationSeconds: Number(positiveNumber(item?.durationSeconds, positiveNumber(item?.durationMs) / 1000).toFixed(3)),
    sampleRate: Math.max(0, Math.round(Number(item?.sampleRate) || 0)),
    channels: Math.max(0, Math.round(Number(item?.channels) || 0)),
    legalUseConfirmed: item?.legalUseConfirmed === true,
    split: String(item?.split || "").trim().toLowerCase() || null,
    notes: String(item?.notes || "")
  };
}

export function buildVtvCorpusManifest({
  corpusVersion = "",
  speech = [],
  song = [],
  requiredSpeechCategories = [],
  minimumSpeechCases = 12,
  minimumSpeechProfiles = 3,
  minimumSongCases = 8,
  minimumSongProfiles = 1
} = {}) {
  const cases = [
    ...(Array.isArray(speech) ? speech : []).map((item, index) => normalizeCase(item, "speech", index)),
    ...(Array.isArray(song) ? song : []).map((item, index) => normalizeCase(item, "song", index))
  ];
  const ids = new Set();
  const errors = [];
  for (const item of cases) {
    if (!item.id || ids.has(item.id)) errors.push(`duplicate_case_id:${item.id || "missing"}`);
    ids.add(item.id);
    if (!item.path) errors.push(`case_path_missing:${item.id}`);
    if (!/^[a-f0-9]{64}$/u.test(item.sha256)) errors.push(`case_hash_missing:${item.id}`);
    if (!/^[a-f0-9]{64}$/u.test(item.sourceSha256)) errors.push(`source_hash_missing:${item.id}`);
    if (item.durationSeconds <= 0) errors.push(`case_duration_missing:${item.id}`);
    if (item.mode === "song" && item.sampleRate !== 44100) errors.push(`song_sample_rate_not_44100:${item.id}`);
    if (item.mode === "speech" && item.sampleRate !== 32000) errors.push(`speech_sample_rate_not_32000:${item.id}`);
    if (!item.legalUseConfirmed) errors.push(`legal_use_unconfirmed:${item.id}`);
  }
  const speechCases = cases.filter((item) => item.mode === "speech");
  const songCases = cases.filter((item) => item.mode === "song");
  const speechCategories = new Set(speechCases.flatMap((item) => item.categories));
  const speechProfiles = new Set(speechCases.map((item) => item.targetProfileId).filter(Boolean));
  const songProfiles = new Set(songCases.map((item) => item.targetProfileId).filter(Boolean));
  for (const category of requiredSpeechCategories) {
    if (!speechCategories.has(String(category).trim().toLowerCase())) errors.push(`speech_category_missing:${category}`);
  }
  if (speechCases.length < minimumSpeechCases) errors.push("speech_case_count_below_minimum");
  if (speechProfiles.size < minimumSpeechProfiles) errors.push("speech_profile_count_below_minimum");
  if (songCases.length < minimumSongCases) errors.push("song_case_count_below_minimum");
  if (songProfiles.size < minimumSongProfiles) errors.push("song_profile_count_below_minimum");
  const sourceGroups = new Map();
  for (const item of cases) {
    const group = sourceGroups.get(item.sourceSha256) || [];
    group.push(item.id);
    sourceGroups.set(item.sourceSha256, group);
  }
  const splitErrors = [];
  for (const [sourceSha256, group] of sourceGroups) {
    const splits = new Set(group.map((id) => cases.find((item) => item.id === id)?.split).filter(Boolean));
    if (splits.size > 1) splitErrors.push(`source_leakage_group_crosses_splits:${sourceSha256}`);
  }
  errors.push(...splitErrors);
  const normalizedCases = cases.sort((left, right) => left.id.localeCompare(right.id));
  const manifest = {
    schemaVersion: VTV_CORPUS_SCHEMA,
    corpusVersion: String(corpusVersion || ""),
    requirements: {
      requiredSpeechCategories: [...new Set((Array.isArray(requiredSpeechCategories) ? requiredSpeechCategories : []).map((value) => String(value).trim().toLowerCase()).filter(Boolean))],
      minimumSpeechCases,
      minimumSpeechProfiles,
      minimumSongCases,
      minimumSongProfiles
    },
    cases: normalizedCases,
    counts: {
      total: normalizedCases.length,
      speech: speechCases.length,
      song: songCases.length,
      speechProfiles: speechProfiles.size,
      songProfiles: songProfiles.size,
      speechCategories: speechCategories.size
    },
    leakageGroups: [...sourceGroups.entries()].map(([sourceSha256, caseIds]) => ({ sourceSha256, caseIds })).sort((a, b) => a.sourceSha256.localeCompare(b.sourceSha256)),
    gate: { passed: errors.length === 0, errors: [...new Set(errors)] },
    createdAt: new Date().toISOString()
  };
  manifest.corpusHash = hash({ ...manifest, createdAt: undefined, corpusHash: undefined });
  return manifest;
}

export function validateVtvCorpusManifest(manifest, options = {}) {
  const requirements = manifest?.requirements || {};
  const rebuilt = buildVtvCorpusManifest({
    corpusVersion: manifest?.corpusVersion,
    speech: (manifest?.cases || []).filter((item) => item.mode === "speech"),
    song: (manifest?.cases || []).filter((item) => item.mode === "song"),
    requiredSpeechCategories: options.requiredSpeechCategories ?? requirements.requiredSpeechCategories ?? [],
    minimumSpeechCases: options.minimumSpeechCases ?? requirements.minimumSpeechCases ?? 12,
    minimumSpeechProfiles: options.minimumSpeechProfiles ?? requirements.minimumSpeechProfiles ?? 3,
    minimumSongCases: options.minimumSongCases ?? requirements.minimumSongCases ?? 8,
    minimumSongProfiles: options.minimumSongProfiles ?? requirements.minimumSongProfiles ?? 1
  });
  const errors = [...rebuilt.gate.errors];
  if (manifest?.schemaVersion !== VTV_CORPUS_SCHEMA) errors.unshift("schema_version_mismatch");
  if (manifest?.corpusHash && manifest.corpusHash !== rebuilt.corpusHash) errors.unshift("corpus_hash_mismatch");
  return { valid: errors.length === 0, errors: [...new Set(errors)], manifest: rebuilt };
}
