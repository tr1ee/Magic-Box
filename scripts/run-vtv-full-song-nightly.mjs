import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { validateVtvCorpusManifest } from "../server/voice/vtv/corpus.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(".");
const arg = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
};
const manifestPath = path.resolve(arg("--manifest", "artifacts/vtv-corpus/musdb18-song-corpus-manifest.json"));
const outputDir = path.resolve(arg("--output-dir", "artifacts/vtv-nightly-musdb18-full-song"));
const checkpointPath = path.resolve(arg("--checkpoint"));
const configPath = path.resolve(arg("--config"));
const limit = Math.max(1, Math.min(100, Number(arg("--limit", "100")) || 100));
const steps = Math.max(4, Math.min(50, Number(arg("--steps", "12")) || 12));
const cfg = Math.max(0, Math.min(1, Number(arg("--cfg", "0.85")) || 0));
const separationModel = arg("--separation-model", "htdemucs").toLowerCase();

if (!checkpointPath || !configPath || !(await fs.stat(checkpointPath).catch(() => null)) || !(await fs.stat(configPath).catch(() => null))) {
  console.error("Usage: node scripts/run-vtv-full-song-nightly.mjs --manifest <manifest.json> --checkpoint <pth> --config <yml> [--limit 8] [--steps 12] [--cfg 0.85] [--separation-model htdemucs] [--output-dir <dir>]");
  process.exit(2);
}
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const validation = validateVtvCorpusManifest(manifest);
const cases = (manifest.cases || []).filter((item) => item.mode === "song").slice(0, limit);
await fs.mkdir(outputDir, { recursive: true });
const nightly = {
  schemaVersion: "vtv-full-song-nightly-report-v1",
  mode: "song",
  manifestPath,
  corpusHash: manifest.corpusHash || "",
  checkpointPath,
  configPath,
  diffusionSteps: steps,
  inferenceCfgRate: cfg,
  separationModel,
  startedAt: new Date().toISOString(),
  status: validation.valid && cases.length ? "running" : "blocked",
  validation,
  cases: []
};
if (!validation.valid) nightly.blockingReasons = ["corpus_gate_failed"];
else if (!cases.length) nightly.blockingReasons = ["corpus_has_no_song_cases"];
else {
  for (const item of cases) {
    const source = path.resolve(root, item.path);
    const references = (Array.isArray(item.targetReferencePaths) && item.targetReferencePaths.length
      ? item.targetReferencePaths
      : [item.targetReferencePath]).map((value) => path.resolve(root, value));
    const caseOutputDir = path.join(outputDir, "cases");
    const runnerArgs = [
      "scripts/run-vtv-full-song-regression.mjs",
      "--source", source,
      "--references", references.join("|"),
      "--checkpoint", checkpointPath,
      "--config", configPath,
      "--steps", String(steps),
      "--cfg", String(cfg),
      "--separation-model", separationModel,
      "--output-dir", caseOutputDir,
      "--case-id", item.id,
      "--profile-id", item.targetProfileId || "vtv-full-song-target"
    ];
    let error = null;
    try {
      await execFileAsync(process.execPath, runnerArgs, { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    } catch (caught) {
      error = String(caught?.message || caught);
    }
    const reportPath = path.join(caseOutputDir, `${item.id}.full-song.report.json`);
    const report = await fs.readFile(reportPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);
    nightly.cases.push({ caseId: item.id, reportPath, status: report?.status || "failed", passed: report?.status === "completed", error });
  }
  nightly.status = nightly.cases.every((item) => item.passed) ? "completed" : "failed";
  nightly.blockingReasons = nightly.status === "completed" ? ["human_abx_not_recorded"] : ["full_song_case_failed"];
}
nightly.finishedAt = new Date().toISOString();
const reportPath = path.join(outputDir, "song-full-nightly.report.json");
await fs.writeFile(reportPath, `${JSON.stringify(nightly, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ reportPath, status: nightly.status, caseCount: nightly.cases.length, passed: nightly.cases.filter((item) => item.passed).length }, null, 2));
if (nightly.status !== "completed") process.exitCode = 1;
