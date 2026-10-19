import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildVtvPromotionReport } from "../server/voice/vtv/benchmark.mjs";

const inputPath = process.argv[2];
const outputPath = process.argv[3] || "artifacts/vtv-benchmarks/promotion-report.json";
if (!inputPath) {
  console.error("Usage: node scripts/build-vtv-promotion-report.mjs <benchmark-input.json> [output.json]");
  process.exit(2);
}
const input = JSON.parse(await fs.readFile(path.resolve(inputPath), "utf8"));
const report = buildVtvPromotionReport(input);
const target = path.resolve(outputPath);
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath: target, promotionStatus: report.promotionStatus, selectedModelId: report.selectedModelId }, null, 2));
if (report.promotionStatus !== "promoted") process.exitCode = 2;
