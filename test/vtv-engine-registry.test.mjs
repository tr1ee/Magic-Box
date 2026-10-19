import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createVtvDataRootResolver, createVtvEngineRegistry } from "../server/voice/vtv/engine-registry.mjs";

function adapter(id) {
  return { id, async getInstallState() {}, async healthCheck() {}, async preflight() {}, normalizeSettings(v) { return v; }, async convertSong() {}, async unload() {} };
}

test("VTV registry rejects duplicate ids and exposes isolated paths", () => {
  const resolver = createVtvDataRootResolver({ dataRoot: "C:/MagicBoxData/voice_clone" });
  const registry = createVtvEngineRegistry({ resolver, adapters: [adapter("rvc-v2-finetuned")] });
  assert.equal(registry.has("rvc-v2-finetuned"), true);
  assert.match(resolver.tempDir("job-1", "rvc-v2-finetuned"), /rvc-v2-finetuned/);
  assert.doesNotMatch(resolver.tempDir("job-1", "rvc-v2-finetuned"), /yingmusic/);
  assert.throws(() => registry.register(adapter("rvc-v2-finetuned")), /already registered/);
});

test("VTV registry reads PowerShell UTF-8 BOM runtime manifests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vtv-runtime-bom-"));
  try {
    const resolver = createVtvDataRootResolver({ dataRoot: root });
    const runtimeDir = resolver.runtimeDir("rvc-v2-finetuned", "runtime-1");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(resolver.activePath("rvc-v2-finetuned"), `\uFEFF${JSON.stringify({ activeVersion: "runtime-1" })}`);
    await fs.writeFile(path.join(runtimeDir, "runtime-manifest.json"), `\uFEFF${JSON.stringify({ engineId: "rvc-v2-finetuned", runtimeVersion: "runtime-1" })}`);
    const registry = createVtvEngineRegistry({ resolver });
    assert.equal((await registry.loadActiveManifest("rvc-v2-finetuned")).runtimeVersion, "runtime-1");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
