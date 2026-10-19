import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildVtvPromotionReport, createVtvCandidateReportFromGpuRegression } from "../server/voice/vtv/benchmark.mjs";

const outputPath = path.resolve(process.argv[2] || "artifacts/vtv-benchmarks/song-finetune-bakeoff.report.json");
const pairs = process.argv.slice(3);
if (pairs.length < 4 || pairs.length % 2 !== 0) {
  console.error("Usage: node scripts/build-vtv-song-finetune-bakeoff.mjs <output.json> <model-id> <nightly.report.json> [<model-id> <nightly.report.json> ...]");
  process.exit(2);
}

const candidateReports = [];
const sourceNightlies = [];
for (let index = 0; index < pairs.length; index += 2) {
  const modelId = pairs[index];
  const nightlyPath = path.resolve(pairs[index + 1]);
  const nightly = JSON.parse(await fs.readFile(nightlyPath, "utf8"));
  sourceNightlies.push({ modelId, path: nightlyPath, corpusHash: nightly.corpusHash, status: nightly.status });
  for (const item of nightly.cases || []) {
    const report = JSON.parse(await fs.readFile(path.resolve(item.reportPath), "utf8"));
    candidateReports.push(createVtvCandidateReportFromGpuRegression({
      report,
      modelId,
      corpusHash: nightly.corpusHash,
      caseId: item.caseId
    }));
  }
}
const corpus = [...new Set(candidateReports.map((item) => item.caseId))].map((id) => ({ id, mode: "song" }));
const promotion = buildVtvPromotionReport({ mode: "song", corpus, candidateReports, humanAbx: [] });
const report = {
  schemaVersion: "vtv-song-finetune-bakeoff-v1",
  sourceNightlies,
  candidateReports,
  promotion,
  createdAt: new Date().toISOString()
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, candidateCount: candidateReports.length, promotionStatus: promotion.promotionStatus, selectedModelId: promotion.selectedModelId }, null, 2));
if (promotion.promotionStatus !== "promoted") process.exitCode = 2;
