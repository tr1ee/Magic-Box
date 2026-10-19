import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VtvEngineError } from "../../engine-errors.mjs";
import {
  buildRvcTrainingReport,
  completeRvcTrainingStage,
  createRvcTrainingJob,
  failRvcTrainingStage,
  startRvcTrainingJob
} from "./training-job.mjs";

const MAX_LOG_TAIL = 48 * 1024;

function appendTail(current, chunk) {
  const next = `${current}${String(chunk || "")}`;
  return next.length > MAX_LOG_TAIL ? next.slice(-MAX_LOG_TAIL) : next;
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      const directKillFallback = setTimeout(() => {
        try { child.kill(); } catch {}
      }, 750);
      directKillFallback.unref?.();
      killer.once("close", () => {
        clearTimeout(directKillFallback);
        try { child.kill(); } catch {}
      });
      killer.unref?.();
    } catch {
      try { child.kill(); } catch {}
    }
  } else {
    try { child.kill("SIGTERM"); } catch {}
  }
}

export function runRvcTrainingCommand({ executable, args = [], cwd, env = {}, signal = null, onOutput = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env, PYTHONNOUSERSITE: "1", PYTHONUTF8: "1", PYTHONHASHSEED: "0" }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const abort = () => terminateProcessTree(child);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk);
      onOutput?.(String(chunk), "stdout");
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk);
      onOutput?.(String(chunk), "stderr");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("exit", (code, exitSignal) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(new VtvEngineError("ENGINE_CANCELLED", "RVC training was cancelled."));
        return;
      }
      if (code !== 0) {
        reject(new VtvEngineError("RVC_TRAINING_FAILED", `RVC training command failed (${code ?? "unknown"}/${exitSignal || "none"}).`, {
          details: { args: args.map(String), stdout, stderr }
        }));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function fileNames(directory, suffix) {
  return (await fs.readdir(directory).catch(() => []))
    .filter((name) => name.toLowerCase().endsWith(suffix.toLowerCase()))
    .sort();
}

function portablePath(value) {
  return path.resolve(value).replaceAll("\\", "/");
}

function pythonModuleArgs(moduleName, args = []) {
  return ["-m", moduleName, ...args.map(String)];
}

async function prepareTrainingFileList(experimentDir) {
  const wavDir = path.join(experimentDir, "0_gt_wavs");
  const featureDir = path.join(experimentDir, "3_feature768");
  const f0Dir = path.join(experimentDir, "2a_f0");
  const f0NsfDir = path.join(experimentDir, "2b-f0nsf");
  const wavs = await fileNames(wavDir, ".wav");
  const featureNames = new Set(await fileNames(featureDir, ".npy"));
  const f0Names = new Set(await fileNames(f0Dir, ".npy"));
  const f0NsfNames = new Set(await fileNames(f0NsfDir, ".npy"));
  const valid = wavs.filter((name) => {
    const stem = path.parse(name).name;
    return featureNames.has(`${stem}.npy`) && f0Names.has(`${name}.npy`) && f0NsfNames.has(`${name}.npy`);
  });
  if (!valid.length) {
    throw new VtvEngineError("RVC_TRAINING_FAILED", "RVC preprocessing produced no matching audio, F0, and HuBERT feature records.");
  }
  const lines = valid.map((name) => {
    const stem = path.parse(name).name;
    return [
      portablePath(path.join(wavDir, name)),
      portablePath(path.join(featureDir, `${stem}.npy`)),
      portablePath(path.join(f0Dir, `${name}.npy`)),
      portablePath(path.join(f0NsfDir, `${name}.npy`)),
      "0"
    ].join("|");
  });
  await fs.writeFile(path.join(experimentDir, "filelist.txt"), `${lines.join("\n")}\n`, "utf8");
  return { clipCount: valid.length };
}

async function latestMatchingFile(directory, predicate) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const matches = await Promise.all(entries
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map(async (entry) => ({ path: path.join(directory, entry.name), stat: await fs.stat(path.join(directory, entry.name)) })));
  matches.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs || right.path.localeCompare(left.path));
  return matches[0]?.path || "";
}

