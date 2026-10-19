import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assessRvcTrainingReadiness, selectRvcProfileTrainingSources } from "../server/voice/vtv/engines/rvc-v2/training.mjs";
import { runRvcTrainingPipeline } from "../server/voice/vtv/engines/rvc-v2/training-orchestrator.mjs";
import { normalizeRvcSettings } from "../server/voice/vtv/engines/rvc-v2/presets.mjs";
import { createRvcV2Adapter } from "../server/voice/vtv/engines/rvc-v2/adapter.mjs";
import { RVC_TRAINING_STAGES, buildRvcTrainingReport, completeRvcTrainingStage, createRvcTrainingJob, failRvcTrainingStage, requestRvcTrainingCancel, resumeRvcTrainingJob, startRvcTrainingJob } from "../server/voice/vtv/engines/rvc-v2/training-job.mjs";

test("RVC training blocks data below ten voiced minutes", () => {
  const blocked = assessRvcTrainingReadiness({ voicedDurationSec: 599 });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.missingVoicedDurationSec, 1);
  assert.equal(assessRvcTrainingReadiness({ voicedDurationSec: 1200, singingDurationSec: 300 }).songCapable, true);
});

test("RVC selects only approved Profile transcript clips", () => {
  const sources = selectRvcProfileTrainingSources([
    { profileId: "p1", id: "s1", preparation: { status: "ready" }, segments: [
      { id: "ok", audioPath: "ok.wav", durationSeconds: 6, transcript: "approved", qualityVerdict: "eligible", boundary: "complete", includeInTraining: true },
      { id: "excluded", audioPath: "no.wav", durationSeconds: 6, qualityVerdict: "eligible", boundary: "complete", includeInTraining: false }
    ] },
    { profileId: "p2", id: "s2", preparation: { status: "ready" }, segments: [{ id: "other", audioPath: "other.wav", durationSeconds: 6, qualityVerdict: "eligible", boundary: "complete" }] }
  ], "p1");
  assert.deepEqual(sources.map((source) => source.segmentId), ["ok"]);
  assert.equal(sources[0].voicedDurationSec, 6);
});

test("RVC preset keeps zero pitch shift by default", () => {
  const settings = normalizeRvcSettings({});
  assert.equal(settings.f0Method, "rmvpe");
  assert.equal(settings.preset, "identity");
  assert.equal(settings.indexRate, 0.75);
  assert.equal(settings.pitchShiftSemitones, 0);
  assert.equal(settings.chunkSeconds, 30);
  assert.equal(settings.chunkContextSeconds, 3);
});

test("RVC maps the shared song pitch control to its native semitone setting", () => {
  assert.equal(normalizeRvcSettings({ preset: "identity", pitchShift: 9 }).pitchShiftSemitones, 9);
  assert.equal(normalizeRvcSettings({ pitchShift: 99 }).pitchShiftSemitones, 24);
});

test("RVC adapter forwards native pitch and exposes measured runtime metrics", async () => {
  const requests = [];
  const adapter = createRvcV2Adapter({
    resolver: { tempDir: () => os.tmpdir() },
    runtimeManifest: { version: "test" },
    workerManager: {
      async request(request) {
        requests.push(request);
        if (request.command === "infer") {
          return {
            outputPath: path.join(os.tmpdir(), "rvc-adapter-output.wav"),
            durationSec: 90,
            runtimeFactor: 0.12,
            peakVramMiB: 1600,
            chunked: true,
            chunkCount: 2,
            chunkSeconds: 30,
            reportedPitchShift: 3
          };
        }
        return { loaded: true };
      }
    }
  });
  const result = await adapter.convertSong({
    jobId: "job-1",
    engineRunId: "run-1",
    target: {},
    shared: { leadVocalPath: "source.wav", durationSeconds: 90 },
    settings: { preset: "identity", pitchShift: 3 },
    runtimeManifest: { version: "test" }
  });
  const inference = requests.find((request) => request.command === "infer");
  assert.equal(inference.settings.pitchShiftSemitones, 3);
  assert.equal(inference.settings.chunkSeconds, 30);
  assert.equal(result.engineMetrics.reportedPitchShift, 3);
  assert.equal(result.engineMetrics.runtimeFactor, 0.12);
  assert.equal(result.engineMetrics.peakVramMiB, 1600);
});

