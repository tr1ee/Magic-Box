export const VTV_ENGINE_ERROR_CODES = Object.freeze({
  ENGINE_NOT_INSTALLED: "ENGINE_NOT_INSTALLED",
  ENGINE_RUNTIME_UNHEALTHY: "ENGINE_RUNTIME_UNHEALTHY",
  ENGINE_VERSION_INCOMPATIBLE: "ENGINE_VERSION_INCOMPATIBLE",
  ENGINE_WORKER_START_FAILED: "ENGINE_WORKER_START_FAILED",
  ENGINE_WORKER_PROTOCOL_ERROR: "ENGINE_WORKER_PROTOCOL_ERROR",
  ENGINE_TIMEOUT: "ENGINE_TIMEOUT",
  ENGINE_CANCELLED: "ENGINE_CANCELLED",
  ENGINE_GPU_OOM: "ENGINE_GPU_OOM",
  ENGINE_OUTPUT_MISSING: "ENGINE_OUTPUT_MISSING",
  ENGINE_OUTPUT_INVALID: "ENGINE_OUTPUT_INVALID",
  ENGINE_MODEL_MISSING: "ENGINE_MODEL_MISSING",
  ENGINE_MODEL_INCOMPATIBLE: "ENGINE_MODEL_INCOMPATIBLE",
  ENGINE_MODEL_HASH_MISMATCH: "ENGINE_MODEL_HASH_MISMATCH",
  TARGET_REFERENCE_INVALID: "TARGET_REFERENCE_INVALID",
  TARGET_MODEL_NOT_BOUND: "TARGET_MODEL_NOT_BOUND",
  SEPARATOR_FAILED: "SEPARATOR_FAILED",
  SHARED_STEM_INVALID: "SHARED_STEM_INVALID",
  QUALITY_REJECTED: "QUALITY_REJECTED",
  RVC_MODEL_INSPECTION_FAILED: "RVC_MODEL_INSPECTION_FAILED",
  RVC_INDEX_MISSING: "RVC_INDEX_MISSING",
  RVC_INDEX_INCOMPATIBLE: "RVC_INDEX_INCOMPATIBLE",
  RVC_TRAINING_DATA_INSUFFICIENT: "RVC_TRAINING_DATA_INSUFFICIENT",
  RVC_TRAINING_FAILED: "RVC_TRAINING_FAILED",
  YINGMUSIC_CHECKPOINT_MISSING: "YINGMUSIC_CHECKPOINT_MISSING",
  YINGMUSIC_CONFIG_MISMATCH: "YINGMUSIC_CONFIG_MISMATCH",
  YINGMUSIC_REFERENCE_TOO_SHORT: "YINGMUSIC_REFERENCE_TOO_SHORT",
  YINGMUSIC_REFERENCE_TOO_LONG: "YINGMUSIC_REFERENCE_TOO_LONG",
  YINGMUSIC_ADAPTIVE_F0_UNSAFE: "YINGMUSIC_ADAPTIVE_F0_UNSAFE"
});

export class VtvEngineError extends Error {
  constructor(code, message, { engineId = "", action = "", details = null, cause = null } = {}) {
    super(String(message || code), cause ? { cause } : undefined);
    this.name = "VtvEngineError";
    this.code = String(code || "ENGINE_WORKER_PROTOCOL_ERROR");
    this.engineId = String(engineId || "");
    this.action = String(action || "");
    this.details = details && typeof details === "object" ? details : null;
  }
}

export function normalizeEngineError(error, { engineId = "" } = {}) {
  if (error instanceof VtvEngineError) {
    return {
      code: error.code,
      message: error.message,
      action: error.action || "",
      engineId: error.engineId || engineId,
      details: error.details || null
    };
  }
  const raw = String(error?.message || error || "Engine failed.");
  const lower = raw.toLowerCase();
  let code = String(error?.code || "ENGINE_WORKER_PROTOCOL_ERROR");
  if (/out of memory|cuda.*memory|cublas_status_alloc_failed/iu.test(lower)) code = VTV_ENGINE_ERROR_CODES.ENGINE_GPU_OOM;
  else if (/cancel/iu.test(lower)) code = VTV_ENGINE_ERROR_CODES.ENGINE_CANCELLED;
  else if (/timed? ?out|timeout/iu.test(lower)) code = VTV_ENGINE_ERROR_CODES.ENGINE_TIMEOUT;
  return {
    code,
    message: raw,
    action: String(error?.action || ""),
    engineId: String(error?.engineId || engineId || ""),
    details: error?.details && typeof error.details === "object" ? error.details : null
  };
}
