import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const profileId = process.argv[2];
const outputPath = path.resolve(process.argv[3] || "artifacts/vtv-finetune/profile-samples.json");
const mode = process.argv[4] === "song" ? "song" : "speech";
const root = path.resolve(process.cwd());
const voiceDataRoot = path.join(root, "MagicBoxData", "voice_clone");
if (!profileId) {
  console.error("Usage: node scripts/export-vtv-profile-samples.mjs <profileId> [output.json] [speech|song]");
  process.exit(2);
}

const db = JSON.parse(await fs.readFile(path.join(voiceDataRoot, "voice_clone.json"), "utf8"));
const profile = (db.profiles || []).find((item) => item.id === profileId);
if (!profile) throw new Error(`Voice profile not found: ${profileId}`);
const model = profile.voiceModel || {};
const samples = [];
for (const [index, sample] of (Array.isArray(model.datasetSamples) ? model.datasetSamples : []).entries()) {
  const audioPath = path.resolve(String(sample.audioPath || ""));
  const relativePath = path.relative(voiceDataRoot, audioPath).replaceAll(path.sep, "/");
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Profile dataset sample is outside managed voice root: ${audioPath}`);
  }
  const bytes = await fs.readFile(audioPath);
  const probe = await execFileAsync(
    path.join(root, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe"),
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audioPath],
    { windowsHide: true, maxBuffer: 1024 * 1024 }
  );
  const durationSeconds = Number.parseFloat(String(probe.stdout || "").trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`Invalid duration for ${relativePath}`);
  samples.push({
    id: String(sample.segmentId || `profile-segment-${index + 1}`),
    sourceSha256: String(sample.sampleId || ""),
    audioSha256: createHash("sha256").update(bytes).digest("hex"),
    relativePath,
    durationSeconds,
    voicedDurationSeconds: durationSeconds,
    transcript: String(sample.transcript || "").trim(),
    language: String(sample.language || profile.language || "auto"),
    preparation: { status: "ready" }
  });
}
const result = {
  profileId,
  modelVersionId: String(model.versionId || ""),
  mode,
  samples
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, profileId, mode, sampleCount: samples.length }, null, 2));
