import test from "node:test";
import assert from "node:assert/strict";
import { createVtvDataRootResolver } from "../server/voice/vtv/engine-registry.mjs";

test("engine runtime, cache, logs, and temp roots remain physically separate", () => {
  const resolver = createVtvDataRootResolver({ dataRoot: "C:/MagicBoxData/voice_clone" });
  const rvc = [resolver.runtimeDir("rvc-v2-finetuned"), resolver.cacheDir("rvc-v2-finetuned"), resolver.logDir("rvc-v2-finetuned"), resolver.tempDir("j", "rvc-v2-finetuned")];
  const ying = [resolver.runtimeDir("yingmusic-svc-zero-shot-v1"), resolver.cacheDir("yingmusic-svc-zero-shot-v1"), resolver.logDir("yingmusic-svc-zero-shot-v1"), resolver.tempDir("j", "yingmusic-svc-zero-shot-v1")];
  assert.equal(rvc.some((item) => ying.includes(item)), false);
});
