import test from "node:test";
import assert from "node:assert/strict";
import { createGpuLeaseManager } from "../server/voice/vtv/gpu-lease-manager.mjs";
import { createVtvEngineRegistry } from "../server/voice/vtv/engine-registry.mjs";
import { runMultiEngineSongVtvJob } from "../server/voice/vtv/multi-engine-orchestrator.mjs";
import { publicVtvEngineResult } from "../server/voice/vtv/comparison-report.mjs";

function fakeAdapter(id, behavior = "success") {
  return {
    id,
    async getInstallState() { return { installed: true }; },
    async healthCheck() { return { ready: true }; },
    async preflight() { return behavior === "preflight-fail" ? { ready: false, errors: ["missing target"] } : { ready: true, resolvedTarget: {}, runtimeLineage: { engineId: id } }; },
    normalizeSettings(v) { return v; },
    async convertSong() { if (behavior === "fail") throw new Error("inference failed"); return { convertedVocalPath: `${id}.wav`, sampleRate: 44100 }; },
    async unload() {}
  };
}

test("comparison runs sequentially and preserves successful children", async () => {
  const registry = createVtvEngineRegistry({ adapters: [fakeAdapter("seed-vc-svc-v1"), fakeAdapter("rvc-v2-finetuned", "fail"), fakeAdapter("yingmusic-svc-zero-shot-v1")] });
  const result = await runMultiEngineSongVtvJob({
    jobId: "job-1",
    engineIds: ["seed-vc-svc-v1", "rvc-v2-finetuned", "yingmusic-svc-zero-shot-v1"],
    registry,
    shared: { sourceHash: "source", stemHash: "stem", accompanimentHash: "acc" },
    gpuLeaseManager: createGpuLeaseManager(),
    mixFinal: async ({ engineRun }) => ({ finalAudioSha256: `${engineRun.engineId}-hash` }),
    persistSuccess: async ({ result: child }) => child,
    persistFailure: async ({ result: child }) => child
  });
  assert.equal(result.executionStatus, "partial");
  assert.equal(result.results.filter((item) => item.executionStatus === "succeeded").length, 2);
  assert.equal(result.results.find((item) => item.engineId === "rvc-v2-finetuned").executionStatus, "failed");
  assert.equal(result.report.results.length, 3);
});

test("prepared per-engine settings are used for conversion", async () => {
  let receivedSettings = null;
  const adapter = fakeAdapter("rvc-v2-finetuned");
  adapter.convertSong = async (context) => {
    receivedSettings = context.settings;
    return { convertedVocalPath: "rvc.wav", sampleRate: 44100 };
  };
  const registry = createVtvEngineRegistry({ adapters: [adapter] });
  await runMultiEngineSongVtvJob({
    jobId: "job-settings",
    engineIds: ["rvc-v2-finetuned"],
    registry,
    shared: {},
    settings: { preset: "base" },
    prepareEngineContext: async (_engineId, engineRun) => ({
      ...engineRun,
      settings: { preset: "identity", indexRate: 0.75 }
    }),
    mixFinal: async () => ({ finalAudioSha256: "hash" })
  });
  assert.deepEqual(receivedSettings, { preset: "identity", indexRate: 0.75 });
});

test("public engine results never serialize the in-memory WAV buffer", () => {
  const result = publicVtvEngineResult({
    engineId: "rvc-v2-finetuned",
    buffer: Buffer.alloc(2_000_000),
    output: { id: "output-1", privatePath: "hidden" }
  }, {
    mapOutput: (output) => ({ id: output.id })
  });
  assert.equal("buffer" in result, false);
  assert.deepEqual(result.output, { id: "output-1" });
  assert.ok(JSON.stringify(result).length < 200);
});

test("conversion model unloads before quality evaluation and quality evidence is merged", async () => {
  const events = [];
  const adapter = fakeAdapter("rvc-v2-finetuned");
  adapter.convertSong = async () => {
    events.push("convert");
    return { convertedVocalPath: "rvc.wav", sampleRate: 48000 };
  };
  adapter.unload = async () => { events.push("unload"); };
  const registry = createVtvEngineRegistry({ adapters: [adapter] });
  const result = await runMultiEngineSongVtvJob({
    jobId: "job-quality",
    engineIds: ["rvc-v2-finetuned"],
    registry,
    shared: {},
    evaluateConverted: async () => {
      events.push("evaluate");
      return { qualityStatus: "rejected", quality: { identity: { targetSimilarity: 0.31 } } };
    },
    mixFinal: async () => ({ finalAudioSha256: "hash" }),
    evaluateFinal: async () => ({ qualityStatus: "passed", quality: { finalMixGate: { passed: true } } })
  });
  assert.deepEqual(events, ["convert", "unload", "evaluate"]);
  assert.equal(result.results[0].qualityStatus, "rejected");
  assert.equal(result.results[0].quality.identity.targetSimilarity, 0.31);
  assert.equal(result.results[0].quality.finalMixGate.passed, true);
});
