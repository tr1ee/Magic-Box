import { makeEngineCancelled, makeEngineFailure, normalizeEngineResult } from "./engine-contract.mjs";
import { buildComparisonReport, comparisonGroupId, computeParentExecutionStatus } from "./comparison-report.mjs";

function combineQualityStatus(convertedStatus, finalStatus) {
  const statuses = [convertedStatus, finalStatus].filter(Boolean);
  if (statuses.includes("rejected")) return "rejected";
  if (statuses.includes("needs-review")) return "needs-review";
  if (statuses.length && statuses.every((status) => status === "passed")) return "passed";
  return finalStatus || convertedStatus || "not-evaluated";
}

export async function runMultiEngineSongVtvJob({
  jobId,
  engineIds,
  registry,
  shared,
  settings = {},
  signal = null,
  gpuLeaseManager,
  prepareEngineContext = async (engineId) => ({ engineId }),
  mixFinal,
  evaluateConverted = async () => ({ qualityStatus: "not-evaluated" }),
  evaluateFinal = async () => ({ qualityStatus: "not-evaluated" }),
  persistSuccess = async ({ result }) => result,
  persistFailure = async ({ result }) => result,
  onProgress = null,
  groupId = comparisonGroupId(jobId),
  separator = {}
} = {}) {
  const results = [];
  for (const engineId of [...new Set((engineIds || []).map(String))]) {
    if (signal?.aborted) {
      results.push(makeEngineCancelled(engineId));
      continue;
    }
    const adapter = registry.require(engineId);
    const engineRun = { jobId, engineRunId: `${groupId}:${engineId}`, engineId, shared, settings, comparisonGroupId: groupId };
    let lease = null;
    let adapterUnloaded = false;
    try {
      onProgress?.({ engineId, stage: "preflight", progress: 0 });
      const preparedContext = await prepareEngineContext(engineId, engineRun);
      const preflight = await adapter.preflight(preparedContext);
      if (!preflight?.ready) {
        const failure = makeEngineFailure(engineId, {
          code: preflight?.error?.code || "ENGINE_RUNTIME_UNHEALTHY",
          message: preflight?.error?.message || preflight?.errors?.join("; ") || "Engine preflight failed.",
          action: preflight?.action || "Repair the selected engine runtime or target artifact.",
          details: { errors: preflight?.errors || [], warnings: preflight?.warnings || [] }
        }, { lineage: preflight?.runtimeLineage || {} });
        results.push(await persistFailure({ engineRun, result: failure, preflight }));
        continue;
      }
      lease = gpuLeaseManager ? await gpuLeaseManager.acquire({ jobId, engineId, signal }) : null;
      onProgress?.({ engineId, stage: "inference", progress: 0.1 });
      const converted = await adapter.convertSong({
        ...engineRun,
        ...preparedContext,
        ...preflight,
        target: preflight.resolvedTarget,
        runtimeManifest: preflight.runtimeLineage,
        onEngineProgress: (event = {}) => onProgress?.({
          engineId,
          stage: event.stage || "inference",
          progress: event.progress != null && Number.isFinite(Number(event.progress)) ? Number(event.progress) : 0.1,
          elapsedSec: Number(event.elapsedSec) || 0,
          sourceDurationSec: Number(event.sourceDurationSec) || 0
        })
      }, signal);
      const normalizedConverted = normalizeEngineResult({ ...converted, engineId, executionStatus: "succeeded" }, { engineId });
      // Conversion output is already materialized on disk. Release the large
      // inference model before loading the independent pitch/identity quality
      // evaluator so a 12 GB GPU is not forced into avoidable memory pressure.
      await adapter.unload();
      adapterUnloaded = true;
      const convertedQuality = await evaluateConverted({ engineRun, converted: normalizedConverted, preflight });
      const mixed = await mixFinal({ engineRun, converted: normalizedConverted, preflight, signal });
      const finalQuality = await evaluateFinal({ engineRun, converted: normalizedConverted, mixed, preflight });
      const qualityStatus = combineQualityStatus(convertedQuality?.qualityStatus, finalQuality?.qualityStatus);
      const result = normalizeEngineResult({
        ...normalizedConverted,
        ...convertedQuality,
        ...finalQuality,
        ...mixed,
        quality: { ...(convertedQuality?.quality || {}), ...(finalQuality?.quality || {}) },
        qualityStatus,
        outputId: mixed?.outputId || null,
        finalAudioSha256: mixed?.finalAudioSha256 || null,
        lineage: { ...normalizedConverted.lineage, ...(preflight.runtimeLineage || {}) }
      }, { engineId });
      results.push(await persistSuccess({ engineRun, result, converted: normalizedConverted, mixed, preflight, convertedQuality, finalQuality }));
      onProgress?.({ engineId, stage: "completed", progress: 1 });
    } catch (error) {
      const result = makeEngineFailure(engineId, error);
      results.push(await persistFailure({ engineRun, result, error }));
      onProgress?.({ engineId, stage: "failed", progress: 1, error: result.error });
    } finally {
      if (!adapterUnloaded) {
        try { await adapter.unload(); } catch {}
      }
      await lease?.release?.();
    }
  }
  return {
    comparisonGroupId: groupId,
    executionStatus: computeParentExecutionStatus(results, { cancelled: Boolean(signal?.aborted) }),
    shared,
    results,
    report: buildComparisonReport({ groupId, jobId, shared, results, separator })
  };
}
