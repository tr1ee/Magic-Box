import fs from "node:fs/promises";
import path from "node:path";
import { createVtvEngineService } from "../server/voice/vtv/engine-service.mjs";

const [dataRootArg, targetDirArg, inputArg, outputDirArg] = process.argv.slice(2);
if (!outputDirArg) throw new Error("Usage: node scripts/verify-vtv-rvc-repeatability.mjs DATA_ROOT TARGET_DIR INPUT_WAV OUTPUT_DIR");
const outputDir = path.resolve(outputDirArg);
await fs.mkdir(outputDir, { recursive: true });
const targetDir = path.resolve(targetDirArg);
const manifest = JSON.parse(await fs.readFile(path.join(targetDir, "model-manifest.json"), "utf8"));
const target = { ...manifest, modelPath: path.join(targetDir, "model.pth"), indexPath: path.join(targetDir, "model.index") };
const service = await createVtvEngineService({ dataRoot: path.resolve(dataRootArg) });
const reports = [];
try {
  const adapter = service.registry.require("rvc-v2-finetuned");
  for (let repeat = 1; repeat <= 2; repeat++) {
    const result = await adapter.convertSong({
      jobId: "repeatability", engineRunId: `repeatability-${repeat}`, target,
      outputPath: path.join(outputDir, `rvc-seed31002-repeat${repeat}.wav`),
      shared: { leadVocalPath: path.resolve(inputArg), durationSeconds: 20 },
      settings: { preset: "identity", pitchShiftSemitones: 3 }, seed: 31002,
      onEngineProgress: event => console.log(JSON.stringify({ repeat, ...event }))
    });
    reports.push(result);
    console.log(JSON.stringify({ repeat, outputHash: result.outputHash, engineMetrics: result.engineMetrics }));
    await adapter.unload();
  }
  const first = await fs.readFile(reports[0].convertedVocalPath);
  const second = await fs.readFile(reports[1].convertedVocalPath);
  const identical = first.equals(second);
  await fs.writeFile(path.join(outputDir, "rvc-repeatability.json"), JSON.stringify({ identical, reports }, null, 2));
  if (!identical) throw new Error("Same-seed RVC outputs differed; inspect the report before claiming deterministic inference.");
} finally {
  await service.close();
}
