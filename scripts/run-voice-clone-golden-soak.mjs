import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argValue = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
};
const hasFlag = (name) => process.argv.includes(name);
const numberArg = (name, fallback, minimum = 1) => {
  const value = Number(argValue(name, ""));
  return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback;
};

const mode = String(argValue("--mode", "golden")).toLowerCase();
const pipeline = String(argValue("--pipeline", mode === "soak" ? "v2" : "both")).toLowerCase();
const profileIdArg = argValue("--profile-id", "");
const profileNameArg = argValue("--profile-name", "Ameath2");
const sourceDbPath = path.resolve(argValue("--db", path.join(rootDir, "MagicBoxData", "voice_clone", "voice_clone.json")));
const engineRoot = path.resolve(argValue("--engine-root", path.join(rootDir, "MagicBoxData", "voice_clone", "voice_engine")));
const suppliedDataRoot = argValue("--data-root", "");
const suppliedSettingsPath = argValue("--settings-file", "");
const defaultDataRoot = path.join(rootDir, "MagicBoxData", "voice_clone");
const defaultSettingsPath = path.join(rootDir, "MagicBoxData", "settings.json");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = path.resolve(argValue("--output-dir", path.join(rootDir, "artifacts", "voice-clone-golden", runId)));
const textArg = argValue("--text", "");
const qualityModeArg = String(argValue("--quality-mode", "strict")).toLowerCase();
const refinementModeArg = String(argValue("--refinement-mode", "auto")).toLowerCase();
const count = numberArg("--count", mode === "soak" ? 100 : 5);
const pollMs = numberArg("--poll-ms", 1000, 100);
const timeoutMs = numberArg("--timeout-ms", mode === "soak" ? 900000 : 1200000, 1000);
const retainAudio = mode !== "soak" || hasFlag("--retain-audio");
const rebuild = hasFlag("--rebuild");
const gptCandidateCount = numberArg("--gpt-candidate-count", mode === "soak" ? 1 : 3);
const seedCandidateCount = numberArg("--seed-candidate-count", mode === "soak" ? 1 : 3);
const requestedGenerationSeed = argValue(
  "--seed",
  ""
);

if (!["golden", "soak"].includes(mode)) throw new Error("--mode must be golden or soak.");
if (!["baseline", "v2", "both"].includes(pipeline)) throw new Error("--pipeline must be baseline, v2, or both.");
if (mode === "soak" && pipeline === "both") throw new Error("Soak mode accepts one pipeline at a time.");

const goldenTexts = [
  "你好，欢迎回到 MagicBox。",
  "嗯嗯嗯，我们先确认一下：今天是二零二六年八月二十四日。",
  "当前状态是 stable。",
  "如果你愿意，我们可以先听一条短句，再继续处理更长的内容。",
  "这是一个用于长文本回归的较长句子，用来检查中文内容完整性、标点停顿、连续语音自然度，以及多个语音片段之间是否存在可听的接缝。"
];
const soakTexts = [
  "你好，欢迎回到 MagicBox。",
  "嗯嗯嗯，我们先确认一下：今天是二零二六年八月二十四日。",
  "当前状态是 stable。",
  "如果你愿意，我们可以先听一条短句，再继续处理更长的内容。",
  "这是一个用于长文本回归的较长句子，用来检查中文内容完整性、标点停顿、连续语音自然度，以及多个语音片段之间是否存在可听的接缝。"
];

