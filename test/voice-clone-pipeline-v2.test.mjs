import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDatasetSnapshotHash,
  createArtifactRecord,
  createReferencePackManifest,
  normalizeVoiceQualityMode,
  resolveManagedArtifactPath,
  selectVoiceCandidate,
  validateFineDataset,
  validateReferencePackManifest,
  voiceCloneErrorCodes,
  voiceCloneFeatureFlags
} from "../shared/voiceClonePipeline.mjs";

function sample(id, durationSeconds = 5) {
  return {
    id: `sample-${id}`,
    preparation: { revision: 1, status: "ready" },
    segments: [{
      id: `segment-${id}`,
      durationSeconds,
      transcript: `测试语句 ${id}`,
      qualityVerdict: "eligible",
      includeInTraining: true,
      boundary: "complete"
    }]
  };
}

test("dataset snapshot is deterministic and changes when transcript or segment data changes", () => {
  const samples = [sample(2), sample(1)];
  const first = computeDatasetSnapshotHash({ profileId: "profile-1", profileLanguage: "zh", samples });
  const reordered = computeDatasetSnapshotHash({ profileId: "profile-1", profileLanguage: "zh", samples: [...samples].reverse() });
  assert.equal(first, reordered);
  const changed = structuredClone(samples);
  changed[0].segments[0].transcript = "修改后的语句";
  assert.notEqual(first, computeDatasetSnapshotHash({ profileId: "profile-1", profileLanguage: "zh", samples: changed }));
});

test("feature flags keep Pipeline V2 enabled while preserving a legacy rollback flag", () => {
  const defaults = voiceCloneFeatureFlags({});
  assert.equal(defaults.pipelineV2, true);
  assert.equal(defaults.legacyBlend, true);
  assert.equal(voiceCloneFeatureFlags({ VOICE_CLONE_PIPELINE_V2_ENABLED: "0" }).pipelineV2, false);
});

test("managed artifact paths reject absolute and parent traversal paths", () => {
  assert.equal(resolveManagedArtifactPath("C:/voice-root", "profiles/p1/audio.wav"), "C:\\voice-root\\profiles\\p1\\audio.wav");
  assert.throws(() => resolveManagedArtifactPath("C:/voice-root", "../outside.wav"), (error) => error.code === voiceCloneErrorCodes.artifactOutsideManagedRoot);
  assert.throws(() => resolveManagedArtifactPath("C:/voice-root", "C:/outside.wav"), (error) => error.code === voiceCloneErrorCodes.artifactOutsideManagedRoot);
});

test("reference pack validation catches profile, snapshot and hash mismatches", () => {
  const artifact = createArtifactRecord({
    artifactId: "artifact-1",
    profileId: "profile-1",
    kind: "reference_audio",
    relativePath: "profiles/profile-1/reference.wav",
    sha256: "a".repeat(64),
    durationMs: 6000
  });
  const pack = createReferencePackManifest({
    profileId: "profile-1",
    modelVersionId: "model-1",
    datasetSnapshotHash: "snapshot-1",
    artifacts: [artifact]
  });
  assert.equal(validateReferencePackManifest(pack, {
    expectedProfileId: "profile-1",
    expectedModelVersionId: "model-1",
    expectedDatasetSnapshotHash: "snapshot-1"
  }).valid, true);
  assert.equal(validateReferencePackManifest(pack, {
    expectedProfileId: "profile-2",
    expectedDatasetSnapshotHash: "snapshot-2"
  }).valid, false);
});

test("Fine dataset gate enforces speech duration, segment count and holdout", () => {
  const insufficient = validateFineDataset(Array.from({ length: 10 }, (_, index) => sample(index, 4)));
  assert.equal(insufficient.valid, false);
  assert.ok(insufficient.missing.length >= 2);
  const sufficient = validateFineDataset(Array.from({ length: 20 }, (_, index) => sample(index, 5)));
  assert.equal(sufficient.valid, true);
  assert.equal(sufficient.holdoutCount, 3);
});

test("candidate selection is layered and Balanced can explicitly retain the direct baseline", () => {
  const candidate = {
    id: "seed-full",
    contentPassed: true,
    artifactPassed: true,
    naturalnessPassed: false,
    identity: { encoderA: { passed: true, score: 0.95 }, encoderB: { passed: true, score: 0.94 } }
  };
  const baseline = { id: "gpt-direct", contentPassed: true, artifactPassed: true, naturalnessPassed: true, identity: { encoderA: { passed: true, score: 0.7 } } };
  assert.throws(() => selectVoiceCandidate([candidate], { qualityMode: "strict" }), /No voice candidate passed/);
  const balanced = selectVoiceCandidate([candidate], { qualityMode: "balanced", baseline });
  assert.equal(balanced.selected.id, "gpt-direct");
  assert.equal(balanced.degraded, true);
  assert.equal(normalizeVoiceQualityMode("invalid"), "strict");
});

