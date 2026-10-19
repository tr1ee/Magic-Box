import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildVtvBaselineManifest, validateVtvBaselineManifest } from "../server/voice/vtv/baseline.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = process.argv[2] || "artifacts/vtv-baselines/baseline-manifest.json";
const manifest = await buildVtvBaselineManifest({ repoRoot, outputPath });
const validation = validateVtvBaselineManifest(manifest);
console.log(JSON.stringify({ outputPath, validation, schemaVersion: manifest.schemaVersion, baselineCaseCount: manifest.baselineCases.length }, null, 2));
if (!validation.valid) process.exitCode = 2;
