import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { buildVtvFineTuneDataset, createVtvCheckpointManifest } from "../server/voice/vtv/finetune.mjs";

const execFileAsync = promisify(execFile);

async function sha256File(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of fsSync.createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}
const inputPath = process.argv[2];
const outputDir = path.resolve(process.argv[3] || "artifacts/vtv-finetune/run");
const mode = process.argv[4] === "song" ? "song" : "speech";
const explicitExecutable = process.env.MAGICBOX_VTV_FINETUNE_EXECUTABLE || "";
const extraArgs = JSON.parse(process.env.MAGICBOX_VTV_FINETUNE_ARGS_JSON || "[]");
const lockedTestRatio = Math.max(0.1, Math.min(0.5, Number(process.env.MAGICBOX_VTV_LOCKED_TEST_RATIO || "0.2") || 0.2));

const runtimeRoot = path.resolve(process.env.MAGICBOX_VTV_RUNTIME_ROOT || path.join(process.cwd(), "MagicBoxData", "voice_clone", "voice_engine", "seed-vc"));
const managedPython = path.join(runtimeRoot, "runtime", "python", "python.exe");
const seedVcRepo = path.resolve(process.env.MAGICBOX_VTV_SEED_VC_REPO || path.join(runtimeRoot, "runtime", "seed-vc"));
const officialTrain = path.join(seedVcRepo, "train.py");
const useOfficialSeedVc = !explicitExecutable && await fs.access(managedPython).then(() => true).catch(() => false)
  && await fs.access(officialTrain).then(() => true).catch(() => false);
const executable = explicitExecutable || (useOfficialSeedVc ? managedPython : "");

if (!inputPath || !executable) {
  console.error("Usage: node scripts/run-vtv-finetune.mjs <profile-samples.json> <output-dir> [speech|song]");
  console.error("Set MAGICBOX_VTV_FINETUNE_EXECUTABLE, or install the managed pinned Seed-VC runtime with train.py.");
  process.exit(2);
}
if (!Array.isArray(extraArgs) || extraArgs.some((item) => typeof item !== "string")) {
  throw new Error("MAGICBOX_VTV_FINETUNE_ARGS_JSON must be a JSON string array.");
}

const input = JSON.parse(await fs.readFile(path.resolve(inputPath), "utf8"));
const dataset = input.schemaVersion === "vtv-finetune-dataset-v1"
  ? input
  : buildVtvFineTuneDataset({ ...input, mode, lockedTestRatio });
