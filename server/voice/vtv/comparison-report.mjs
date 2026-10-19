import { createHash } from "node:crypto";
import { makeEngineFailure, normalizeEngineResult } from "./engine-contract.mjs";

export function comparisonGroupId(seed = "") {
  const value = `${seed}:${Date.now()}:${Math.random()}`;
  return `vtv-compare-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export function computeParentExecutionStatus(results = [], { cancelled = false } = {}) {
  const normalized = results.map((item) => normalizeEngineResult(item, { engineId: item?.engineId }));
  const succeeded = normalized.filter((item) => item.executionStatus === "succeeded").length;
  const failed = normalized.filter((item) => item.executionStatus === "failed").length;
  const cancelledCount = normalized.filter((item) => item.executionStatus === "cancelled").length;
  if (cancelled && succeeded) return "partial-cancelled";
  if (cancelled && !succeeded && cancelledCount) return "cancelled";
  if (succeeded === normalized.length && normalized.length) return "succeeded";
  if (succeeded) return "partial";
  if (failed === normalized.length && normalized.length) return "failed";
  return cancelled ? "cancelled" : "failed";
}

export function buildComparisonReport({ groupId, jobId = "", shared = {}, results = [], separator = {}, profileId = "" } = {}) {
  const normalized = results.map((result) => normalizeEngineResult(result, { engineId: result?.engineId }));
  return {
    schemaVersion: 1,
    comparisonGroupId: groupId || comparisonGroupId(jobId),
    jobId: String(jobId || ""),
    sourceSha256: String(shared.sourceHash || ""),
    leadStemSha256: String(shared.stemHash || shared.leadStemHash || ""),
    accompanimentSha256: String(shared.accompanimentHash || ""),
    profileId: String(profileId || ""),
    createdAt: new Date().toISOString(),
    executionStatus: computeParentExecutionStatus(normalized),
    separator: separator && typeof separator === "object" ? separator : {},
    rankingPreview: { enabled: false, reason: "human-listening-calibration-not-complete" },
    results: normalized.map((result) => ({
      engineId: result.engineId,
      executionStatus: result.executionStatus,
      qualityStatus: result.qualityStatus,
      outputId: result.outputId || null,
      finalAudioSha256: result.finalAudioSha256 || null,
      identity: result.identity || {},
      pitch: result.pitch || {},
      artifacts: result.artifacts || {},
      performance: result.performance || {},
      error: result.error || null
    }))
  };
}

export function buildEngineSidecar({ groupId, outputId, engineId, result, source = {}, target = {}, runtime = {}, settings = {}, finalAudio = {}, quality = {} } = {}) {
  const normalized = normalizeEngineResult(result, { engineId });
  const runtimeSummary = {
    engineId: String(runtime.engineId || engineId),
    runtimeVersion: String(runtime.runtimeVersion || ""),
    sourceRevision: String(runtime.sourceRevision || ""),
    sourceArchiveSha256: String(runtime.sourceArchiveSha256 || ""),
    patchedTreeHash: String(runtime.patchedTreeHash || ""),
    runtimeManifestSha256: String(runtime.runtimeManifestSha256 || "")
  };
  const targetSummary = {
    type: String(target.type || target.architecture || ""),
    artifactId: String(target.artifactId || target.modelId || ""),
    profileId: String(target.profileId || ""),
    profileVersionId: String(target.profileVersionId || ""),
    sha256: String(target.sha256 || target.weights?.sha256 || ""),
    modelSha256: String(target.weights?.sha256 || ""),
    indexSha256: String(target.index?.sha256 || "")
  };
  return {
    schemaVersion: 2,
    outputId: String(outputId || ""),
    comparisonGroupId: groupId || null,
    engineId: String(engineId || normalized.engineId),
    executionStatus: normalized.executionStatus,
    qualityStatus: normalized.qualityStatus,
    source: { sha256: source.sourceHash || "", leadStemSha256: source.stemHash || "", accompanimentSha256: source.accompanimentHash || "" },
    target: targetSummary,
    runtime: runtimeSummary,
    settings: settings && typeof settings === "object" ? settings : {},
    quality: quality && typeof quality === "object" ? quality : {},
    finalAudio: finalAudio && typeof finalAudio === "object" ? finalAudio : {}
  };
}

export function publicVtvEngineResult(result, { mapOutput = (output) => output } = {}) {
  if (!result || typeof result !== "object") return result;
  const { buffer: _audioBuffer, ...publicResult } = result;
  return publicResult.output
    ? { ...publicResult, output: mapOutput(publicResult.output) }
    : publicResult;
}

export { makeEngineFailure };
