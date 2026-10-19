import assert from "node:assert/strict";
import test from "node:test";
import { vtvRvcEngineId, vtvSeedEngineId, vtvYingMusicEngineId } from "../shared/voiceClone.mjs";
import {
  createProfileEngineSummary,
  createSeedProfileTargetState,
  eligibleProfileDurationSeconds
} from "../server/voice/vtv/profile-engine-support.mjs";

test("legacy profile voiceModel is exposed as a Seed target without leaking its path", () => {
  const state = createSeedProfileTargetState({
    id: "profile-old",
    voiceModel: { versionId: "version-old", referenceAudioPath: "C:/private/reference.wav", qualityMode: "quick" },
    preparedSourceCount: 1
  });
  assert.equal(state.ready, true);
  assert.equal(state.selectedTarget.artifactId, "version-old");
  assert.equal(JSON.stringify(state).includes("C:/private"), false);
});

test("profile engine summary identifies a Seed-only profile as legacy-upgradeable", () => {
  const states = {
    [vtvSeedEngineId]: { ready: true },
    [vtvRvcEngineId]: { ready: false },
    [vtvYingMusicEngineId]: { ready: false }
  };
  assert.deepEqual(createProfileEngineSummary(states), {
    engineCount: 3,
    readyCount: 1,
    needsUpgrade: true,
    legacyProfile: true
  });
});

test("eligible RVC duration uses prepared eligible segments", () => {
  const duration = eligibleProfileDurationSeconds({ id: "profile-a", totalSpeechSeconds: 2 }, [{
    profileId: "profile-a",
    preparation: { status: "ready" },
    segments: [
      { audioPath: "included.wav", boundary: "complete", qualityVerdict: "eligible", durationSeconds: 8 },
      { audioPath: "excluded.wav", boundary: "complete", qualityVerdict: "eligible", durationSeconds: 6, includeInTraining: false },
      { audioPath: "rejected.wav", boundary: "complete", qualityVerdict: "rejected", durationSeconds: 12 }
    ]
  }]);
  assert.equal(duration, 8);
});

test("eligible RVC duration never falls back to stale profile totals", () => {
  const duration = eligibleProfileDurationSeconds({ id: "profile-a", totalSpeechSeconds: 1464 }, [{
    profileId: "profile-a",
    preparation: { status: "needs-attention" },
    segments: [{ audioPath: "stale.wav", boundary: "complete", qualityVerdict: "rejected", durationSeconds: 618 }]
  }]);
  assert.equal(duration, 0);
});
