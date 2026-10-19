import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = path.resolve(".");
const arg = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
};
const sourcePath = path.resolve(arg("--source"));
const references = [...new Set(arg("--references", "").split("|").map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value)))];
const checkpointPath = path.resolve(arg("--checkpoint"));
const configPath = path.resolve(arg("--config"));
const outputDir = path.resolve(arg("--output-dir", "artifacts/vtv-benchmarks/full-song"));
const caseId = arg("--case-id", path.basename(sourcePath, path.extname(sourcePath)));
const profileId = arg("--profile-id", "vtv-full-song-target");
const diffusionSteps = Math.max(4, Math.min(50, Number(arg("--steps", "12")) || 12));
const inferenceCfgRate = Math.max(0, Math.min(1, Number(arg("--cfg", "0.85")) || 0));
const separationModel = arg("--separation-model", "htdemucs").toLowerCase();
const outputReport = path.join(outputDir, `${caseId}.full-song.report.json`);

async function exists(filePath) {
  return Boolean(await fs.stat(filePath).catch(() => null));
}

if (!sourcePath || !references.length || !checkpointPath || !configPath
  || !(await exists(sourcePath))
  || !(await exists(checkpointPath))
  || !(await exists(configPath))
  || !(await Promise.all(references.map(exists))).every(Boolean)) {
  console.error("Usage: node scripts/run-vtv-full-song-regression.mjs --source <mixture.wav> --references <ref.wav|ref.wav> --checkpoint <pth> --config <yml> [--steps 12] [--cfg 0.85] [--separation-model htdemucs] [--output-dir <dir>] [--case-id <id>]");
  process.exit(2);
}

const sourceHash = createHash("sha256").update(await fs.readFile(sourcePath)).digest("hex");
const checkpointHash = createHash("sha256");
for await (const chunk of (await import("node:fs")).createReadStream(checkpointPath)) checkpointHash.update(chunk);
const checkpointSha256 = checkpointHash.digest("hex");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "magic-box-vtv-full-song-"));
const voiceRoot = path.join(tempRoot, "voice_clone");
const referenceRoot = path.join(voiceRoot, "profiles", profileId, "references");
await fs.mkdir(referenceRoot, { recursive: true });
const referenceArtifacts = [];
for (const [index, referencePath] of references.entries()) {
  const target = path.join(referenceRoot, `reference-${String(index + 1).padStart(2, "0")}.wav`);
  await fs.copyFile(referencePath, target);
  referenceArtifacts.push({
    artifactId: `song-reference-${index + 1}`,
    relativePath: path.relative(voiceRoot, target).replaceAll("\\", "/"),
    durationSeconds: 5,
    voicedDurationSeconds: 5,
    nativeSampleRate: 44100,
    quality: { passed: true },
    speakerConsistency: { passed: true }
  });
}
const referenceAudioPath = path.join(referenceRoot, "reference-01.wav");
const versionId = `${profileId}-seed-vc-finetuned`;
const referencePack = {
  referencePackId: `${profileId}-song-reference-pack-v2`,
  artifacts: referenceArtifacts,
  qualitySummary: { passed: true, status: "ready" },
  speakerCentroids: { campplus: "local-campplus", eres2netv2: "local-eres2netv2" }
};
const profile = {
  id: profileId,
  name: "VTV full-song regression target",
  language: "und",
  status: "ready",
  engine: "seed-vc-svc-local",
  activeModelVersionId: versionId,
  voiceModel: {
    versionId,
    engine: "seed-vc-svc-local",
    modelVersion: "seed-vc-svc-v1",
    qualityMode: "fine",
    referenceAudioPath,
    checkpointHash: checkpointSha256,
    referencePacks: { seedInference: referencePack, vtvSong: referencePack }
  },
  modelVersions: [{ id: versionId, label: "VTV fine-tuned Song checkpoint", voiceModel: {
    versionId,
    engine: "seed-vc-svc-local",
    modelVersion: "seed-vc-svc-v1",
    qualityMode: "fine",
    referenceAudioPath,
    checkpointHash: checkpointSha256,
    referencePacks: { seedInference: referencePack, vtvSong: referencePack }
  } }]
};
await fs.writeFile(path.join(voiceRoot, "voice_clone.json"), `${JSON.stringify({
  schemaVersion: 2,
  profiles: [profile],
  samples: [],
  outputs: [],
  artifacts: [],
  referencePacks: [],
  attempts: [],
  qualityReports: [],
  jobs: [],
  jobEvents: []
}, null, 2)}\n`, "utf8");
await fs.mkdir(outputDir, { recursive: true });

process.env.MAGIC_BOX_VOICE_DATA_ROOT = voiceRoot;
process.env.MAGIC_BOX_VOICE_ENGINE_ROOT = path.resolve("MagicBoxData/voice_clone/voice_engine");
process.env.MAGIC_BOX_SETTINGS_FILE = path.join(tempRoot, "settings.json");
const { startServer } = await import(pathToFileURL(path.join(root, "server/index.mjs")).href);
let app;
let job = null;
const startedAt = new Date().toISOString();
try {
  app = await startServer({ port: 0, host: "127.0.0.1", defaultDownloadDir: outputDir });
  const form = new FormData();
  form.append("profileId", profileId);
  form.append("modelVersionId", versionId);
  form.append("language", "und");
  form.append("outputDir", outputDir);
  form.append("settingsJson", JSON.stringify({
    conversionEngine: "seed-vc-svc-local",
    separationModel,
    checkpointPath,
    configPath,
    outputFormat: "wav",
    preserveEmotion: true,
    preserveTiming: true,
    candidateBudget: 3,
    allowNeedsReview: false,
    diffusionSteps,
    inferenceCfgRate,
    chunkCrossfadeMs: 750,
    separationOverlap: 0.5,
    vocalVolume: 1,
    accompanimentVolume: 0.9
  }));
  form.append("sourceAudio", new Blob([await fs.readFile(sourcePath)], { type: "audio/wav" }), path.basename(sourcePath));
  const response = await fetch(`${app.url}/api/voice-clone/song-v2v`, { method: "POST", body: form });
  const created = await response.json();
  if (!response.ok) throw new Error(`song-v2v request failed (${response.status}): ${JSON.stringify(created)}`);
  job = created;
  const terminalStatuses = new Set(["completed", "failed", "cancelled", "rejected", "needs-review"]);
  for (let attempt = 0; attempt < 1800; attempt += 1) {
    if (terminalStatuses.has(job.status) || terminalStatuses.has(job.terminalStatus)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const poll = await fetch(`${app.url}/api/voice-clone/jobs/${encodeURIComponent(created.id)}`);
    job = await poll.json();
  }
  const report = {
    schemaVersion: "vtv-full-song-regression-report-v1",
    caseId,
    mode: "song",
    sourcePath,
    sourceSha256: sourceHash,
    targetReferencePaths: references,
    checkpointPath,
    checkpointSha256,
    configPath,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: job.status,
    diffusionSteps,
    inferenceCfgRate,
    separationModel,
    job
  };
  await fs.writeFile(outputReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputReport, status: job.status, jobId: job.id, outputPath: job.result?.output?.outputPath || null }, null, 2));
  if (job.status !== "completed") process.exitCode = 1;
} finally {
  await Promise.race([
    app?.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
