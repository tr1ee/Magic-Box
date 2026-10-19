import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { createVtvCandidateReportFromGpuRegression, buildVtvPromotionReport } from "../server/voice/vtv/benchmark.mjs";
import { validateVtvCorpusManifest } from "../server/voice/vtv/corpus.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(".");
const arg = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
};
const manifestPath = path.resolve(arg("--manifest", "artifacts/vtv-corpus/corpus-manifest.json"));
const outputDir = path.resolve(arg("--output-dir", "artifacts/vtv-nightly"));
const mode = arg("--mode", "speech") === "song" ? "song" : "speech";
const limit = Math.max(1, Math.min(100, Number(arg("--limit", "100")) || 100));
const repeat = Math.max(1, Math.min(3, Number(arg("--repeat", "2")) || 2));
const pythonPath = arg("--python", "");
const workerPath = arg("--worker", "");
const checkpointPath = arg("--checkpoint", "");
const configPath = arg("--config", "");
const checkpointMapPath = arg("--checkpoint-map", "");
const checkpointMap = checkpointMapPath
  ? JSON.parse(await fs.readFile(path.resolve(checkpointMapPath), "utf8"))
  : {};

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const validation = validateVtvCorpusManifest(manifest);
await fs.mkdir(outputDir, { recursive: true });
const cases = (manifest.cases || []).filter((item) => item.mode === mode).slice(0, limit);
const nightly = {
  schemaVersion: "vtv-nightly-regression-report-v1",
  mode,
  manifestPath,
  corpusHash: manifest.corpusHash || "",
  startedAt: new Date().toISOString(),
  status: validation.valid ? "running" : "blocked",
  validation,
  cases: [],
  candidateReports: []
};
if (!validation.valid) {
  nightly.finishedAt = new Date().toISOString();
  nightly.status = "blocked";
  nightly.blockingReasons = ["corpus_gate_failed"];
  const reportPath = path.join(outputDir, `${mode}-nightly.report.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(nightly, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ reportPath, status: nightly.status, errors: validation.errors }, null, 2));
  process.exitCode = 2;
} else if (!cases.length) {
  nightly.finishedAt = new Date().toISOString();
  nightly.status = "blocked";
  nightly.blockingReasons = ["corpus_has_no_cases_for_mode"];
  const reportPath = path.join(outputDir, `${mode}-nightly.report.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(nightly, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ reportPath, status: nightly.status }, null, 2));
  process.exitCode = 2;
} else {
  for (const item of cases) {
    const outputPath = path.join(outputDir, `${item.id}.wav`);
    const reportPath = outputPath.replace(/\.wav$/iu, ".report.json");
    const source = path.resolve(root, item.path);
    const reference = path.resolve(root, item.targetReferencePath || item.path);
    const references = (Array.isArray(item.targetReferencePaths) && item.targetReferencePaths.length ? item.targetReferencePaths : [item.targetReferencePath || item.path]).map((value) => path.resolve(root, value));
    const mapped = checkpointMap?.[item.targetProfileId] || {};
    const caseCheckpointPath = mapped.checkpoint || checkpointPath;
    const caseConfigPath = mapped.config || configPath;
    const caseSeed = Number.isInteger(Number(mapped.seed)) ? Number(mapped.seed) : Number(arg("--seed", "31001"));
    const args = ["scripts/run-vtv-gpu-regression.mjs", "--mode", mode, "--source", source, "--reference", reference, "--output", outputPath, "--repeat", String(repeat), "--seed", String(caseSeed)];
    if (references.length > 1) args.push("--references", references.join("|"));
    if (pythonPath) args.push("--python", path.resolve(root, pythonPath));
    if (workerPath) args.push("--worker", path.resolve(root, workerPath));
    if (caseCheckpointPath) args.push("--checkpoint", path.resolve(root, caseCheckpointPath));
    if (caseConfigPath) args.push("--config", path.resolve(root, caseConfigPath));
    let commandError = "";
    try {
      await execFileAsync(process.execPath, args, { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      commandError = String(error?.message || error);
    }
    const report = await fs.readFile(reportPath, "utf8").then((text) => JSON.parse(text)).catch(() => ({ passed: false, error: commandError || "gpu_report_missing" }));
    nightly.cases.push({ caseId: item.id, reportPath, passed: report.passed === true, error: commandError || null });
    nightly.candidateReports.push(createVtvCandidateReportFromGpuRegression({
      report,
      modelId: caseCheckpointPath
        ? (mode === "song" ? "seed-vc-song-finetuned-44k" : "seed-vc-speech-finetuned")
        : (mode === "song" ? "seed-vc-song-44k" : "seed-vc-speech-v1"),
      corpusHash: manifest.corpusHash,
      caseId: item.id
    }));
  }
  const promotion = buildVtvPromotionReport({ mode, corpus: cases, candidateReports: nightly.candidateReports });
  nightly.promotion = promotion;
  nightly.finishedAt = new Date().toISOString();
  nightly.status = nightly.cases.every((item) => item.passed) ? "completed" : "failed";
  const reportPath = path.join(outputDir, `${mode}-nightly.report.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(nightly, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ reportPath, status: nightly.status, caseCount: nightly.cases.length, promotionStatus: promotion.promotionStatus }, null, 2));
  if (nightly.status !== "completed") process.exitCode = 1;
}
