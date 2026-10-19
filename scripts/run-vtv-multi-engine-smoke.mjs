import { createVtvEngineService } from "../server/voice/vtv/engine-service.mjs";
import { createGpuLeaseManager } from "../server/voice/vtv/gpu-lease-manager.mjs";
import { runMultiEngineSongVtvJob } from "../server/voice/vtv/multi-engine-orchestrator.mjs";

const service = await createVtvEngineService({ dataRoot: process.env.MAGIC_BOX_VOICE_DATA_ROOT });
const registry = service.registry;
const engineIds = ["seed-vc-svc-v1", "rvc-v2-finetuned", "yingmusic-svc-zero-shot-v1"];
const report = await runMultiEngineSongVtvJob({
  jobId: `smoke-${Date.now()}`,
  engineIds,
  registry,
  shared: { sourceHash: "fixture-not-provided", stemHash: "fixture-not-provided", accompanimentHash: "fixture-not-provided" },
  gpuLeaseManager: createGpuLeaseManager()
});
console.log(JSON.stringify(report.report, null, 2));
await service.close();
process.exitCode = report.report.executionStatus === "succeeded" || report.report.executionStatus === "partial" ? 0 : 1;
