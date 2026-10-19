import { createHash } from "node:crypto";
import { normalizeEngineError } from "./engine-errors.mjs";

export const VTV_EXECUTION_STATUSES = Object.freeze(["queued", "running", "succeeded", "failed", "cancelled"]);
export const VTV_QUALITY_STATUSES = Object.freeze(["not-evaluated", "passed", "needs-review", "rejected"]);

export function assertEngineAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("VTV engine adapter must be an object.");
  for (const method of ["getInstallState", "healthCheck", "preflight", "normalizeSettings", "convertSong", "unload"]) {
    if (typeof adapter[method] !== "function") throw new TypeError(`VTV engine adapter ${adapter.id || "unknown"} is missing ${method}().`);
  }
  if (!String(adapter.id || "").trim()) throw new TypeError("VTV engine adapter requires a stable id.");
  return adapter;
}

export function normalizeExecutionStatus(value, fallback = "failed") {
  const status = String(value || "").toLowerCase();
  return VTV_EXECUTION_STATUSES.includes(status) ? status : fallback;
}

export function normalizeQualityStatus(value, fallback = "not-evaluated") {
  const status = String(value || "").toLowerCase();
  return VTV_QUALITY_STATUSES.includes(status) ? status : fallback;
}

export function hashBufferOrValue(value) {
  if (Buffer.isBuffer(value)) return createHash("sha256").update(value).digest("hex");
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function normalizeEngineResult(result = {}, { engineId = "" } = {}) {
  const executionStatus = normalizeExecutionStatus(result.executionStatus, result.error ? "failed" : "succeeded");
  const qualityStatus = normalizeQualityStatus(result.qualityStatus);
  return {
    ...result,
    engineId: String(result.engineId || engineId),
    executionStatus,
    qualityStatus,
    convertedVocalPath: result.convertedVocalPath ? String(result.convertedVocalPath) : null,
    sampleRate: Number.isFinite(Number(result.sampleRate)) ? Number(result.sampleRate) : null,
    durationSec: Number.isFinite(Number(result.durationSec)) ? Number(result.durationSec) : null,
    engineMetrics: result.engineMetrics && typeof result.engineMetrics === "object" ? result.engineMetrics : {},
    lineage: result.lineage && typeof result.lineage === "object" ? result.lineage : {},
    error: result.error ? normalizeEngineError(result.error, { engineId }) : null
  };
}

export function makeEngineFailure(engineId, error, extra = {}) {
  return normalizeEngineResult({
    ...extra,
    engineId,
    executionStatus: "failed",
    qualityStatus: "not-evaluated",
    error: normalizeEngineError(error, { engineId })
  }, { engineId });
}

export function makeEngineCancelled(engineId, message = "Engine run cancelled.") {
  return normalizeEngineResult({
    engineId,
    executionStatus: "cancelled",
    qualityStatus: "not-evaluated",
    error: { code: "ENGINE_CANCELLED", message, engineId }
  }, { engineId });
}
