import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveVtvCandidateSeed,
  deriveVtvJobSeed,
  deriveVtvRepairSeed,
  normalizeVtvSettings,
  planVtvCandidates
} from "../server/voice/vtv/candidate-planner.mjs";
import {
  assertVtvCompletedInvariant,
  decideVtvOutcome
} from "../server/voice/vtv/state-machine.mjs";
import {
  createVtvReferencePackV2,
  validateVtvReferencePackV2
} from "../server/voice/vtv/reference-pack-v2.mjs";
import { rankVtvSpeechCandidates } from "../server/voice/vtv/speech-ranker.mjs";
import { evaluateDualF0Gate, evaluateFinalMixGateMetrics, evaluateStemGate } from "../server/voice/vtv/song-quality.mjs";
import { buildVtvFineTuneDataset, createVtvCheckpointManifest, selectVtvCheckpointForPromotion } from "../server/voice/vtv/finetune.mjs";
import { buildVtvPromotionReport, createVtvCandidateReport, createVtvCandidateReportFromGpuRegression } from "../server/voice/vtv/benchmark.mjs";

test("VTV candidate seeds are stable and distinct per candidate/repair", () => {
  const input = {
    sourceSha256: "source",
    referencePackSha256: "reference",
    modelCheckpointSha256: "model",
    normalizedSettings: { mode: "speech", qualityPreset: "identity-first" }
  };
  const first = deriveVtvJobSeed(input);
  assert.equal(first, deriveVtvJobSeed(input));
  assert.notEqual(deriveVtvCandidateSeed(first, 0), deriveVtvCandidateSeed(first, 1));
  assert.notEqual(deriveVtvRepairSeed(first, 1000, 0), deriveVtvRepairSeed(first, 1000, 1));
  assert.deepEqual(planVtvCandidates({ jobBaseSeed: first, candidateBudget: 3 }).map((item) => item.seed), planVtvCandidates({ jobBaseSeed: first, candidateBudget: 3 }).map((item) => item.seed));
});

test("VTV settings keep Song on native 44.1 kHz and bound candidate budget", () => {
  const settings = normalizeVtvSettings({ candidateBudget: 99 }, { mode: "song" });
  assert.equal(settings.pipelineVersion, "vtv-pipeline-v2");
  assert.equal(settings.nativeSampleRate, 44100);
  assert.equal(settings.candidateBudget, 3);
});

test("VTV state machine never upgrades advisory or final-mix failures to completed", () => {
  const review = decideVtvOutcome({ mode: "song", strictValidationAccepted: false, advisoryAccepted: true, reasons: ["pitch_discontinuity"] });
  assert.equal(review.status, "needs-review");
  assert.equal(review.completed, false);
  const rejected = decideVtvOutcome({ mode: "song", strictValidationAccepted: true, finalMixGatePassed: false });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.completed, false);
  assert.throws(() => assertVtvCompletedInvariant({ status: "completed", strictValidationAccepted: false }), /completed invariant/);
});

test("VTV reference packs are mode-specific, hashed, and health-gated", () => {
  const clips = [
    { id: "a", relativePath: "profiles/p/a.wav", durationSeconds: 8, quality: { passed: true }, speakerConsistency: { passed: true }, recordingDomainId: "room-a" },
    { id: "b", relativePath: "profiles/p/b.wav", durationSeconds: 8, quality: { passed: true }, speakerConsistency: { passed: true }, recordingDomainId: "room-b" }
  ];
  const pack = createVtvReferencePackV2({
    profileId: "p",
    modelVersionId: "m",
    mode: "speech",
    clips,
    speakerCentroids: { campplus: "centroid-a", eres2netv2: "centroid-b" }
  });
  assert.equal(pack.schemaVersion, "vtv-reference-pack-v2");
  assert.equal(pack.mode, "speech");
  assert.deepEqual(pack.speakerCentroids, { campplus: "centroid-a", eres2netv2: "centroid-b" });
  assert.equal(validateVtvReferencePackV2(pack, { profileId: "p", modelVersionId: "m", mode: "speech", requireReady: true }).valid, true);
  assert.equal(validateVtvReferencePackV2(pack, { mode: "song" }).valid, false);
});

test("VTV Speech ranker requires both identity encoders and perceptual evidence", () => {
  const base = {
    id: "candidate-1",
    conversionStrictValidationAccepted: true,
    identity: { accepted: true, targetSimilarity: 0.8, encoderB: { passed: true, score: 0.82 } },
    perceptual: { available: true, score: 0.78 }
  };
  const result = rankVtvSpeechCandidates([
    base,
    { ...base, id: "candidate-2", identity: { ...base.identity, encoderB: { passed: false, score: 0.3 } } }
  ]);
  assert.equal(result.selected.id, "candidate-1");
  assert.equal(result.candidates.find((item) => item.id === "candidate-2").vtvQuality.hardPassed, false);
});

