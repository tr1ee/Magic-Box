import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isOwnedTempName, sweepVtvTempArtifacts } from "../server/voice/vtv/temp-cleanup.mjs";

test("VTV temp cleanup removes only owned expired directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtv-cleanup-"));
  try {
    const jobs = path.join(root, "jobs");
    await fs.mkdir(path.join(jobs, "voice-vtv-old"), { recursive: true });
    await fs.mkdir(path.join(jobs, "voice-vtv-live"), { recursive: true });
    await fs.mkdir(path.join(jobs, "unrelated"), { recursive: true });
    const oldTime = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(jobs, "voice-vtv-old"), oldTime, oldTime);
    const result = await sweepVtvTempArtifacts({ rootDir: root, orphanRoots: ["jobs"], ttlMs: 10_000 });
    assert.equal(result.removed.length, 1);
    assert.equal(isOwnedTempName("voice-vtv-old"), true);
    assert.equal(isOwnedTempName("unrelated"), false);
    await assert.rejects(fs.stat(path.join(jobs, "voice-vtv-old")), { code: "ENOENT" });
    await fs.stat(path.join(jobs, "voice-vtv-live"));
    await fs.stat(path.join(jobs, "unrelated"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