function cloneEnv(names) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot) {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function configureEnvironment({ dataRoot, settingsPath, outputDir, pipelineMode }) {
  process.env.MAGIC_BOX_SETTINGS_FILE = settingsPath;
  process.env.MAGIC_BOX_VOICE_DATA_ROOT = dataRoot;
  process.env.MAGIC_BOX_VOICE_ENGINE_ROOT = engineRoot;
  process.env.MAGIC_BOX_VOICE_QUALITY_EVALUATOR_DIR = path.join(engineRoot, "quality-evaluators");
  process.env.MAGIC_BOX_ASSISTANT_DATA_DIR = path.join(dataRoot, "assistant");
  process.env.VOICE_STARTUP_WARMUP = "0";
  process.env.VOICE_CLONE_PIPELINE_V2_ENABLED = pipelineMode === "v2" ? "1" : "0";
  process.env.VOICE_CLONE_REFERENCE_STRICT_ENABLED = "1";
  process.env.VOICE_CLONE_DATASET_SNAPSHOT_ENABLED = "1";
  process.env.VOICE_CLONE_PERSIST_ATTEMPTS_ENABLED = "1";
  process.env.VOICE_CLONE_DUAL_SPEAKER_GATE_ENABLED = pipelineMode === "v2" ? "1" : "0";
  process.env.VOICE_CLONE_PERCEPTUAL_GATE_ENABLED = pipelineMode === "v2" ? "1" : "0";
  process.env.VOICE_CLONE_SECONDARY_ASR_ENABLED = "1";
  process.env.VOICE_CLONE_PERSISTENT_WORKERS_ENABLED = (hasFlag("--persistent-workers") || mode === "soak") ? "1" : "0";
  process.env.TORRENT_DOWNLOAD_DIR = outputDir;
  delete process.env.MAGIC_BOX_VOICE_ENGINE_FAKE;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function chooseProfile(db) {
  const profiles = Array.isArray(db.profiles) ? db.profiles : [];
  const profile = profileIdArg
    ? profiles.find((item) => item?.id === profileIdArg)
    : profiles.find((item) => item?.name === profileNameArg) || profiles[0];
  if (!profile) throw new Error(`Voice profile was not found: ${profileIdArg || profileNameArg}`);
  if (profile.status !== "ready" || !profile.voiceModel?.engine) {
    throw new Error(`Voice profile is not ready for generation: ${profile.id}`);
  }
  return profile;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of (await import("node:fs")).createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function requestJson(baseUrl, route, init = {}) {
  const response = await fetch(`${baseUrl}${route}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${route} failed with ${response.status}: ${body.error || response.statusText}`);
  }
  return body;
}

async function waitForJob(baseUrl, jobId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = await requestJson(baseUrl, `/api/voice-clone/jobs/${encodeURIComponent(jobId)}`);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Voice job ${jobId} exceeded ${timeoutMs}ms.`);
}

async function rebuildProfile(baseUrl, profile) {
  const submitted = await requestJson(baseUrl, `/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ qualityMode: "fine", engine: profile.voiceModel?.engine || profile.engine })
  });
  const job = await waitForJob(baseUrl, submitted.id);
  if (job.status !== "completed") {
    throw new Error(`Isolated Fine rebuild failed: ${job.error || job.message || job.status}`);
  }
  return {
    jobId: job.id,
    modelVersionId: job.result?.profile?.activeModelVersionId || "",
    status: job.status,
    warnings: job.result?.warnings || []
  };
}

function compactLineage(output, qualityReport) {
  const settings = output?.settings || {};
  const lineage = settings.lineage || {};
  const refinement = settings.gptSoVitsRequest?.refinement || settings.refinement || {};
  return {
    pipeline: lineage.pipeline || settings.pipeline || "",
    generationPath: refinement.resultType || settings.generationPath || "",
    qualityMode: qualityReport?.qualityMode || settings.qualityMode || "",
    modelVersionId: lineage.modelVersionId || "",
    datasetSnapshotHash: lineage.datasetSnapshotHash || "",
    referencePackId: lineage.referencePackId || "",
    referenceState: lineage.referenceState || "",
    selectedCandidateId: settings.gptSoVitsRequest?.selectedCandidateId || "",
    selectedCandidateSeed: settings.gptSoVitsRequest?.selectedCandidateSeed ?? null,
    refinementApplied: refinement.applied === true,
    attemptCount: Array.isArray(refinement.attempts) ? refinement.attempts.length : 0
  };
}

