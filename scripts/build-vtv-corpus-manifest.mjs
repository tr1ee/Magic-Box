import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { buildVtvCorpusManifest } from "../server/voice/vtv/corpus.mjs";

const execFileAsync = promisify(execFile);
const inputPath = process.argv[2];
const outputPath = path.resolve(process.argv[3] || "artifacts/vtv-corpus/corpus-manifest.json");
if (!inputPath) {
  console.error("Usage: node scripts/build-vtv-corpus-manifest.mjs <corpus-input.json> [output.json]");
  process.exit(2);
}

const input = JSON.parse(await fs.readFile(path.resolve(inputPath), "utf8"));
const ffprobe = process.env.MAGICBOX_FFPROBE_PATH
  || path.resolve("node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe");
async function enrichCase(item) {
  const filePath = path.resolve(String(item.path || item.relativePath || ""));
  const bytes = await fs.readFile(filePath);
  const probe = JSON.parse((await execFileAsync(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=sample_rate,channels", "-of", "json", filePath], { windowsHide: true })).stdout);
  const stream = (probe.streams || []).find((entry) => entry.sample_rate || entry.channels) || {};
  return {
    ...item,
    path: filePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceSha256: item.sourceSha256 || createHash("sha256").update(bytes).digest("hex"),
    durationSeconds: Number(probe.format?.duration || 0),
    sampleRate: Number(stream.sample_rate || 0),
    channels: Number(stream.channels || 0)
  };
}
const speech = await Promise.all((Array.isArray(input.speech) ? input.speech : []).map(enrichCase));
const song = await Promise.all((Array.isArray(input.song) ? input.song : []).map(enrichCase));
const manifest = buildVtvCorpusManifest({ ...input, speech, song });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, corpusHash: manifest.corpusHash, gate: manifest.gate, counts: manifest.counts }, null, 2));
if (!manifest.gate.passed) process.exitCode = 2;

