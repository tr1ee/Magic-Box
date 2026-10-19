import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildVtvPromotionReport, createVtvCandidateReportFromGpuRegression } from "../server/voice/vtv/benchmark.mjs";

const mode = process.argv[2] === "song" ? "song" : "speech";
const outputPath = path.resolve(process.argv[3] || `artifacts/vtv-benchmarks/${mode}-gpu-promotion-report.json`);
const reportPaths = process.argv.slice(4);
if (!reportPaths.length) {
  console.error("Usage: node scripts/build-vtv-promotion-from-gpu-reports.mjs <speech|song> <output.json> <report.json> [...]");
  process.exit(2);
}
const reports = await Promise.all(reportPaths.map(async (filePath, index) => {
  const report = JSON.parse(await fs.readFile(path.resolve(filePath), "utf8"));
  return createVtvCandidateReportFromGpuRegression({
    report,
    modelId: mode === "song" ? "seed-vc-song-44k" : "seed-vc-speech-v1",
    corpusHash: report.sourceSha256,
    caseId: `${mode}-gpu-smoke-${index + 1}`
  });
}));
const corpus = reports.map((report) => ({ caseId: report.caseId, corpusHash: report.corpusHash, mode }));
const promotion = buildVtvPromotionReport({ mode, corpus, candidateReports: reports, humanAbx: [] });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify({ schemaVersion: "vtv-gpu-promotion-input-v1", candidateReports: reports, promotion }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, promotionStatus: promotion.promotionStatus, selectedModelId: promotion.selectedModelId, modelCount: promotion.models.length }, null, 2));
if (promotion.promotionStatus !== "promoted") process.exitCode = 2;