test("RVC training job contract resumes completed stages and reports cancellation", () => {
  let job = startRvcTrainingJob(createRvcTrainingJob({ profileId: "profile-1", datasetHash: "dataset-1" }));
  job = completeRvcTrainingStage(job, "preprocess", { clips: 118 });
  job = failRvcTrainingStage(job, "f0", "worker stopped");
  assert.deepEqual(job.stages.filter((stage) => stage.status === "completed").map((stage) => stage.id), ["preprocess"]);
  job = resumeRvcTrainingJob(job);
  assert.equal(job.currentStage, "f0");
  assert.deepEqual(RVC_TRAINING_STAGES, ["preprocess", "f0", "features", "train", "index", "package", "validate"]);
  const cancelled = requestRvcTrainingCancel(job, "user requested stop");
  const report = buildRvcTrainingReport(cancelled);
  assert.equal(report.status, "cancelled");
  assert.equal(report.resumable, true);
  assert.equal(typeof report.reportHash, "string");
});

test("RVC training pipeline generates model and index without asking the user for them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magic-box-rvc-training-"));
  const sourceRoot = path.join(root, "runtime", "source");
  const python = path.join(root, "runtime", "python.exe");
  const workspace = path.join(root, "workspace");
  const snapshotDirectory = path.join(root, "snapshot");
  await Promise.all([
    fs.mkdir(path.join(sourceRoot, "configs", "v2"), { recursive: true }),
    fs.mkdir(path.join(sourceRoot, "i18n", "locale"), { recursive: true }),
    fs.mkdir(snapshotDirectory, { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(python, "fake"),
    fs.writeFile(path.join(sourceRoot, "configs", "v2", "48k.json"), "{}"),
    fs.writeFile(path.join(sourceRoot, "i18n", "locale", "en_US.json"), "{}")
  ]);
  const commands = [];
  const commandRunner = async ({ args, cwd }) => {
    commands.push(args);
    assert.equal(args[0], "-m");
    const moduleName = args[1];
    if (moduleName === "train.preprocess") {
      const experimentDir = args[5];
      await Promise.all([
        fs.mkdir(path.join(experimentDir, "0_gt_wavs"), { recursive: true }),
        fs.mkdir(path.join(experimentDir, "1_16k_wavs"), { recursive: true })
      ]);
      await fs.writeFile(path.join(experimentDir, "0_gt_wavs", "clip.wav"), "wav");
    } else if (moduleName === "train.dataset.extract_f0") {
      const experimentDir = args[6];
      await Promise.all([
        fs.mkdir(path.join(experimentDir, "2a_f0"), { recursive: true }),
        fs.mkdir(path.join(experimentDir, "2b-f0nsf"), { recursive: true })
      ]);
      await Promise.all([
        fs.writeFile(path.join(experimentDir, "2a_f0", "clip.wav.npy"), "f0"),
        fs.writeFile(path.join(experimentDir, "2b-f0nsf", "clip.wav.npy"), "f0nsf")
      ]);
    } else if (moduleName === "train.dataset.extract_hubert_feature") {
      const experimentDir = args[6];
      await fs.mkdir(path.join(experimentDir, "3_feature768"), { recursive: true });
      await fs.writeFile(path.join(experimentDir, "3_feature768", "clip.npy"), "features");
    } else if (moduleName === "train.train") {
      const experimentName = args[args.indexOf("-e") + 1];
      await fs.mkdir(path.join(cwd, "assets", "weights"), { recursive: true });
      await fs.writeFile(path.join(cwd, "assets", "weights", `${experimentName}.pth`), "model");
    } else if (moduleName === "train.train_index") {
      const experimentName = args[2];
      const experimentDir = path.join(cwd, "logs", experimentName);
      await fs.writeFile(path.join(experimentDir, `added_${experimentName}.index`), "index");
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const result = await runRvcTrainingPipeline({
      runtimeManifest: { pythonExecutable: python, sourceRoot, sourceRevision: "8f2fdbf" },
      snapshot: { datasetHash: "dataset", readiness: { ready: true }, snapshotDirectory, sourceFiles: [{ sha256: "clip" }] },
      workspaceRoot: workspace,
      profileId: "p1",
      modelId: "model-1",
      parameters: { epochs: 50 },
      commandRunner
    });
    assert.equal(commands.length, 5);
    assert.equal(await fs.readFile(path.join(workspace, "i18n", "locale", "en_US.json"), "utf8"), "{}");
    assert.deepEqual(commands.map((args) => args.slice(0, 2)), [
      ["-m", "train.preprocess"],
      ["-m", "train.dataset.extract_f0"],
      ["-m", "train.dataset.extract_hubert_feature"],
      ["-m", "train.train"],
      ["-m", "train.train_index"]
    ]);
    assert.equal(path.extname(result.modelPath), ".pth");
    assert.equal(path.extname(result.indexPath), ".index");
    assert.deepEqual(result.trainingReport.completedStages, ["preprocess", "f0", "features", "train", "index", "package", "validate"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
