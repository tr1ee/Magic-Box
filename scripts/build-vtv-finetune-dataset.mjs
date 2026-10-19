import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildVtvFineTuneDataset } from "../server/voice/vtv/finetune.mjs";

const inputPath = process.argv[2];
const outputPath = process.argv[3] || "artifacts/vtv-finetune/dataset.json";
if (!inputPath) {
  console.error("Usage: node scripts/build-vtv-finetune-dataset.mjs <profile-samples.json> [output.json]");
  process.exit(2);
}
const input = JSON.parse(await fs.readFile(path.resolve(inputPath), "utf8"));
const dataset = buildVtvFineTuneDataset(input);
const target = path.resolve(outputPath);
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath: target, datasetId: dataset.datasetId, gate: dataset.gate, totals: dataset.totals }, null, 2));
if (!dataset.gate.passed) process.exitCode = 2;
