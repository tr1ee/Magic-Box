import assert from "node:assert/strict";
import test from "node:test";
import { voiceCloneFeatureFlags } from "../shared/voiceClonePipeline.mjs";

test("VTV persistent worker is an explicit, inspectable runtime flag", () => {
  assert.equal(voiceCloneFeatureFlags({}).vtvPersistentWorker, false);
  assert.equal(voiceCloneFeatureFlags({ MAGICBOX_VTV_PERSISTENT_WORKER: "1" }).vtvPersistentWorker, true);
  assert.equal(voiceCloneFeatureFlags({ MAGICBOX_VTV_PERSISTENT_WORKER: "off" }).vtvPersistentWorker, false);
  assert.equal(voiceCloneFeatureFlags({ MAGICBOX_VTV_DEBUG_RETENTION: "failed" }).vtvDebugRetention, "failed");
  assert.equal(voiceCloneFeatureFlags({ MAGICBOX_VTV_DEBUG_RETENTION: "unsafe" }).vtvDebugRetention, "none");
});