export async function runRvcTrainingPipeline({
  runtimeManifest,
  snapshot,
  workspaceRoot,
  profileId = "",
  profileVersionId = "",
  modelId = `rvc-model-${Date.now()}`,
  parameters = {},
  signal = null,
  onProgress = null,
  commandRunner = runRvcTrainingCommand
} = {}) {
  const python = path.resolve(String(runtimeManifest?.pythonExecutable || ""));
  const sourceRoot = path.resolve(String(runtimeManifest?.sourceRoot || ""));
  const sourceStat = await fs.stat(sourceRoot).catch(() => null);
  const pythonStat = await fs.stat(python).catch(() => null);
  if (!sourceStat?.isDirectory() || !pythonStat?.isFile()) {
    throw new VtvEngineError("ENGINE_NOT_INSTALLED", "The active RVC training runtime is incomplete.", { action: "Repair the pinned RVC v2 runtime." });
  }
  if (!snapshot?.readiness?.ready || !snapshot?.snapshotDirectory) {
    throw new VtvEngineError("RVC_TRAINING_DATA_INSUFFICIENT", "RVC training requires an approved dataset snapshot with at least 10 voiced minutes.");
  }

  const cpuCount = Math.max(1, Math.min(8, Number(parameters.cpuWorkers) || os.cpus().length || 1));
  const epochs = Math.max(50, Math.min(1000, Number(parameters.epochs) || 200));
  const saveEvery = Math.max(10, Math.min(epochs, Number(parameters.saveEveryEpoch) || 25));
  const batchSize = Math.max(1, Math.min(8, Number(parameters.batchSize) || 4));
  const experimentName = `magicbox-${String(modelId).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80)}`;
  const runRoot = path.resolve(workspaceRoot);
  const experimentDir = path.join(runRoot, "logs", experimentName);
  const weightsDir = path.join(runRoot, "assets", "weights");
  const indexesDir = path.join(runRoot, "indexes");
  await Promise.all([
    fs.mkdir(experimentDir, { recursive: true }),
    fs.mkdir(weightsDir, { recursive: true }),
    fs.mkdir(indexesDir, { recursive: true }),
    // RVC's upstream I18nAuto resolves locale files from the process cwd.
    // Training intentionally runs inside its profile/job workspace so logs and
    // checkpoints cannot leak across profiles, therefore stage the immutable
    // locale resources into that isolated cwd before launching train or index.
    fs.cp(path.join(sourceRoot, "i18n", "locale"), path.join(runRoot, "i18n", "locale"), {
      recursive: true,
      force: true
    })
  ]);

  const runtimeEnv = {
    PYTHONPATH: [sourceRoot, process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter),
    CUDA_VISIBLE_DEVICES: "0",
    weight_root: weightsDir,
    index_root: indexesDir,
    outside_index_root: indexesDir,
    rmvpe_root: path.join(sourceRoot, "assets", "rmvpe"),
    HF_HOME: path.join(path.dirname(path.dirname(sourceRoot)), "cache"),
    TORCH_HOME: path.join(path.dirname(path.dirname(sourceRoot)), "cache")
  };
  const stageProgress = {
    preprocess: [8, 22, "Slicing and normalizing approved Profile clips to 48 kHz"],
    f0: [24, 36, "Extracting pitch with RMVPE"],
    features: [38, 50, "Extracting HuBERT content features"],
    train: [52, 82, `Training RVC v2 for ${epochs} epochs`],
    index: [84, 91, "Building the FAISS feature index"],
    package: [93, 96, "Collecting the trained model and index"],
    validate: [97, 99, "Preparing the trained bundle for locked validation"]
  };
  let trainingJob = startRvcTrainingJob(createRvcTrainingJob({
    jobId: path.basename(runRoot),
    profileId,
    profileVersionId,
    datasetHash: snapshot.datasetHash,
    runtimeRevision: runtimeManifest.sourceRevision || "8f2fdbf",
    parameters: { epochs, saveEveryEpoch: saveEvery, batchSize, cpuWorkers: cpuCount, sampleRate: 48000, version: "v2", f0Method: "rmvpe" }
  }));

  async function stage(stageId, run) {
    const [start, end, message] = stageProgress[stageId];
    onProgress?.({ stage: stageId, progress: start, message, trainingJob });
    try {
      const evidence = await run();
      trainingJob = completeRvcTrainingStage(trainingJob, stageId, evidence || {});
      onProgress?.({ stage: stageId, progress: end, message, trainingJob });
      return evidence;
    } catch (error) {
      trainingJob = failRvcTrainingStage(trainingJob, stageId, error.message);
      error.trainingReport = buildRvcTrainingReport(trainingJob);
      throw error;
    }
  }

  await stage("preprocess", async () => {
    await commandRunner({
      executable: python,
      // Run RVC's training scripts as modules. Executing train/preprocess.py or
      // train/train.py by file path puts the train directory first on sys.path,
      // where train.py shadows the train namespace package and creates a
      // circular import when preprocess.py imports train.dataset.
      args: pythonModuleArgs("train.preprocess", [snapshot.snapshotDirectory, "48000", cpuCount, experimentDir, "False", "3.7"]),
      cwd: sourceRoot,
      env: runtimeEnv,
      signal
    });
    const clips = await fileNames(path.join(experimentDir, "0_gt_wavs"), ".wav");
    if (!clips.length) throw new VtvEngineError("RVC_TRAINING_FAILED", "RVC preprocessing produced no usable clips.");
    return { normalizedClipCount: clips.length };
  });

  await stage("f0", async () => {
    await commandRunner({
      executable: python,
      args: pythonModuleArgs("train.dataset.extract_f0", ["cuda", "1", "0", "0", experimentDir, "true"]),
      cwd: sourceRoot,
      env: runtimeEnv,
      signal
    });
    return { method: "rmvpe", device: "cuda:0" };
  });

  await stage("features", async () => {
    await commandRunner({
      executable: python,
      args: pythonModuleArgs("train.dataset.extract_hubert_feature", ["cuda", "1", "0", "0", experimentDir, "v2", "true"]),
      cwd: sourceRoot,
      env: runtimeEnv,
      signal
    });
    return { featureType: "HuBERT-768", device: "cuda:0" };
  });

  const fileList = await prepareTrainingFileList(experimentDir);
  await fs.copyFile(path.join(sourceRoot, "configs", "v2", "48k.json"), path.join(experimentDir, "config.json"));

  await stage("train", async () => {
    await commandRunner({
      executable: python,
      args: pythonModuleArgs("train.train", [
        "-e", experimentName,
        "-sr", "48k",
        "-f0", "1",
        "-bs", String(batchSize),
        "-g", "0",
        "-te", String(epochs),
        "-se", String(saveEvery),
        "-pg", path.join(sourceRoot, "assets", "pretrained_v2", "f0G48k.pth"),
        "-pd", path.join(sourceRoot, "assets", "pretrained_v2", "f0D48k.pth"),
        "-l", "1",
        "-c", "0",
        "-sw", "0",
        "-v", "v2"
      ]),
      cwd: runRoot,
      env: runtimeEnv,
      signal,
      onOutput: (chunk) => {
        const match = String(chunk).match(/(?:epoch|轮次)[^0-9]*(\d+)/i);
        if (match) {
          const epoch = Math.max(0, Math.min(epochs, Number(match[1]) || 0));
          onProgress?.({ stage: "train", progress: 52 + Math.round((epoch / epochs) * 30), message: `Training RVC v2 · epoch ${epoch}/${epochs}`, trainingJob });
        }
      }
    });
    return { epochs, batchSize, trainingClipCount: fileList.clipCount };
  });

  await stage("index", async () => {
    await commandRunner({
      executable: python,
      args: pythonModuleArgs("train.train_index", [experimentName, "v2", indexesDir, cpuCount]),
      cwd: runRoot,
      env: runtimeEnv,
      signal
    });
    return { type: "FAISS-IVF", featureDimension: 768 };
  });

  const artifacts = await stage("package", async () => {
    const modelPath = await latestMatchingFile(weightsDir, (name) => name.toLowerCase().endsWith(".pth"));
    const indexPath = await latestMatchingFile(experimentDir, (name) => name.startsWith("added_") && name.toLowerCase().endsWith(".index"))
      || await latestMatchingFile(indexesDir, (name) => name.toLowerCase().endsWith(".index"));
    if (!modelPath) throw new VtvEngineError("RVC_TRAINING_FAILED", "RVC training completed without exporting a .pth model.");
    if (!indexPath) throw new VtvEngineError("RVC_TRAINING_FAILED", "RVC training completed without exporting a FAISS .index file.");
    return { modelPath, indexPath };
  });

  await stage("validate", async () => ({ validationInput: snapshot.sourceFiles[0]?.sha256 || "", pendingWorkerSmoke: true }));
  return {
    ...artifacts,
    parameters: { epochs, saveEveryEpoch: saveEvery, batchSize, cpuWorkers: cpuCount },
    trainingReport: buildRvcTrainingReport(trainingJob, { modelId, experimentName, trainingClipCount: fileList.clipCount })
  };
}
