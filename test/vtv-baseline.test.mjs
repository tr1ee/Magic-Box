import test from "node:test";
import assert from "node:assert/strict";
import { buildVtvBaselineManifest, validateVtvBaselineManifest, VTV_BASELINE_SCHEMA } from "../server/voice/vtv/baseline.mjs";

test("VTV baseline manifest records hashes and explicitly blocks missing external evidence", async () => {
  const manifest = await buildVtvBaselineManifest({ repoRoot: process.cwd(), maxAudioCases: 2 });
  assert.equal(manifest.schemaVersion, VTV_BASELINE_SCHEMA);
  assert.match(manifest.runtime.packageJsonSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.runtime.packageLockSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.runtime.python.lockSha256, /^[a-f0-9]{64}$/u);
  assert.ok(manifest.runtime.python.packageCount > 0);
  assert.match(manifest.runtime.ffprobe.version, /ffprobe version/iu);
  assert.equal(manifest.engines.seedVc.installedCommit, "51383efd921027683c89e5348211d93ff12ac2a8");
  assert.equal(manifest.engines.seedVc.commitPinned, true);
  assert.ok(Array.isArray(manifest.baselineCases));
  const validation = validateVtvBaselineManifest(manifest);
  if (!manifest.engines.seedVc.commitPinned || manifest.evidence.missingDeclaredCases.length) {
    assert.equal(validation.valid, false);
  }
});
