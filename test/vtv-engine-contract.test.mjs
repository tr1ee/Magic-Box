import test from "node:test";
import assert from "node:assert/strict";
import { makeEngineFailure, normalizeEngineResult } from "../server/voice/vtv/engine-contract.mjs";
import { VtvEngineError } from "../server/voice/vtv/engine-errors.mjs";

test("VTV engine result keeps execution and quality statuses separate", () => {
  const result = normalizeEngineResult({ executionStatus: "succeeded", qualityStatus: "needs-review", strictValidationAccepted: false }, { engineId: "seed-vc-svc-v1" });
  assert.equal(result.executionStatus, "succeeded");
  assert.equal(result.qualityStatus, "needs-review");
  assert.equal(result.strictValidationAccepted, false);
});

test("VTV engine failure is actionable and never silently falls back", () => {
  const result = makeEngineFailure("rvc-v2-finetuned", new VtvEngineError("TARGET_MODEL_NOT_BOUND", "RVC model is not bound.", { action: "Import and bind a model." }));
  assert.equal(result.executionStatus, "failed");
  assert.equal(result.error.code, "TARGET_MODEL_NOT_BOUND");
  assert.equal(result.error.action, "Import and bind a model.");
  assert.equal(result.engineId, "rvc-v2-finetuned");
});