await fs.mkdir(outputDir, { recursive: true });
const datasetPath = path.join(outputDir, "dataset.json");
await fs.writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
if (dataset.mode !== mode || dataset.gate?.passed !== true) {
  const reportPath = path.join(outputDir, "finetune.report.json");
  const report = {
    schemaVersion: "vtv-finetune-run-report-v1",
    status: "blocked",
    mode,
    datasetId: dataset.datasetId || "",
    datasetSnapshotHash: dataset.snapshotHash || "",
    datasetPath,
    gate: dataset.gate || { passed: false, errors: ["invalid_dataset"] },
    blockingReasons: dataset.mode !== mode
      ? ["dataset_mode_mismatch"]
      : (dataset.gate?.errors || ["invalid_dataset"]),
    createdAt: new Date().toISOString()
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(JSON.stringify({ reportPath, status: report.status, blockingReasons: report.blockingReasons }, null, 2));
  process.exit(2);
}
if (mode === "song" && dataset.entries.some((entry) => entry.sampleRate !== 44100)) {
  throw new Error("VTV song fine-tune requires every training clip to be native 44.1 kHz.");
}
if (process.env.MAGICBOX_VTV_FINETUNE_DRY_RUN === "1") {
  console.log(JSON.stringify({ datasetId: dataset.datasetId, mode: dataset.mode, lockedTestRatio, splits: Object.fromEntries(Object.entries(dataset.splits).map(([key, entries]) => [key, entries.length])) }, null, 2));
  process.exit(0);
}
const checkpointPath = path.join(outputDir, "checkpoint");
await fs.mkdir(checkpointPath, { recursive: true });

let commandArgs;
let commandCwd = path.resolve(".");
let trainConfigPath = "";
if (useOfficialSeedVc) {
  const datasetAudioDir = path.join(outputDir, "dataset-audio");
  const configuredVoiceDataRoot = process.env.MAGICBOX_VTV_VOICE_DATA_ROOT
    ? path.resolve(process.env.MAGICBOX_VTV_VOICE_DATA_ROOT)
    : null;
  const voiceDataRoots = [...new Set([
    configuredVoiceDataRoot,
    path.resolve(path.join(process.cwd(), "MagicBoxData", "voice_clone")),
    path.resolve(process.cwd())
  ].filter(Boolean))];
  await fs.mkdir(datasetAudioDir, { recursive: true });
  const trainEntries = Array.isArray(dataset.splits?.train) ? dataset.splits.train : [];
  for (const [index, entry] of trainEntries.entries()) {
    const relativePath = String(entry.relativePath || "").replaceAll("\\", "/");
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error(`VTV training entry must be a relative path: ${relativePath}`);
    }
    let sourcePath = "";
    for (const voiceDataRoot of voiceDataRoots) {
      const candidate = path.resolve(voiceDataRoot, relativePath);
      const relativeToRoot = path.relative(voiceDataRoot, candidate);
      if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) continue;
      if (await fs.access(candidate).then(() => true).catch(() => false)) {
        sourcePath = candidate;
        break;
      }
    }
    if (!sourcePath) {
      throw new Error(`VTV training entry is missing from all managed data roots: ${relativePath}`);
    }
    const extension = path.extname(sourcePath).toLowerCase() || ".wav";
    await fs.copyFile(sourcePath, path.join(datasetAudioDir, `${String(index + 1).padStart(4, "0")}${extension}`));
  }
  if (!trainEntries.length) throw new Error("VTV training dataset has no train entries after leakage-safe splitting.");
  const sourceConfig = process.env.MAGICBOX_VTV_SEED_VC_CONFIG
    ? path.resolve(process.env.MAGICBOX_VTV_SEED_VC_CONFIG)
    : mode === "song" && process.env.MAGICBOX_VTV_SONG_TRAIN_CONFIG
      ? path.resolve(process.env.MAGICBOX_VTV_SONG_TRAIN_CONFIG)
      : path.join(seedVcRepo, "configs", "presets", "config_dit_mel_seed_uvit_whisper_base_f0_44k.yml");
  const configText = await fs.readFile(sourceConfig, "utf8");
  const runRoot = path.join(outputDir, "official-runs");
  const runName = `vtv-${mode}-${dataset.datasetId}`;
  trainConfigPath = path.join(outputDir, "seed-vc-train.yml");
  const normalizedRunRoot = runRoot.replaceAll("\\", "/");
  const modeHeader = `# MagicBox VTV dedicated training contract\n# mode: ${mode}\n# native_sample_rate: ${mode === "song" ? 44100 : 32000}\n`;
  const localModelConfig = configText
    .replace(/^\s+name:\s*.*whisper-small.*$/m, '    name: "./checkpoints/magicbox_models/whisper-small"')
    .replace(/^\s+name:\s*.*bigvgan.*$/m, '    name: "./checkpoints/magicbox_models/bigvgan_v2_44khz_128band_512x"');
  const patchedConfig = modeHeader + (localModelConfig.match(/^log_dir:\s*.*$/mu)
    ? localModelConfig.replace(/^log_dir:\s*.*$/mu, `log_dir: "${normalizedRunRoot}"`)
    : `log_dir: "${normalizedRunRoot}"\n${localModelConfig}`);
  await fs.writeFile(trainConfigPath, patchedConfig, "utf8");
  const checkpointCandidates = await fs.readdir(path.join(seedVcRepo, "checkpoints", "models--Plachta--Seed-VC", "snapshots"), { withFileTypes: true }).catch(() => []);
  const snapshotDir = checkpointCandidates.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name)).at(-1)?.name || "";
  const pretrainedCheckpoint = process.env.MAGICBOX_VTV_SEED_VC_PRETRAINED_CHECKPOINT
    ? path.resolve(process.env.MAGICBOX_VTV_SEED_VC_PRETRAINED_CHECKPOINT)
    : path.join(seedVcRepo, "checkpoints", "models--Plachta--Seed-VC", "snapshots", snapshotDir, "DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth");
  await fs.access(pretrainedCheckpoint);
  commandCwd = seedVcRepo;
  commandArgs = [
    officialTrain,
    "--config", trainConfigPath,
    "--pretrained-ckpt", pretrainedCheckpoint,
    "--dataset-dir", datasetAudioDir,
    "--run-name", runName,
    "--batch-size", process.env.MAGICBOX_VTV_FINETUNE_BATCH_SIZE || "2",
    "--max-steps", process.env.MAGICBOX_VTV_FINETUNE_MAX_STEPS || "1000",
    "--max-epochs", process.env.MAGICBOX_VTV_FINETUNE_MAX_EPOCHS || "1000",
    "--save-every", process.env.MAGICBOX_VTV_FINETUNE_SAVE_EVERY || "500",
    "--num-workers", "0",
    "--gpu", "0",
    ...extraArgs
  ];
} else {
  commandArgs = [
    ...extraArgs,
    "--dataset", datasetPath,
    "--output-dir", checkpointPath,
    "--mode", mode,
    "--num-workers", "0",
    ...(process.env.MAGICBOX_VTV_FINETUNE_RESUME ? ["--resume", process.env.MAGICBOX_VTV_FINETUNE_RESUME] : [])
  ];
}
const { stdout, stderr } = await execFileAsync(executable, commandArgs, {
  cwd: commandCwd,
  windowsHide: true,
  maxBuffer: 8 * 1024 * 1024,
  env: {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    ...(useOfficialSeedVc ? { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } : {})
  }
});
const checkpointCandidates = [];
const checkpointSearchRoot = useOfficialSeedVc ? path.join(outputDir, "official-runs") : checkpointPath;
async function collectCheckpoints(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectCheckpoints(candidate);
    else if (/\.(?:pth|pt|ckpt|bin)$/iu.test(entry.name)) {
      checkpointCandidates.push({ path: candidate, sha256: await sha256File(candidate) });
    }
  }
}
await collectCheckpoints(checkpointSearchRoot);
if (!checkpointCandidates.length) throw new Error("Pinned VTV training entrypoint completed without producing a checkpoint.");
checkpointCandidates.sort((left, right) => left.path.localeCompare(right.path));
const selected = checkpointCandidates[0];
const checkpoint = createVtvCheckpointManifest({
  dataset,
  mode,
  checkpointPath: path.relative(path.resolve("."), selected.path),
  checkpointSha256: selected.sha256,
  configSha256: createHash("sha256").update(trainConfigPath ? await fs.readFile(trainConfigPath) : JSON.stringify({ mode, extraArgs })).digest("hex"),
  validationReportId: `pending-locked-test-${dataset.datasetId}`
});
checkpoint.trainingContract = {
  mode,
  datasetMode: dataset.mode,
  nativeSampleRate: mode === "song" ? 44100 : 32000,
  configPath: path.relative(path.resolve("."), trainConfigPath || "").replaceAll("\\", "/"),
  officialEntrypoint: useOfficialSeedVc ? path.relative(path.resolve("."), officialTrain).replaceAll("\\", "/") : "external"
};
const manifestPath = path.join(outputDir, "checkpoint-manifest.json");
await fs.writeFile(manifestPath, `${JSON.stringify({ checkpoint, candidates: checkpointCandidates, stdout, stderr }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputDir, datasetId: dataset.datasetId, checkpoint: checkpoint.checkpointSha256, manifestPath }, null, 2));