async function runOne({ baseUrl, profile, text, pipelineMode, outputDir, index }) {
  const fixtureCandidateIndex = !requestedGenerationSeed && mode === "soak" && gptCandidateCount === 1
    ? (
      text.includes("嗯嗯嗯")
        ? 1
        : 2
    )
    : null;
  const fixtureSeed = requestedGenerationSeed || "";
  const submitted = await requestJson(baseUrl, "/api/voice-clone/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profileId: profile.id,
      text,
      language: profile.language || "zh",
      outputDir,
      settings: {
        outputFormat: "wav",
        qualityMode: qualityModeArg,
        refinementMode: refinementModeArg,
        candidateCount: pipelineMode === "v2" ? gptCandidateCount : 1,
        gptCandidateCount: pipelineMode === "v2" ? gptCandidateCount : 1,
        seedCandidateCount: pipelineMode === "v2" ? seedCandidateCount : 1,
        ...(fixtureCandidateIndex === null ? {} : {
          voiceGoldenFixture: true,
          gptCandidateFixtureIndex: fixtureCandidateIndex
        }),
        ...(fixtureSeed ? { seed: Number(fixtureSeed) } : {})
      }
    })
  });
  const job = await waitForJob(baseUrl, submitted.id);
  if (job.status !== "completed" || !job.result?.output) {
    return {
      index,
      pipeline: pipelineMode,
      text,
      status: job.status,
      jobId: job.id,
      error: job.error || "Voice job did not produce an output.",
      diagnostics: job.diagnostics || null
    };
  }
  const output = job.result.output;
  const quality = output.settings?.qualityReport || (await requestJson(
    baseUrl,
    `/api/voice-clone/outputs/${encodeURIComponent(output.id)}/quality-report`
  )).qualityReport;
  const audioPath = output.outputPath;
  const audioInfo = audioPath ? await fs.stat(audioPath).catch(() => null) : null;
  const audioSha256 = audioInfo?.isFile() ? await sha256File(audioPath) : "";
  const result = {
    index,
    pipeline: pipelineMode,
    text,
    status: job.status,
    jobId: job.id,
    outputId: output.id,
    outputPath: audioPath,
    outputFileName: output.outputFileName,
    durationSeconds: output.durationSeconds,
    audioBytes: audioInfo?.size || 0,
    audioSha256,
    qualityReport: quality || null,
    lineage: compactLineage(output, quality)
  };
  if (!retainAudio && audioPath) await fs.rm(audioPath, { force: true }).catch(() => {});
  return result;
}

function summarizeResults(results) {
  return {
    total: results.length,
    completed: results.filter((item) => item.status === "completed").length,
    failed: results.filter((item) => item.status !== "completed").length,
    generationPaths: Object.fromEntries(results.reduce((map, item) => {
      const key = item.lineage?.generationPath || item.error || "failed";
      map.set(key, (map.get(key) || 0) + 1);
      return map;
    }, new Map()))
  };
}

async function writeCheckpointReport(report) {
  report.updatedAt = new Date().toISOString();
  report.summary = summarizeResults(Object.values(report.results).flat());
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(
    path.join(outputRoot, `${mode}-report.json`),
    JSON.stringify(report, null, 2),
    "utf8"
  );
}

async function runPipeline({ baseUrl, profile, texts, pipelineMode, outputDir, report }) {
  await fs.mkdir(outputDir, { recursive: true });
  const results = [];
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    console.log(`[voice-golden] ${pipelineMode} ${index + 1}/${texts.length}`);
    const result = await runOne({ baseUrl, profile, text, pipelineMode, outputDir, index: index + 1 });
    results.push(result);
    report.results[pipelineMode] = results;
    await writeCheckpointReport(report);
    if (result.status !== "completed") console.error(JSON.stringify(result));
    if (result.status !== "completed") break;
  }
  return results;
}

