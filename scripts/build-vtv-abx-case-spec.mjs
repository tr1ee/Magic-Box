import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const arg = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
};
const root = path.resolve(".");
const manifestPath = path.resolve(arg("--manifest"));
const nightlyAPath = path.resolve(arg("--nightly-a"));
const nightlyBPath = path.resolve(arg("--nightly-b"));
const outputPath = path.resolve(arg("--output", "artifacts/vtv-abx/cases.json"));
const modelAId = arg("--model-a", "candidate-a");
const modelBId = arg("--model-b", "candidate-b");

if (!manifestPath || !nightlyAPath || !nightlyBPath) {
  console.error("Usage: node scripts/build-vtv-abx-case-spec.mjs --manifest <manifest.json> --nightly-a <report.json> --nightly-b <report.json> [--output <cases.json>]");
  process.exit(2);
}
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const nightlyA = JSON.parse(await fs.readFile(nightlyAPath, "utf8"));
const nightlyB = JSON.parse(await fs.readFile(nightlyBPath, "utf8"));
const byCase = (nightly) => new Map((nightly.cases || []).map((item) => [item.caseId, item]));
const casesA = byCase(nightlyA);
const casesB = byCase(nightlyB);
const cases = [];
for (const item of manifest.cases || []) {
  const a = casesA.get(item.id);
  const b = casesB.get(item.id);
  if (!a || !b) continue;
  const reportA = JSON.parse(await fs.readFile(path.resolve(a.reportPath), "utf8"));
  const reportB = JSON.parse(await fs.readFile(path.resolve(b.reportPath), "utf8"));
  const candidateAPath = reportA.outputPath || reportA.conversion?.outputPath;
  const candidateBPath = reportB.outputPath || reportB.conversion?.outputPath;
  if (!candidateAPath || !candidateBPath || !item.targetReferencePath) continue;
  cases.push({
    caseId: item.id,
    referencePath: path.resolve(root, item.targetReferencePath),
    candidateAPath: path.resolve(candidateAPath),
    candidateBPath: path.resolve(candidateBPath),
    modelAId,
    modelBId
  });
}
if (!cases.length) throw new Error("No complete ABX cases were found in the two nightly reports.");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify({ schemaVersion: "vtv-abx-case-spec-v1", mode: nightlyA.mode || "speech", corpusHash: nightlyA.corpusHash || "", cases }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, mode: nightlyA.mode || "speech", caseCount: cases.length, modelAId, modelBId }, null, 2));
