import test from "node:test";
import assert from "node:assert/strict";
import {
  createVoiceQualityReport,
  evaluateArtifactPolicy,
  evaluateContentPolicy,
  evaluateIdentityPolicy,
  evaluatePerceptualPolicy,
  identityReferenceCalibration
} from "../shared/voiceCloneQuality.mjs";

test("identity calibration records robust reference distribution and outliers", () => {
  const calibration = identityReferenceCalibration([0.91, 0.89, 0.88, 0.42]);
  assert.equal(calibration.referenceCount, 4);
  assert.equal(calibration.p10Score, 0.42);
  assert.deepEqual(calibration.outlierIndexes, [3]);
});

test("strict dual identity policy fails closed when encoder B is unavailable", () => {
  const result = evaluateIdentityPolicy({
    encoderA: { score: 0.92, passed: true },
    required: true,
    qualityMode: "strict"
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("speaker_evaluator_unavailable"));
});

test("artifact policy rejects hard waveform artifacts", () => {
  const result = evaluateArtifactPolicy({ clickPopDetected: true, lineHumRatio: 0.3 });
  assert.equal(result.passed, false);
  assert.deepEqual(result.reasons.sort(), ["clickPop", "lineHum"]);
});

test("strict content policy requires a secondary evaluator for repeated tokens when configured", () => {
  const result = evaluateContentPolicy({
    primaryAsr: { coverage: 1 },
    expectedText: "哈哈哈哈",
    requiredSecondary: true,
    qualityMode: "strict"
  });
  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("secondary_asr_unavailable"));
  assert.ok(result.reasons.includes("repeated_token_alignment_required"));
});

test("quality report keeps evaluator unavailability explicit", () => {
  const report = createVoiceQualityReport({
    qualityMode: "strict",
    flags: { dualSpeakerGate: true, perceptualGate: true },
    content: { status: "pass", passed: true, reasons: [] }
  });
  assert.equal(report.decision.accepted, false);
  assert.equal(report.identity.status, "unavailable");
  assert.equal(report.perceptual.status, "unavailable");
});