async function main() {
  const sourceDb = await readJson(sourceDbPath);
  const profile = chooseProfile(sourceDb);
  const tempRoot = "";
  const dataRoot = path.resolve(suppliedDataRoot || defaultDataRoot);
  const settingsPath = path.resolve(suppliedSettingsPath || defaultSettingsPath);
  await fs.mkdir(dataRoot, { recursive: true });
  if (!suppliedDataRoot && path.resolve(sourceDbPath) !== path.resolve(path.join(dataRoot, "voice_clone.json"))) {
    await fs.copyFile(sourceDbPath, path.join(dataRoot, "voice_clone.json"));
  }
  if (!suppliedSettingsPath && !(await fs.stat(settingsPath).catch(() => null))) {
    await fs.writeFile(settingsPath, JSON.stringify({}), "utf8");
  }

  const envNames = [
    "MAGIC_BOX_SETTINGS_FILE", "MAGIC_BOX_VOICE_DATA_ROOT", "MAGIC_BOX_VOICE_ENGINE_ROOT",
    "MAGIC_BOX_VOICE_QUALITY_EVALUATOR_DIR", "MAGIC_BOX_ASSISTANT_DATA_DIR", "VOICE_STARTUP_WARMUP",
    "VOICE_CLONE_PIPELINE_V2_ENABLED", "VOICE_CLONE_REFERENCE_STRICT_ENABLED", "VOICE_CLONE_DATASET_SNAPSHOT_ENABLED",
    "VOICE_CLONE_PERSIST_ATTEMPTS_ENABLED", "VOICE_CLONE_DUAL_SPEAKER_GATE_ENABLED", "VOICE_CLONE_PERCEPTUAL_GATE_ENABLED",
    "VOICE_CLONE_SECONDARY_ASR_ENABLED", "VOICE_CLONE_PERSISTENT_WORKERS_ENABLED", "TORRENT_DOWNLOAD_DIR",
    "MAGIC_BOX_VOICE_ENGINE_FAKE"
  ];
  const savedEnv = cloneEnv(envNames);
  let app = null;
  const report = {
    schemaVersion: 1,
    mode,
    pipeline,
    profileId: profile.id,
    profileName: profile.name,
    sourceDbPath,
    evaluatedAt: new Date().toISOString(),
    outputRoot,
    rebuild: null,
    results: {}
  };
  try {
    const pipelines = pipeline === "both" ? ["baseline", "v2"] : [pipeline];
    configureEnvironment({
      dataRoot,
      settingsPath,
      outputDir: path.join(outputRoot, pipelines[0]),
      pipelineMode: pipelines[0]
    });
    const { startServer } = await import(pathToFileURL(path.join(rootDir, "server", "index.mjs")).href);
    app = await startServer({ port: 0, host: "127.0.0.1", defaultDownloadDir: outputRoot });
    if (rebuild) {
      console.log(`[voice-golden] rebuilding ${profile.name} in isolated data root`);
      report.rebuild = await rebuildProfile(app.url, profile);
    }
    for (const pipelineMode of pipelines) {
      const pipelineOutputDir = path.join(outputRoot, pipelineMode);
      const texts = mode === "soak"
        ? Array.from({ length: count }, (_, index) => soakTexts[index % soakTexts.length].replace("{n}", String(index + 1)))
        : (textArg ? [textArg] : goldenTexts.slice(0, Math.min(count, goldenTexts.length)));
      configureEnvironment({ dataRoot, settingsPath, outputDir: pipelineOutputDir, pipelineMode });
      report.results[pipelineMode] = await runPipeline({
        baseUrl: app.url,
        profile,
        texts,
        pipelineMode,
        outputDir: pipelineOutputDir,
        report
      });
    }
  } finally {
    await app?.close?.().catch(() => {});
    restoreEnv(savedEnv);
    if (tempRoot && !hasFlag("--keep-temp")) await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
  await fs.mkdir(outputRoot, { recursive: true });
  const allResults = Object.values(report.results).flat();
  report.summary = summarizeResults(allResults);
  report.completedAt = new Date().toISOString();
  const reportPath = path.join(outputRoot, `${mode}-report.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ reportPath, profileId: profile.id, summary: report.summary }, null, 2));
  if (report.summary.failed > 0) process.exitCode = 1;
}

await main();
