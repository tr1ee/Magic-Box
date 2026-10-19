import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createVtvDataRootResolver } from "../server/voice/vtv/engine-registry.mjs";
import {
  listProfileTargetArtifacts,
  resolveProfileTargetArtifact,
  selectYingMusicProfileReferenceSources
} from "../server/voice/vtv/target-artifact-resolver.mjs";

test("target resolver stays inside one profile and resolves an explicit RVC binding", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtv-target-resolver-"));
  try {
    const resolver = createVtvDataRootResolver({ dataRoot: root });
    const directory = path.join(resolver.profileTargetDir("profile-a", "rvc-v2-finetuned"), "model-a");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "model-manifest.json"), JSON.stringify({
      engineId: "rvc-v2-finetuned",
      modelId: "model-a",
      profileId: "profile-a",
      createdAt: "2026-08-26T00:00:00.000Z"
    }));
    assert.equal((await listProfileTargetArtifacts({ resolver, profileId: "profile-a", engineId: "rvc-v2-finetuned" })).length, 1);
    assert.equal((await resolveProfileTargetArtifact({ resolver, profileId: "profile-a", engineId: "rvc-v2-finetuned", binding: { modelId: "model-a" } })).modelId, "model-a");
    assert.equal(await resolveProfileTargetArtifact({ resolver, profileId: "profile-b", engineId: "rvc-v2-finetuned", binding: { modelId: "model-a" } }), null);
    assert.equal(await resolveProfileTargetArtifact({ resolver, profileId: "profile-a", engineId: "rvc-v2-finetuned", binding: { modelId: "../model-a" } }), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("YingMusic source selection builds a deterministic 20-25 second reference plan", () => {
  const samples = [{
    profileId: "profile-a",
    preparation: { status: "ready" },
    segments: Array.from({ length: 6 }, (_, index) => ({
      audioPath: `clip-${index}.wav`,
      durationSeconds: 5,
      qualityVerdict: "eligible",
      includeInTraining: true,
      boundary: "complete",
      speechConfidence: 0.9,
      transcriptConfidence: 1
    }))
  }];
  const result = selectYingMusicProfileReferenceSources(samples, "profile-a");
  assert.equal(result.ready, true);
  assert.equal(result.clips.length, 5);
  assert.ok(result.durationSeconds >= 20 && result.durationSeconds <= 25);
});

test("YingMusic source selection maximizes voiced seconds instead of choosing short high-ratio clips", () => {
  const segments = [
    ...Array.from({ length: 6 }, (_, index) => ({ audioPath: `short-${index}.wav`, durationSeconds: 3, voicedDurationSeconds: 2.7 })),
    ...Array.from({ length: 6 }, (_, index) => ({ audioPath: `long-${index}.wav`, durationSeconds: 8, voicedDurationSeconds: 5.6 }))
  ].map((segment) => ({ ...segment, qualityVerdict: "eligible", includeInTraining: true, boundary: "complete", speechConfidence: 0.9, transcriptConfidence: 1 }));
  const result = selectYingMusicProfileReferenceSources([{ profileId: "profile-a", preparation: { status: "ready" }, segments }], "profile-a");
  assert.equal(result.ready, true);
  assert.ok(result.voicedDurationSeconds >= 20);
  assert.ok(result.clips.every((clip) => clip.audioPath.startsWith("long-")));
});
