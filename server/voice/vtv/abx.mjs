import { createHash } from "node:crypto";

export const VTV_ABX_SCHEMA = "vtv-abx-evidence-v1";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

function hash(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function text(value) {
  return String(value || "").trim();
}

function normalizeResponse(response, index) {
  const presented = Array.isArray(response?.presentedLabels)
    ? response.presentedLabels.map((value) => text(value).toUpperCase()).filter(Boolean)
    : [];
  return {
    responseId: text(response?.responseId) || `abx-response-${index + 1}`,
    reviewerId: text(response?.reviewerId),
    caseId: text(response?.caseId),
    dimension: text(response?.dimension).toLowerCase(),
    preferredLabel: text(response?.preferredLabel).toUpperCase(),
    presentedLabels: [...new Set(presented)],
    assignmentId: text(response?.assignmentId),
    assignmentHash: text(response?.assignmentHash).toLowerCase(),
    artifactTags: Array.isArray(response?.artifactTags) ? response.artifactTags.map(text).filter(Boolean).slice(0, 20) : [],
    recordedAt: text(response?.recordedAt),
    notes: text(response?.notes)
  };
}

export function validateVtvAbxEvidence({ mode, corpus = [], responses = [], requiredReviewers = 2 } = {}) {
  const normalizedMode = mode === "song" ? "song" : "speech";
  const cases = new Set((Array.isArray(corpus) ? corpus : []).map((item) => text(item?.caseId || item?.id)).filter(Boolean));
  const errors = [];
  const normalized = (Array.isArray(responses) ? responses : []).map(normalizeResponse);
  const reviewers = new Set();
  const dimensions = normalizedMode === "song"
    ? ["target-singer", "melody", "lyrics", "residual", "artifact", "mix"]
    : ["target-similarity", "naturalness", "content", "artifact", "consistency"];
  const seen = new Set();
  for (const response of normalized) {
    if (!response.reviewerId) errors.push(`reviewer_missing:${response.responseId}`);
    else reviewers.add(response.reviewerId);
    if (!response.caseId || (cases.size && !cases.has(response.caseId))) errors.push(`case_invalid:${response.responseId}`);
    if (!dimensions.includes(response.dimension)) errors.push(`dimension_invalid:${response.responseId}`);
    if (!['A', 'B', 'TIE'].includes(response.preferredLabel)) errors.push(`preference_invalid:${response.responseId}`);
    if (response.presentedLabels.length !== 2 || response.presentedLabels.some((label) => !['A', 'B'].includes(label))) {
      errors.push(`presented_labels_invalid:${response.responseId}`);
    }
    if (!response.assignmentId || !/^[a-f0-9]{16,128}$/u.test(response.assignmentHash)) errors.push(`blind_assignment_missing:${response.responseId}`);
    if (!response.recordedAt || Number.isNaN(Date.parse(response.recordedAt))) errors.push(`recorded_at_missing:${response.responseId}`);
    const key = `${response.reviewerId}|${response.caseId}|${response.dimension}`;
    if (seen.has(key)) errors.push(`duplicate_response:${key}`);
    seen.add(key);
  }
  if (reviewers.size < Math.max(2, Number(requiredReviewers) || 2)) errors.push("reviewer_count_below_minimum");
  if (!normalized.length) errors.push("abx_response_missing");
  if (cases.size) {
    for (const caseId of cases) {
      for (const dimension of dimensions) {
        for (const reviewerId of reviewers) {
          if (!seen.has(`${reviewerId}|${caseId}|${dimension}`)) errors.push(`coverage_missing:${reviewerId}:${caseId}:${dimension}`);
        }
      }
    }
  }
  const valid = errors.length === 0;
  return {
    schemaVersion: VTV_ABX_SCHEMA,
    mode: normalizedMode,
    valid,
    errors: [...new Set(errors)],
    reviewerCount: reviewers.size,
    responseCount: normalized.length,
    caseCount: cases.size,
    dimensions,
    responses: normalized,
    evidenceHash: hash({ mode: normalizedMode, cases: [...cases].sort(), responses: normalized })
  };
}

export function summarizeVtvAbxEvidence(evidence) {
  const responses = Array.isArray(evidence?.responses) ? evidence.responses : [];
  const grouped = new Map();
  for (const response of responses) {
    const key = `${response.caseId}|${response.dimension}`;
    const row = grouped.get(key) || { caseId: response.caseId, dimension: response.dimension, counts: { A: 0, B: 0, TIE: 0 } };
    row.counts[response.preferredLabel] = (row.counts[response.preferredLabel] || 0) + 1;
    grouped.set(key, row);
  }
  const totals = { A: 0, B: 0, TIE: 0 };
  for (const row of grouped.values()) for (const label of Object.keys(totals)) totals[label] += row.counts[label] || 0;
  return {
    schemaVersion: "vtv-abx-summary-v1",
    mode: evidence?.mode || null,
    valid: evidence?.valid === true,
    reviewerCount: Number(evidence?.reviewerCount) || 0,
    responseCount: responses.length,
    totals,
    groups: [...grouped.values()].sort((left, right) => `${left.caseId}|${left.dimension}`.localeCompare(`${right.caseId}|${right.dimension}`)),
    evidenceHash: evidence?.evidenceHash || null
  };
}
