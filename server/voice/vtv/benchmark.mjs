import { createHash } from "node:crypto";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

function hash(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export const VTV_MODEL_CATALOG = Object.freeze([
  { id: "seed-vc-speech-v1", mode: "speech", adapter: "seed-vc", status: "baseline", license: "GPL-3.0", default: true },
  { id: "seed-vc-speech-v2", mode: "speech", adapter: "seed-vc", status: "experimental", license: "GPL-3.0", default: false },
  { id: "seed-vc-speech-finetuned", mode: "speech", adapter: "seed-vc-finetune", status: "candidate", license: "GPL-3.0", default: false },
  { id: "meanvc2-experimental", mode: "speech", adapter: "meanvc2", status: "experimental", license: "unknown", default: false },
  { id: "seed-vc-song-44k", mode: "song", adapter: "seed-vc", status: "baseline", license: "GPL-3.0", default: true },
  { id: "seed-vc-song-finetuned-44k", mode: "song", adapter: "seed-vc-finetune", status: "candidate", license: "GPL-3.0", default: false },
  { id: "yingmusic-svc-experimental", mode: "song", adapter: "yingmusic-svc", status: "experimental", license: "unknown", default: false },
  { id: "hq-svc-experimental", mode: "song", adapter: "hq-svc", status: "experimental", license: "unknown", default: false }
]);

export function createVtvCandidateReportFromGpuRegression({ report, modelId, corpusHash = "", caseId = "gpu-smoke", humanReview = null } = {}) {
  const mode = report?.mode === "song" ? "song" : "speech";
  const evaluation = report?.evaluation || {};
  return createVtvCandidateReport({
    modelId: String(modelId || `${mode}-gpu-smoke`),
    mode,
    corpusHash: String(corpusHash || report?.sourceSha256 || ""),
    caseId,
    metrics: {
      ...(evaluation.metrics || {}),
      f0Evaluators: evaluation.f0Evaluators || null,
      identity: evaluation.results?.[0] || null,
      perceptual: report?.perceptual?.results?.[0]?.perceptual || null,
      artifacts: report?.artifacts?.results?.[0] || null,
      conversionDurationSeconds: Number(report?.conversion?.durationSeconds) || null,
      diffusionSteps: Number(report?.diffusionSteps) || null
    },
    runtime: {
      device: report?.health?.device || report?.conversion?.device || "",
      gpuName: report?.health?.gpuName || "",
      torchVersion: report?.health?.torchVersion || "",
      engine: report?.conversion?.engine || report?.health?.engine || "",
      modelVersion: report?.conversion?.modelVersion || report?.health?.modelVersion || "",
      seed: Number(report?.seed) || null,
      gpuAvailable: report?.health?.gpuAvailable === true,
      regressionPassed: report?.passed === true
    },
    humanReview,
    hardGatesPassed: report?.passed === true
      && evaluation?.accepted !== false
      && report?.perceptual?.available === true
      && report?.artifacts?.results?.[0]?.passed === true
  });
}

export function createVtvCandidateReport({ modelId, mode, corpusHash, caseId, metrics = {}, runtime = {}, humanReview = null, hardGatesPassed = false } = {}) {
  return {
    schemaVersion: "vtv-candidate-report-v1",
    modelId,
    mode,
    corpusHash,
    caseId,
    metrics,
    runtime,
    hardGatesPassed: hardGatesPassed === true,
    humanReview: humanReview || { state: "not-recorded", targetSimilarityPreference: null, naturalnessPreference: null, artifactTags: [] },
    reportHash: hash({ modelId, mode, corpusHash, caseId, metrics, runtime, hardGatesPassed })
  };
}

export function buildVtvPromotionReport({ mode, corpus = [], candidateReports = [], humanAbx = [], modelCatalog = VTV_MODEL_CATALOG } = {}) {
  const corpusHash = hash(corpus);
  const reports = (Array.isArray(candidateReports) ? candidateReports : []).filter((report) => report.mode === mode);
  const byModel = new Map();
  for (const report of reports) {
    const list = byModel.get(report.modelId) || [];
    list.push(report);
    byModel.set(report.modelId, list);
  }
  const modelResults = [...byModel.entries()].map(([modelId, items]) => {
    const abx = (Array.isArray(humanAbx) ? humanAbx : []).filter((item) => item.modelId === modelId);
    const hardPassRate = items.length ? items.filter((item) => item.hardGatesPassed === true).length / items.length : 0;
    const abxPreference = abx.length ? abx.filter((item) => item.preferred === true).length / abx.length : null;
    const reviewers = new Set([
      ...items.map((item) => item.humanReview?.reviewerId || item.humanReview?.reviewer || ""),
      ...abx.map((item) => item.reviewerId || item.reviewer || "")
    ].map((value) => String(value || "").trim()).filter(Boolean));
    const abxReviewers = new Set(abx.map((item) => String(item.reviewerId || item.reviewer || "").trim()).filter(Boolean));
    const completeEvidence = items.length > 0
      && items.every((item) => item.humanReview?.state === "recorded")
      && abx.length > 0
      && abxReviewers.size >= 2;
    const promotable = hardPassRate === 1 && abxPreference !== null && abxPreference >= 0.7 && completeEvidence;
    return {
      modelId,
      caseCount: items.length,
      hardPassRate,
      abxPreference,
      reviewerCount: reviewers.size,
      abxReviewerCount: abxReviewers.size,
      completeEvidence,
      promotable,
      reports: items
    };
  }).sort((left, right) => Number(right.promotable) - Number(left.promotable) || right.abxPreference - left.abxPreference || right.hardPassRate - left.hardPassRate);
  const selected = modelResults.find((item) => item.promotable) || null;
  return {
    schemaVersion: "vtv-promotion-report-v1",
    mode,
    corpusHash,
    corpusCaseCount: Array.isArray(corpus) ? corpus.length : 0,
    models: modelResults,
    selectedModelId: selected?.modelId || null,
    promotionStatus: selected ? "promoted" : "blocked",
    blockingReasons: selected ? [] : ["no_model_has_complete_hard_gate_and_human_abx_evidence"],
    catalog: (Array.isArray(modelCatalog) ? modelCatalog : []).filter((item) => item.mode === mode),
    createdAt: new Date().toISOString(),
    reportHash: hash({ mode, corpusHash, modelResults })
  };
}