test("Song VTV quality gates fail closed when dual F0 or stem evidence is missing", () => {
  assert.equal(evaluateDualF0Gate({ rmvpe: { voicedFrames: 100 } }).status, "unavailable");
  assert.equal(evaluateDualF0Gate({ rmvpe: { voicedFrames: 100 }, fcpe: { voicedFrames: 100, medianDisagreementCents: 30 } }).passed, true);
  assert.equal(evaluateStemGate({ vocal: { durationSeconds: 2 }, accompaniment: { durationSeconds: 2 }, reconstruction: { errorDb: 4 } }).passed, false);
  const leakedStems = evaluateStemGate({ vocal: { durationSeconds: 2 }, accompaniment: { durationSeconds: 2 }, reconstruction: { errorDb: 2, backgroundLeakRatio: 0.5, vocalResidualRatio: 0.5 } });
  assert.deepEqual(leakedStems.reasons, ["vocal_background_leak_high", "accompaniment_vocal_residual_high"]);
  assert.equal(evaluateStemGate({ vocal: { durationSeconds: 2 }, accompaniment: { durationSeconds: 2 }, reconstruction: { errorDb: 2, alignmentCorrelation: 0.1 } }).reasons.includes("reconstruction_alignment_low"), true);
  assert.equal(evaluateFinalMixGateMetrics({ truePeakDbfs: -0.01 }).passed, false);
});

test("VTV fine-tune dataset and checkpoint promotion are split-aware and hard-gated", () => {
  const samples = Array.from({ length: 10 }, (_, index) => ({
    id: `sample-${index}`,
    sha256: `source-${index}`,
    audioSha256: `audio-${index}`,
    relativePath: `profiles/p/sample-${index}.wav`,
    durationSeconds: 8,
    voicedDurationSeconds: 7,
    preparation: { status: "ready" }
  }));
  const dataset = buildVtvFineTuneDataset({ profileId: "p", modelVersionId: "m", mode: "speech", samples });
  assert.equal(new Set(dataset.entries.map((entry) => entry.split)).size >= 2, true);
  const checkpoint = createVtvCheckpointManifest({ dataset, checkpointSha256: "checkpoint-hash" });
  const promotion = selectVtvCheckpointForPromotion({
    checkpoints: [checkpoint],
    lockedTestReports: [{ checkpointSha256: "checkpoint-hash", hardGatesPassed: true, targetIdentityP10: 0.8, contentScore: 0.9, perceptualScore: 0.8 }]
  });
  assert.equal(promotion.promotionStatus, "promoted");
});

test("VTV model promotion remains blocked without complete human ABX evidence", () => {
  const candidate = createVtvCandidateReport({ modelId: "seed-vc-speech-v1", mode: "speech", corpusHash: "c", caseId: "case-1", hardGatesPassed: true });
  const blocked = buildVtvPromotionReport({ mode: "speech", corpus: [{ caseId: "case-1" }], candidateReports: [candidate] });
  assert.equal(blocked.promotionStatus, "blocked");
  const promoted = buildVtvPromotionReport({
    mode: "speech",
    corpus: [{ caseId: "case-1" }],
    candidateReports: [{ ...candidate, humanReview: { state: "recorded" } }],
    humanAbx: [
      { modelId: "seed-vc-speech-v1", preferred: true, reviewerId: "reviewer-a" },
      { modelId: "seed-vc-speech-v1", preferred: true, reviewerId: "reviewer-b" }
    ]
  });
  assert.equal(promoted.promotionStatus, "promoted");
});

test("GPU regression reports map to the common candidate schema without bypassing promotion gates", () => {
  const report = createVtvCandidateReportFromGpuRegression({
    report: {
      mode: "song",
      sourceSha256: "source-hash",
      seed: 31001,
      passed: false,
      health: { device: "cuda", gpuAvailable: true, gpuName: "RTX 4070", torchVersion: "2.4.0+cu121" },
      conversion: { engine: "seed-vc-svc-local", modelVersion: "seed-vc-svc-v1", durationSeconds: 3 },
      evaluation: { accepted: false, metrics: { targetSimilarity: 0.2 }, f0Evaluators: { fcpe: { available: true } } }
    },
    modelId: "seed-vc-song-44k",
    caseId: "song-real-smoke"
  });
  assert.equal(report.schemaVersion, "vtv-candidate-report-v1");
  assert.equal(report.hardGatesPassed, false);
  assert.equal(report.runtime.gpuAvailable, true);
  const promotion = buildVtvPromotionReport({ mode: "song", corpus: [{ id: "song-real-smoke" }], candidateReports: [report] });
  assert.equal(promotion.promotionStatus, "blocked");
});
