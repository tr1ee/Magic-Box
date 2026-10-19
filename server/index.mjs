import express from "express";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync, readFileSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import multer from "multer";
import WebTorrent from "webtorrent";
import { createFileTransferManager } from "./file_transfer.mjs";
import { createFormatFactoryManager } from "./format_factory.mjs";
import { createVideoAuthenticationRegistry, prepareVideoCookieArgs, validateVideoCookiesFile } from "./video-auth.mjs";
import { captureDouyinVideoData } from "./video-browser.mjs";
import { captureVerifiedVideoPage, hasVerificationProfile, verifiedPageState } from "./video-verification-browser.mjs";
import { probeVideoDimensions } from "./video-dimensions.mjs";
import { createAssistantManager } from "./assistant/manager.mjs";
import { createLocalModelRuntime } from "./assistant/models.mjs";
import { createWorkspaceIndex } from "./assistant/indexer.mjs";
import { createGroundedChat } from "./assistant/chat.mjs";
import { createAutomationEngine } from "./assistant/automation.mjs";
import { createToolIntegrations } from "./assistant/integrations.mjs";
import { registerVoiceCloneRoutes } from "./routes/voice-clone-routes.mjs";
import { chooseMacFolder, voiceInstallPlatformError } from "./macos-system.mjs";
import { voicePreparationSegments } from "./voice-preparation-segments.mjs";
import { createLiveVoiceService, conversationPromptId } from "./live_voice.mjs";
import {
  cosyVoiceStreamingEngineId,
  defaultVoiceEngineForLanguage,
  gptSoVitsEngineId,
  normalizeV2vEngine,
  normalizeVoiceEngine,
  normalizeVoiceLanguage,
  normalizeVtvSongEngineSelection,
  openVoiceEngineId,
  parseEmotionSegments,
  resolveVoiceLanguage,
  sanitizeUnicodeText,
  seedVcEngineId,
  vtvRvcEngineId,
  vtvSeedEngineId,
  vtvYingMusicEngineId,
  splitVoiceSynthesisClauses,
  textPreview,
  voicePreparationEngineId,
  whisperTurboStreamingEngineId,
  voiceEngineSupportsV2v,
  voiceStyles
} from "../shared/voiceClone.mjs";
import {
  computeDatasetSnapshotHash,
  createReferencePackManifest,
  normalizeVoiceQualityMode,
  resolveManagedArtifactPath,
  selectVoiceCandidate,
  validateFineDataset,
  validateReferencePackManifest,
  voiceCloneErrorCodes,
  voiceCloneFeatureFlags
} from "../shared/voiceClonePipeline.mjs";
import {
  createVoiceQualityReport,
  evaluateArtifactPolicy,
  evaluateContentPolicy,
  evaluateIdentityPolicy,
  evaluatePerceptualPolicy,
  identityReferenceCalibration,
  voiceQualityPolicyVersion
} from "../shared/voiceCloneQuality.mjs";
import { createVoiceGpuScheduler, VOICE_GPU_PRIORITIES } from "./voice-clone-gpu-scheduler.mjs";
import {
  VTV_PIPELINE_VERSION,
  VTV_SONG_SAMPLE_RATE,
  VTV_SPEECH_SAMPLE_RATE
} from "./voice/vtv/constants.mjs";
import { rankVtvSpeechCandidates } from "./voice/vtv/speech-ranker.mjs";
import {
  createVtvLineage,
  hashVtvLineage
} from "./voice/vtv/lineage.mjs";
import {
  deriveVtvJobSeed,
  normalizeVtvSettings,
  planVtvCandidates
} from "./voice/vtv/candidate-planner.mjs";
import {
  assertVtvCompletedInvariant,
  vtvTerminalStatusForJob
} from "./voice/vtv/state-machine.mjs";
import {
  createVtvReferencePackV2,
  validateVtvReferencePackV2
} from "./voice/vtv/reference-pack-v2.mjs";
import { evaluateDualF0Gate, evaluateStemGate } from "./voice/vtv/song-quality.mjs";
import { buildSongMixPlan, resolveSongPitchShift } from "./voice/vtv/song-mix.mjs";
import { separateSharedSongStems } from "./voice/vtv/song-separation.mjs";
import { currentVoiceJobWorkers, withVoiceJobWorkers } from "./voice/job-worker-scope.mjs";
import { aggregateClauseSecondaryAsr, selectBestTtsClauses, selectStrictTtsRecoveryClauses } from "./voice/tts-clause-selection.mjs";
import { convertTtsRecoveryClauses } from "./voice/tts-clause-recovery.mjs";
import { sweepVtvTempArtifacts } from "./voice/vtv/temp-cleanup.mjs";
import { createVtvEngineService } from "./voice/vtv/engine-service.mjs";
import { createGpuLeaseManager } from "./voice/vtv/gpu-lease-manager.mjs";
import { runMultiEngineSongVtvJob } from "./voice/vtv/multi-engine-orchestrator.mjs";
import { buildEngineSidecar, publicVtvEngineResult } from "./voice/vtv/comparison-report.mjs";
import { importRvcModelBundle } from "./voice/vtv/engines/rvc-v2/model-registry.mjs";
import {
  assessRvcTrainingReadiness,
  createRvcDatasetSnapshot,
  selectRvcProfileTrainingSources
} from "./voice/vtv/engines/rvc-v2/training.mjs";
import { runRvcTrainingPipeline } from "./voice/vtv/engines/rvc-v2/training-orchestrator.mjs";
import { stageRvcBrowserUploads } from "./voice/vtv/engines/rvc-v2/browser-import.mjs";
import { buildYingMusicReferenceArtifact, inspectYingMusicReferenceSource } from "./voice/vtv/engines/yingmusic-svc/reference-artifact.mjs";
import {
  listProfileTargetArtifacts,
  publicProfileTargetArtifact,
  resolveProfileTargetArtifact,
  selectYingMusicProfileReferenceSources
} from "./voice/vtv/target-artifact-resolver.mjs";
import {
  createProfileEngineSummary,
  createSeedProfileTargetState
} from "./voice/vtv/profile-engine-support.mjs";
import {
  readVoiceCloneSqlite,
  voiceCloneSqliteEnabled,
  voiceCloneSqlitePath,
  writeVoiceCloneSqlite
} from "./voice-clone-sqlite-store.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const Busboy = require("busboy");

const diagnosticHttpUrl = /https?:\/\/[^\s<>"'`]+/giu;
const diagnosticSensitiveValue = /(\b(?:authorization|proxy-authorization|cookie|set-cookie|token|access_token|id_token|signature|sig|upsig|key|x-amz-[a-z0-9-]+|x-goog-[a-z0-9-]+)\b\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s,;]+/giu;
const diagnosticBearerValue = /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/giu;

function diagnosticValue(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function redactLogText(value) {
  let changed = false;
  let redacted = diagnosticValue(value).replace(diagnosticHttpUrl, (raw) => {
    const suffix = (raw.match(/[),.;\]}]+$/u) || [""])[0];
    const candidate = suffix ? raw.slice(0, -suffix.length) : raw;
    try {
      const parsed = new URL(candidate);
      if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) return raw;
      changed = true;
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}[redacted]${suffix}`;
    } catch {
      const marker = candidate.search(/[?#]/u);
      if (marker < 0) return raw;
      changed = true;
      return `${candidate.slice(0, marker)}[redacted]${suffix}`;
    }
  });
  redacted = redacted.replace(diagnosticSensitiveValue, (_match, prefix) => {
    changed = true;
    return `${prefix}[redacted]`;
  });
  redacted = redacted.replace(diagnosticBearerValue, () => {
    changed = true;
    return "[redacted]";
  });
  return changed && !redacted.includes("[redacted]") ? `${redacted} [redacted]` : redacted;
}

function logDiagnostic(method, ...values) {
  console[method](values.map(redactLogText).join(" "));
}

function warnDiagnostic(...values) {
  logDiagnostic("warn", ...values);
}

function errorDiagnostic(...values) {
  logDiagnostic("error", ...values);
}

function infoDiagnostic(...values) {
  logDiagnostic("log", ...values);
}
const modulePath = fileURLToPath(import.meta.url);
const __dirname = path.dirname(modulePath);
const rootDir = path.resolve(__dirname, "..");
const fallbackDownloadDir = path.join(rootDir, "downloads");
const imageExtensions = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp"
]);
const videoExtensions = new Set([
  ".3gp",
  ".avi",
  ".flv",
  ".m4v",
  ".m4s",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".ogv",
  ".ts",
  ".webm",
  ".wmv"
]);
const voiceAudioExtensions = new Set([".wav", ".mp3", ".m4a", ".flac", ".ogg"]);
const hlsPlaylistExtensions = new Set([".m3u", ".m3u8"]);
const maxScannedImages = 1000;
const maxScannedVideos = 250;
const maxSingleImageBytes = 50 * 1024 * 1024;
const maxSingleVideoBytes = 4 * 1024 * 1024 * 1024;
const maxCachedImageBytes = 20 * 1024 * 1024;
const maxImageBufferCacheEntries = 40;
const imageBufferCacheTtlMs = 5 * 60 * 1000;
const maxPageBytes = 8 * 1024 * 1024;
const maxHlsPlaylistBytes = 2 * 1024 * 1024;
const maxHlsSegments = 5000;
const maxExpandedPlayerPages = 8;
const maxVideoCandidateValidationCount = 30;
const tenMinuteVideoScanMs = 10 * 60 * 1000;
const renderedPageTimeoutMs = tenMinuteVideoScanMs;
const renderedPageVirtualTimeBudgetMs = 60 * 1000;
const videoPageRequestTimeoutMs = 30 * 1000;
const videoScanTimeoutMs = tenMinuteVideoScanMs + 30 * 1000;
const ytDlpScanTimeoutMs = 90 * 1000;
const ytDlpProbeTimeoutMs = 8 * 1000;
const maxVideoDownloadJobs = 30;
const videoDownloadJobTtlMs = 60 * 60 * 1000;
const maxImageDownloadJobs = 30;
const imageDownloadJobTtlMs = 60 * 60 * 1000;
const maxVoiceSampleBytes = 100 * 1024 * 1024;
const maxVoiceTrainingSourceBytes = 512 * 1024 * 1024;
const maxVoiceTrainingRequestBytes = 1024 * 1024 * 1024;
const maxVoiceSourcesPerProfile = 20;
const maxVoiceJobs = 60;
const voiceJobTtlMs = 60 * 60 * 1000;
const maxVoiceTextLength = 5000;
const maxVoiceSourceDurationSeconds = 5 * 60;
const maxVoiceSongSourceDurationSeconds = 8 * 60;
const voiceNeuralEngineId = openVoiceEngineId;
const voiceNeuralModelVersion = "openvoice-v2-0417";
const gptSoVitsModelVersion = "gpt-sovits-managed-v1";
const seedVcModelVersion = "seed-vc-svc-v1";
const voicePreparationModelVersion = "voice-preparation-v1";
const cosyVoiceStreamingModelVersion = "fun-cosyvoice3-0.5b-2512-29e01c4";
const whisperTurboStreamingModelVersion = "whisper-large-v3-turbo-0a363e9";
const voiceEngineRequestTimeoutMs = 10 * 60 * 1000;
const voicePreparationMinimumTimeoutMs = 30 * 60 * 1000;
const voicePreparationMaximumTimeoutMs = 3 * 60 * 60 * 1000;
const voicePreparationProgressIdleTimeoutMs = 20 * 60 * 1000;
const voiceEngineFineTuneTimeoutMs = 6 * 60 * 60 * 1000;
const seedVcRequestTimeoutMs = 6 * 60 * 60 * 1000;
let seedVcExecutionTail = Promise.resolve();
let seedVcRefinementTail = Promise.resolve();

function classifyVoiceRefinementFailure(error) {
  const rawMessage = sanitizeUnicodeText(error?.message || "Seed-VC speaker refinement failed.");
  const message = rawMessage.length <= 1600
    ? rawMessage
    : `${rawMessage.slice(0, 700)}\n... diagnostic middle omitted ...\n${rawMessage.slice(-850)}`;
  const lower = rawMessage.toLowerCase();
  const code = error?.code === "VOICE_GPU_RESOURCE_BUSY"
    ? "gpu_resource_busy"
    : error?.code === "VOICE_ENGINE_TIMEOUT" || /timed out|timeout/.test(lower)
    ? "conversion_timeout"
    : /out of memory|cuda.*memory|cublas_status_alloc_failed/.test(lower)
      ? "cuda_out_of_memory"
      : /timing|duration|out of sync|onset/.test(lower)
        ? "timing_mismatch"
        : /identity|target speaker|target voice|target_identity/.test(lower)
          ? "identity_validation_failed"
        : /waveform|amplitude|hum|activity|electronic|roughness/.test(lower)
            ? "waveform_validation_failed"
          : /coverage|requested text|transcript/.test(lower)
            ? "coverage_validation_failed"
            : /cancel/.test(lower)
              ? "cancelled"
              : "refinement_stage_failed";
  return { code, message };
}

function voiceRefinementStageError(error, stage, details = {}) {
  if (error?.voiceRefinementDiagnostic) return error;
  const failure = classifyVoiceRefinementFailure(error);
  const wrapped = error instanceof Error ? error : new Error(failure.message);
  wrapped.voiceRefinementDiagnostic = sanitizeStructuredText({
    stage: sanitizeUnicodeText(stage || "unknown").slice(0, 80),
    code: failure.code,
    message: failure.message,
    ...details
  });
  return wrapped;
}

async function callSeedVcWorkerSerialized(request, options = {}) {
  const previous = seedVcExecutionTail.catch(() => {});
  let releaseSlot;
  seedVcExecutionTail = new Promise((resolve) => { releaseSlot = resolve; });
  await previous;
  try {
    if (options.signal?.aborted) throw voiceJobCancelledError();
    await currentVoiceJobWorkers()?.close(gptSoVitsEngineId);
    const flags = voiceCloneFeatureFlags(process.env);
    const callWorker = !currentVoiceJobWorkers() && (flags.persistentWorkers || flags.vtvPersistentWorker)
      ? callLiveVoiceEngineWorker
      : callVoiceEngineWorker;
    return await callWorker(request, { ...options, engine: options.engine || seedVcEngineId });
  } finally {
    releaseSlot();
  }
}

async function acquireSeedVcRefinementSlot(signal = null) {
  const previous = seedVcRefinementTail.catch(() => {});
  let releaseSlot;
  let released = false;
  seedVcRefinementTail = new Promise((resolve) => { releaseSlot = resolve; });
  await previous;
  if (signal?.aborted) {
    releaseSlot();
    throw voiceJobCancelledError();
  }
  return () => {
    if (released) return;
    released = true;
    releaseSlot();
  };
}
const historyLimit = 100;
const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
const imageRequestHeaders = {
  "User-Agent": browserUserAgent,
  Accept: "text/html,application/xhtml+xml,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};
const videoRequestHeaders = {
  "User-Agent": browserUserAgent,
  Accept: "text/html,application/xhtml+xml,video/mp4,video/webm,video/ogg,video/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};
const videoPassthroughHeaderNames = new Set([
  "accept",
  "accept-language",
  "origin",
  "referer",
  "user-agent"
]);
const browserNavigationHeaders = {
  "User-Agent": browserUserAgent,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,video/mp4,video/webm,video/ogg,video/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1"
};
const retryableImageStatusCodes = new Set([408, 429, 500, 502, 503, 504]);
const refreshableImageStatusCodes = new Set([401, 403]);

function voicePreparationTimeoutForSource(sourceDurationSeconds, device = "cpu") {
  const durationSeconds = Math.max(0, Number(sourceDurationSeconds) || 0);
  // CPU Demucs can take roughly ten times source duration by itself. Reserve
  // a second, explicit budget for CPU ASR and clip export so a healthy source
  // is not killed immediately after separation. CUDA stays bounded too, but
  // needs far less source-duration allowance.
  const isCuda = String(device || "").toLowerCase() === "cuda";
  const baseMs = isCuda ? 15 * 60 * 1000 : 20 * 60 * 1000;
  const sourceBudgetMs = Math.round(durationSeconds * (isCuda ? 4 : 20) * 1000);
  const estimatedMs = baseMs + sourceBudgetMs;
  return Math.min(
    voicePreparationMaximumTimeoutMs,
    Math.max(voicePreparationMinimumTimeoutMs, estimatedMs)
  );
}

function voicePreparationWorkerTimeoutOptions(sourceDurationSeconds, device = "cpu") {
  return {
    timeoutMs: voicePreparationTimeoutForSource(sourceDurationSeconds, device),
    idleTimeoutMs: voicePreparationProgressIdleTimeoutMs
  };
}

function voicePreparationFailureWarning(error) {
  if (error?.code === "VOICE_ENGINE_IDLE_TIMEOUT") {
    return "Voice Preparation stopped sending local progress updates. The original source is safe; repair setup or reprocess it.";
  }
  if (error?.code === "VOICE_ENGINE_TIMEOUT") {
    return "Voice Preparation reached its source-specific safety limit. The original source is safe; use CUDA when available, then reprocess it.";
  }
  if (error?.code === "VOICE_JOB_CANCELLED") {
    return "Voice Preparation was cancelled. The original source is safe; reprocess it when ready.";
  }
  const detail = sanitizeUnicodeText(error?.message || "").replace(/\s+/g, " ").trim().slice(0, 360);
  return detail
    ? `Voice Preparation did not complete: ${detail} The original source is safe; repair setup or reprocess it.`
    : "Voice Preparation did not complete. The original source is safe; repair setup or reprocess it.";
}
const retryableImageErrorCodes = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN"]);
const nonRetryableImageErrorCodes = new Set(["INVALID_URL", "IMAGE_TOO_LARGE", "NON_IMAGE_RESPONSE"]);
const imageHostDelayMs = 450;
const retiredVoiceEngines = new Set(["magic-local", "system-tts", "mock"]);
const voiceModelInstallManifest = {
  engine: voiceNeuralEngineId,
  modelVersion: voiceNeuralModelVersion,
  runtimePython: "3.10-3.11",
  source: "OpenVoice V2",
  license: "MIT",
  artifacts: [
    { id: "converter-config", url: "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/converter/config.json", fileName: "converter/config.json", targetPath: "checkpoints_v2/converter/config.json", sha256: "", required: true },
    { id: "converter-checkpoint", url: "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/converter/checkpoint.pth", fileName: "converter/checkpoint.pth", targetPath: "checkpoints_v2/converter/checkpoint.pth", sha256: "", required: true },
    { id: "base-speaker-en-newest", url: "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/base_speakers/ses/en-newest.pth", fileName: "base_speakers/ses/en-newest.pth", targetPath: "checkpoints_v2/base_speakers/ses/en-newest.pth", sha256: "", required: true },
    { id: "base-speaker-en-us", url: "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/base_speakers/ses/en-us.pth", fileName: "base_speakers/ses/en-us.pth", targetPath: "checkpoints_v2/base_speakers/ses/en-us.pth", sha256: "", required: false },
    { id: "base-speaker-zh", url: "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/base_speakers/ses/zh.pth", fileName: "base_speakers/ses/zh.pth", targetPath: "checkpoints_v2/base_speakers/ses/zh.pth", sha256: "", required: true },
    { id: "base-speaker-jp", url: "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/base_speakers/ses/jp.pth", fileName: "base_speakers/ses/jp.pth", targetPath: "checkpoints_v2/base_speakers/ses/jp.pth", sha256: "", required: true },
    { id: "bert-multilingual-config", url: "https://huggingface.co/bert-base-multilingual-uncased/resolve/main/config.json", fileName: "config.json", targetPath: "bert/bert-base-multilingual-uncased/config.json", sha256: "", required: true },
    { id: "bert-multilingual-weights", url: "https://huggingface.co/bert-base-multilingual-uncased/resolve/main/pytorch_model.bin", fileName: "pytorch_model.bin", targetPath: "bert/bert-base-multilingual-uncased/pytorch_model.bin", sha256: "", required: true },
    { id: "bert-multilingual-vocab", url: "https://huggingface.co/bert-base-multilingual-uncased/resolve/main/vocab.txt", fileName: "vocab.txt", targetPath: "bert/bert-base-multilingual-uncased/vocab.txt", sha256: "", required: true },
    { id: "bert-multilingual-tokenizer", url: "https://huggingface.co/bert-base-multilingual-uncased/resolve/main/tokenizer.json", fileName: "tokenizer.json", targetPath: "bert/bert-base-multilingual-uncased/tokenizer.json", sha256: "", required: false },
    { id: "bert-multilingual-tokenizer-config", url: "https://huggingface.co/bert-base-multilingual-uncased/resolve/main/tokenizer_config.json", fileName: "tokenizer_config.json", targetPath: "bert/bert-base-multilingual-uncased/tokenizer_config.json", sha256: "", required: false },
    { id: "bert-japanese-config", url: "https://huggingface.co/tohoku-nlp/bert-base-japanese-v3/resolve/main/config.json", fileName: "config.json", targetPath: "bert/tohoku-nlp--bert-base-japanese-v3/config.json", sha256: "", required: true },
    { id: "bert-japanese-weights", url: "https://huggingface.co/tohoku-nlp/bert-base-japanese-v3/resolve/main/pytorch_model.bin", fileName: "pytorch_model.bin", targetPath: "bert/tohoku-nlp--bert-base-japanese-v3/pytorch_model.bin", sha256: "", required: true },
    { id: "bert-japanese-vocab", url: "https://huggingface.co/tohoku-nlp/bert-base-japanese-v3/resolve/main/vocab.txt", fileName: "vocab.txt", targetPath: "bert/tohoku-nlp--bert-base-japanese-v3/vocab.txt", sha256: "", required: true },
    { id: "bert-japanese-tokenizer-config", url: "https://huggingface.co/tohoku-nlp/bert-base-japanese-v3/resolve/main/tokenizer_config.json", fileName: "tokenizer_config.json", targetPath: "bert/tohoku-nlp--bert-base-japanese-v3/tokenizer_config.json", sha256: "", required: false },
    { id: "bert-japanese-special-tokens", url: "https://huggingface.co/tohoku-nlp/bert-base-japanese-v3/resolve/main/special_tokens_map.json", fileName: "special_tokens_map.json", targetPath: "bert/tohoku-nlp--bert-base-japanese-v3/special_tokens_map.json", sha256: "", required: false }
  ]
};
const gptSoVitsInstallManifest = {
  engine: gptSoVitsEngineId,
  modelVersion: gptSoVitsModelVersion,
  runtimePython: "3.10-3.11",
  source: "RVC-Boss/GPT-SoVITS",
  license: "MIT",
  repository: "https://github.com/RVC-Boss/GPT-SoVITS",
  artifacts: []
};
const seedVcInstallManifest = {
  engine: seedVcEngineId,
  modelVersion: seedVcModelVersion,
  runtimePython: "3.10",
  source: "Plachtaa/seed-vc + Demucs",
  license: "GPL-3.0",
  separationLicense: "MIT",
  repository: "https://github.com/Plachtaa/seed-vc",
  separationRepository: "https://github.com/facebookresearch/demucs",
  alternateSeparators: [{
    id: "bs-roformer-viperx-ep317-sdr12.9755",
    manifestPath: "server/voice/model-manifests/bs-roformer-viperx-ep317.json",
    modelSha256: "5b84f37e8d444c8cb30c79d77f613a41c05868ff9c9ac6c7049c00aefae115aa",
    license: "MIT"
  }],
  artifacts: []
};
const voicePreparationInstallManifest = {
  engine: voicePreparationEngineId,
  modelVersion: voicePreparationModelVersion,
  runtimePython: "3.10-3.11",
  source: "Demucs + faster-whisper",
  license: "MIT",
  separationLicense: "MIT",
  repository: "https://github.com/facebookresearch/demucs",
  asrRepository: "https://github.com/SYSTRAN/faster-whisper",
  artifacts: []
};
const cosyVoiceStreamingInstallManifest = {
  engine: cosyVoiceStreamingEngineId,
  modelVersion: cosyVoiceStreamingModelVersion,
  runtimePython: "3.10.11",
  source: "QwenAudio/CosyVoice + FunAudioLLM/Fun-CosyVoice3-0.5B-2512",
  repository: "https://github.com/QwenAudio/CosyVoice",
  repositoryRevision: "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc",
  modelRevision: "29e01c4e8d000f4bcd70751be16fa94bf3d85a18",
  license: "Apache-2.0",
  artifacts: []
};
const whisperTurboStreamingInstallManifest = {
  engine: whisperTurboStreamingEngineId,
  modelVersion: whisperTurboStreamingModelVersion,
  runtimePython: "3.10.11",
  source: "SYSTRAN/faster-whisper + mobiuslabsgmbh/faster-whisper-large-v3-turbo",
  repository: "https://github.com/SYSTRAN/faster-whisper",
  modelRevision: "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
  fallbackRevision: "536b0662742c02347bc0e980a01041f333bce120",
  license: "MIT",
  artifacts: []
};
const voicePreparationLocks = new Map();
const voiceProfileMutationLocks = new Map();
let voiceDbWriteQueue = Promise.resolve();
let voiceJobPersistenceQueue = Promise.resolve();
let sharpModulePromise = null;
const imageBufferCache = new Map();
const imageHostQueues = new Map();
const imageHostLastFinishedAt = new Map();

function bytes(value) {
  return Number.isFinite(value) ? value : 0;
}

function normalizeDownloadDir(downloadPath, defaultDownloadDir) {
  if (!downloadPath || typeof downloadPath !== "string") {
    return defaultDownloadDir;
  }

  return path.resolve(downloadPath.trim());
}

const downloadToolIds = ["torrents", "images", "videos", "voice-clone", "file-transfer", "format-factory"];

function normalizeToolPaths(toolPaths, fallbackPath) {
  return downloadToolIds.reduce((paths, toolId) => {
    const candidate = toolPaths?.[toolId];
    paths[toolId] = normalizeDownloadDir(candidate, fallbackPath);
    return paths;
  }, {});
}

async function ensureDownloadDir(downloadPath) {
  await fs.mkdir(downloadPath, { recursive: true });
  return downloadPath;
}

async function chooseDownloadFolder(currentPath) {
  if (process.platform === "darwin") return chooseMacFolder(currentPath);
  if (process.platform !== "win32") {
    throw new Error("Folder browsing is only available in the Windows desktop shell.");
  }

  const folderPickerPath = path.join(rootDir, "FolderPicker.exe");
  if (await fileExists(folderPickerPath)) {
    try {
      const { stdout } = await execFileAsync(
        folderPickerPath,
        currentPath && typeof currentPath === "string" ? [currentPath] : [],
        {
          encoding: "utf8",
          windowsHide: true
        }
      );
      return stdout.trim();
    } catch (error) {
      warnDiagnostic(`FolderPicker.exe failed; falling back to PowerShell folder dialog. ${error.message}`);
    }
  }

  const script = `
Add-Type -AssemblyName System.Windows.Forms
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
}
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Choose save folder"
$dialog.ShowNewFolderButton = $true
if ($env:MAGIC_BOX_CURRENT_PATH -and (Test-Path -LiteralPath $env:MAGIC_BOX_CURRENT_PATH)) {
  $dialog.SelectedPath = $env:MAGIC_BOX_CURRENT_PATH
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      env: {
        ...process.env,
        MAGIC_BOX_CURRENT_PATH: currentPath && typeof currentPath === "string" ? currentPath : ""
      }
    }
  );

  return stdout.trim();
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function settingsFilePath() {
  if (process.env.MAGIC_BOX_SETTINGS_FILE) {
    return path.resolve(process.env.MAGIC_BOX_SETTINGS_FILE);
  }

  const baseDir = process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "MagicBox")
    : path.join(os.homedir(), ".magic-box");
  return path.join(baseDir, "settings.json");
}

function imageFailureManifestDir() {
  return path.join(path.dirname(settingsFilePath()), "image-failure-manifests");
}

function imageFailureManifestPath(id) {
  const safeId = String(id || "").replace(/[^a-z0-9_-]/gi, "");
  if (!safeId) {
    throw new Error("Invalid image history id.");
  }
  return path.join(imageFailureManifestDir(), `${safeId}.json`);
}

async function writeImageFailureManifest(id, failures) {
  const directory = imageFailureManifestDir();
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(imageFailureManifestPath(id), JSON.stringify(Array.isArray(failures) ? failures : []), "utf8");
}

async function readImageFailureManifest(id) {
  return JSON.parse(await fs.readFile(imageFailureManifestPath(id), "utf8"));
}

async function deleteImageFailureManifest(id) {
  if (!id) {
    return;
  }
  await fs.rm(imageFailureManifestPath(id), { force: true }).catch(() => {});
}

async function cleanupEvictedImageFailureManifests(previousHistory, nextHistory) {
  const retainedIds = new Set((Array.isArray(nextHistory) ? nextHistory : []).map((item) => item?.id).filter(Boolean));
  const evictedIds = (Array.isArray(previousHistory) ? previousHistory : [])
    .filter((item) => item?.type === "image" && item?.failureManifestId && !retainedIds.has(item.id))
    .map((item) => item.failureManifestId);
  await Promise.all(evictedIds.map(deleteImageFailureManifest));
}

async function readSettings() {
  try {
    return JSON.parse(await fs.readFile(settingsFilePath(), "utf8"));
  } catch {
    return {};
  }
}

async function writeSettings(settings) {
  const filePath = settingsFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2), "utf8");
  return settings;
}

function compactHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter(Boolean)
    .slice(0, historyLimit);
}

function makeHistoryId(prefix = "job") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

async function readHistory() {
  const settings = await readSettings();
  return compactHistory(settings.history);
}

async function writeHistory(history) {
  const current = await readSettings();
  const nextHistory = compactHistory(history);
  await writeSettings({
    ...current,
    history: nextHistory
  });
  await cleanupEvictedImageFailureManifests(current.history, nextHistory);
  return nextHistory;
}

async function appendHistoryEntry(entry) {
  const current = await readSettings();
  const history = compactHistory([
    {
      id: entry.id || makeHistoryId(entry.type || "job"),
      timestamp: entry.timestamp || new Date().toISOString(),
      ...entry
    },
    ...(Array.isArray(current.history) ? current.history : [])
  ]);
  await writeSettings({
    ...current,
    history
  });
  await cleanupEvictedImageFailureManifests(current.history, history);
  return history[0];
}

async function upsertHistoryEntry(match, entry) {
  const current = await readSettings();
  const existingHistory = Array.isArray(current.history) ? current.history : [];
  let replaced = false;
  const nextEntry = {
    id: entry.id || makeHistoryId(entry.type || "job"),
    timestamp: entry.timestamp || new Date().toISOString(),
    ...entry
  };
  const history = existingHistory.map((item) => {
    if (!replaced && match(item)) {
      replaced = true;
      return {
        ...item,
        ...nextEntry,
        id: item.id || nextEntry.id,
        timestamp: item.timestamp || nextEntry.timestamp,
        updatedAt: new Date().toISOString()
      };
    }
    return item;
  });

  if (!replaced) {
    history.unshift(nextEntry);
  }

  const compacted = compactHistory(history);
  await writeSettings({
    ...current,
    history: compacted
  });
  await cleanupEvictedImageFailureManifests(current.history, compacted);
  return compacted.find((item) => item.id === nextEntry.id) || compacted[0] || null;
}

async function clearHistory() {
  return writeHistory([]);
}

function resolveLocalOpenTarget(resolvedPath, { openFolder = false, isFile = false } = {}) {
  return openFolder && isFile ? path.dirname(resolvedPath) : resolvedPath;
}

async function openLocalPath(targetPath, { openFolder = false } = {}) {
  if (!targetPath || typeof targetPath !== "string") {
    throw new Error("Enter a folder or file path to open.");
  }

  const resolved = path.resolve(targetPath);
  const stats = await fs.stat(resolved);
  const openTarget = resolveLocalOpenTarget(resolved, {
    openFolder,
    isFile: stats.isFile()
  });

  if (process.platform === "win32") {
    if (openFolder) {
      await new Promise((resolve, reject) => {
        const child = spawn("explorer.exe", [openTarget], {
          detached: true,
          stdio: "ignore",
          windowsHide: false
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
      return openTarget;
    }

    await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "Start-Process -LiteralPath $env:MAGIC_BOX_OPEN_TARGET"
      ], {
        detached: true,
        env: { ...process.env, MAGIC_BOX_OPEN_TARGET: openTarget },
        stdio: "ignore",
        windowsHide: true
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
    return openTarget;
  }

  if (process.platform === "darwin") {
    await execFileAsync("open", [openTarget]);
    return openTarget;
  }

  await execFileAsync("xdg-open", [openTarget]);
  return openTarget;
}

function parseHttpUrl(value, label = "URL") {
  if (!value || typeof value !== "string") {
    const error = new Error(`Enter a valid ${label}.`);
    error.code = "INVALID_URL";
    throw error;
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    const error = new Error(`Enter a valid ${label}.`);
    error.code = "INVALID_URL";
    throw error;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    const error = new Error(`${label} must start with http:// or https://.`);
    error.code = "INVALID_URL";
    throw error;
  }

  parsed.hash = "";
  return parsed;
}

function parseSharedPageUrl(value, label = "URL") {
  if (typeof value === "string") {
    const trimmed = value.trim();
    try {
      return parseHttpUrl(trimmed, label);
    } catch {
      const candidates = trimmed.match(/https?:\/\/[^\s<>"']+/gi) || [];
      for (const candidate of candidates) {
        const cleaned = candidate.replace(/[\])}>，。；;！？!?、]+$/u, "");
        try {
          return parseHttpUrl(cleaned, label);
        } catch {
          // Try the next URL embedded in copied share text.
        }
      }
    }
  }
  return parseHttpUrl(value, label);
}

function bilibiliBvidFromInput(value) {
  const match = /(?:^|[^0-9A-Za-z])(BV[0-9A-Za-z]{10,})(?=$|[^0-9A-Za-z])/i.exec(String(value || "").trim());
  if (!match) {
    return "";
  }
  return `BV${match[1].slice(2)}`;
}

function parseVideoPageInput(value, label = "page URL") {
  const bvid = bilibiliBvidFromInput(value);
  if (bvid) {
    const canonical = new URL(`https://www.bilibili.com/video/${bvid}/`);
    try {
      const original = parseSharedPageUrl(value, label);
      const part = original.searchParams.get("p");
      if (isBilibiliUrl(original.href) && /^[1-9]\d*$/.test(part || "")) canonical.searchParams.set("p", part);
    } catch { /* A bare BV ID has no URL parameters. */ }
    return canonical;
  }
  return parseSharedPageUrl(value, label);
}

function normalizeVideoHttpHeaders(headers) {
  if (!headers || typeof headers !== "object") {
    return null;
  }

  const normalized = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const lowerName = String(rawName || "").trim().toLowerCase();
    if (!videoPassthroughHeaderNames.has(lowerName)) {
      continue;
    }
    const value = String(rawValue || "").trim();
    if (!value || /[\r\n]/.test(value)) {
      continue;
    }
    const canonicalName = lowerName
      .split("-")
      .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
      .join("-");
    normalized[canonicalName] = value.slice(0, 1000);
  }

  return Object.keys(normalized).length ? normalized : null;
}

function normalizeVideoUrlList(values, baseUrl = null, limit = 8) {
  if (!Array.isArray(values)) {
    return [];
  }

  const urls = [];
  const seen = new Set();
  for (const value of values) {
    const resolved = baseUrl
      ? resolveImageUrl(value, baseUrl)
      : normalizeOptionalUrl(value, value, "video URL");
    if (!resolved || seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    urls.push(resolved);
    if (urls.length >= limit) {
      break;
    }
  }
  return urls;
}

function parseVideoHttpHeaders(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    return normalizeVideoHttpHeaders(JSON.parse(value));
  } catch {
    return null;
  }
}

function imageHostKey(urlInput) {
  try {
    return new URL(urlInput).origin;
  } catch {
    return "unknown";
  }
}

async function withImageHostPacing(urlInput, callback) {
  const hostKey = imageHostKey(urlInput);
  const previous = imageHostQueues.get(hostKey) || Promise.resolve();
  const queued = previous.catch(() => {}).then(async () => {
    const lastFinishedAt = imageHostLastFinishedAt.get(hostKey) || 0;
    const waitMs = Math.max(0, imageHostDelayMs - (Date.now() - lastFinishedAt));
    if (waitMs) {
      await sleep(waitMs);
    }

    try {
      return await callback();
    } finally {
      imageHostLastFinishedAt.set(hostKey, Date.now());
    }
  });
  const cleanup = queued.catch(() => {}).then(() => {
    if (imageHostQueues.get(hostKey) === cleanup) {
      imageHostQueues.delete(hostKey);
    }
  });
  imageHostQueues.set(hostKey, cleanup);
  return queued;
}

function imageErrorCode(error) {
  if (Number.isFinite(error?.statusCode)) {
    return `HTTP_${error.statusCode}`;
  }

  if (error?.code) {
    return String(error.code);
  }

  const message = String(error?.message || "").toLowerCase();
  if (message.includes("socket hang up") || message.includes("connection reset")) {
    return "ECONNRESET";
  }
  if (message.includes("timed out") || message.includes("timeout")) {
    return "ETIMEDOUT";
  }

  return "IMAGE_REQUEST_FAILED";
}

function isRetryableImageError(error) {
  if (Number.isFinite(error?.statusCode)) {
    return retryableImageStatusCodes.has(Number(error.statusCode));
  }

  const code = imageErrorCode(error);
  if (nonRetryableImageErrorCodes.has(code)) {
    return false;
  }

  const httpMatch = /^HTTP_(\d+)$/.exec(code);
  if (httpMatch) {
    return retryableImageStatusCodes.has(Number(httpMatch[1]));
  }

  return retryableImageErrorCodes.has(code);
}

function friendlyImageErrorMessage(error, autoRetried = false) {
  const code = imageErrorCode(error);
  let message;

  if (code === "ECONNRESET") {
    message = "Connection reset by server.";
  } else if (code === "ETIMEDOUT" || code === "ECONNABORTED") {
    message = "Image request timed out.";
  } else if (code === "EAI_AGAIN") {
    message = "Temporary DNS lookup failed.";
  } else if (code === "HTTP_408") {
    message = "Server timed out the request.";
  } else if (code === "HTTP_429") {
    message = "Server rate-limited the request.";
  } else if (code === "HTTP_500" || code === "HTTP_502" || code === "HTTP_503" || code === "HTTP_504") {
    message = "Image server was temporarily unavailable.";
  } else if (code === "HTTP_401") {
    message = "Image URL authorization expired.";
  } else if (code === "HTTP_403") {
    message = error?.accessBlocked
      ? "Image server or Cloudflare refused access."
      : "Image server refused access.";
  } else if (code === "HTTP_404") {
    message = "Image was not found.";
  } else if (code === "IMAGE_TOO_LARGE") {
    message = "Image is larger than 50 MB.";
  } else if (code === "NON_IMAGE_RESPONSE") {
    message = "URL did not return an image.";
  } else if (code === "INVALID_URL") {
    message = "Image URL was invalid.";
  } else {
    message = error?.message || "Image request failed.";
  }

  if (error?.refreshAttempted && !error?.refreshSucceeded && (code === "HTTP_401" || code === "HTTP_403")) {
    message = `${message.replace(/\.$/, "")} Reader-page refresh did not provide a different usable URL.`;
  }

  if (autoRetried) {
    return `${message.replace(/\.$/, "")}, retried automatically.`;
  }

  return message;
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function parseAttributes(tag) {
  const attributes = new Map();
  const attrRegex = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;

  while ((match = attrRegex.exec(tag)) !== null) {
    attributes.set(match[1].toLowerCase(), decodeHtmlAttribute(match[2] || match[3] || match[4] || ""));
  }

  return attributes;
}

function parseSrcset(srcset) {
  return srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function sortByPageNumber(left, right) {
  return (left.pageNumber || 0) - (right.pageNumber || 0);
}

function ehentaiPageNumber(value) {
  try {
    const parsed = new URL(value);
    const match = /\/s\/[^/]+\/\d+-(\d+)/i.exec(parsed.pathname);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function isEhentaiHost(hostname) {
  return /(^|\.)e-hentai\.org$/i.test(hostname) || /(^|\.)exhentai\.org$/i.test(hostname);
}

function isEhentaiGalleryUrl(pageUrl) {
  try {
    const parsed = new URL(pageUrl);
    return isEhentaiHost(parsed.hostname) && /^\/g\/\d+\/[^/]+\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isEhentaiReaderUrl(pageUrl) {
  try {
    const parsed = new URL(pageUrl);
    return isEhentaiHost(parsed.hostname) && /^\/s\/[^/]+\/\d+-\d+\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function resolveImageUrl(rawValue, pageUrl) {
  if (!rawValue || typeof rawValue !== "string") {
    return null;
  }

  const value = rawValue.trim();
  if (
    !value ||
    value.startsWith("#") ||
    value.startsWith("data:") ||
    value.startsWith("blob:") ||
    value.startsWith("javascript:")
  ) {
    return null;
  }

  try {
    const resolved = new URL(value, pageUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }
    resolved.hash = "";
    return resolved.href;
  } catch {
    return null;
  }
}

function looksLikeImageUrl(value) {
  try {
    return imageExtensions.has(path.extname(new URL(value).pathname).toLowerCase());
  } catch {
    return false;
  }
}

function looksLikeVideoUrl(value) {
  try {
    return videoExtensions.has(path.extname(new URL(value).pathname).toLowerCase());
  } catch {
    return false;
  }
}

function looksLikeHlsPlaylistUrl(value) {
  try {
    return hlsPlaylistExtensions.has(path.extname(new URL(value).pathname).toLowerCase());
  } catch {
    return false;
  }
}

function looksLikeVideoSourceUrl(value) {
  return looksLikeVideoUrl(value) || looksLikeHlsPlaylistUrl(value);
}

function isHlsContentType(contentType) {
  const normalized = normalizedContentType(contentType);
  return normalized === "application/vnd.apple.mpegurl" ||
    normalized === "application/x-mpegurl" ||
    normalized === "audio/mpegurl" ||
    normalized === "audio/x-mpegurl";
}

function videoExtensionFromContentType(contentType) {
  const normalized = normalizedContentType(contentType);
  if (normalized === "video/mp4") {
    return ".mp4";
  }
  if (normalized === "video/webm") {
    return ".webm";
  }
  if (normalized === "video/ogg") {
    return ".ogv";
  }
  if (normalized === "video/quicktime") {
    return ".mov";
  }
  if (normalized === "video/x-m4v") {
    return ".m4v";
  }
  if (normalized === "video/x-matroska") {
    return ".mkv";
  }
  if (normalized === "video/x-msvideo") {
    return ".avi";
  }
  if (normalized === "video/x-ms-wmv") {
    return ".wmv";
  }
  if (normalized === "video/mpeg") {
    return ".mpeg";
  }
  if (normalized === "video/mp2t") {
    return ".ts";
  }
  if (isHlsContentType(contentType)) {
    return ".ts";
  }
  return "";
}

function videoContentTypeFromExtension(extensionInput) {
  const extension = String(extensionInput || "").toLowerCase().replace(/^\./, "");
  if (extension === "mp4" || extension === "m4v" || extension === "m4s") {
    return "video/mp4";
  }
  if (extension === "webm") {
    return "video/webm";
  }
  if (extension === "ogv" || extension === "ogg") {
    return "video/ogg";
  }
  if (extension === "mov") {
    return "video/quicktime";
  }
  if (extension === "mkv") {
    return "video/x-matroska";
  }
  if (extension === "avi") {
    return "video/x-msvideo";
  }
  if (extension === "wmv") {
    return "video/x-ms-wmv";
  }
  if (extension === "mpeg" || extension === "mpg") {
    return "video/mpeg";
  }
  if (extension === "ts") {
    return "video/mp2t";
  }
  if (extension === "flv") {
    return "video/x-flv";
  }
  return "";
}

function normalizeQualityHeight(value) {
  const height = Number(value);
  return Number.isFinite(height) && height >= 100 && height <= 4320
    ? Math.round(height)
    : null;
}

function qualityFromText(value) {
  const text = String(value || "").toLowerCase();
  if (!text) {
    return null;
  }

  const heightMatch = /(?:^|[^\d])([1-9]\d{2,3})\s*p(?:\b|[^\d])/i.exec(text) ||
    /\b(?:quality|res|resolution|height|size|label)\b[^\d]{0,12}([1-9]\d{2,3})(?:\b|[^\d])/i.exec(text) ||
    /[?&](?:q|quality|res|height)=([1-9]\d{2,3})(?:\b|[^\d])/i.exec(text);
  const height = normalizeQualityHeight(heightMatch?.[1]);
  if (height) {
    return {
      qualityLabel: `${height}p`,
      qualityHeight: height,
      qualityRank: height,
      qualityExplicit: true
    };
  }

  const dimensionMatch = /(?:^|[^\d])([1-9]\d{2,4})\s*(?:x|\u00d7)\s*([1-9]\d{2,3})(?:\b|[^\d])/i.exec(text);
  const dimensionHeight = normalizeQualityHeight(dimensionMatch?.[2]);
  if (dimensionHeight) {
    return {
      qualityLabel: `${dimensionHeight}p`,
      qualityHeight: dimensionHeight,
      qualityWidth: Number(dimensionMatch[1]),
      qualityRank: dimensionHeight,
      qualityExplicit: true
    };
  }

  if (/\b(4k|uhd|2160)\b/i.test(text)) {
    return {
      qualityLabel: "4K",
      qualityHeight: 2160,
      qualityRank: 2160,
      qualityExplicit: true
    };
  }

  if (/\b(2k|qhd|1440)\b/i.test(text)) {
    return {
      qualityLabel: "1440p",
      qualityHeight: 1440,
      qualityRank: 1440,
      qualityExplicit: true
    };
  }

  if (/(^|[^a-z])fhd([^a-z]|$)/i.test(text)) {
    return {
      qualityLabel: "1080p",
      qualityHeight: 1080,
      qualityRank: 1080,
      qualityExplicit: true
    };
  }

  if (/(^|[^a-z])hd([^a-z]|$)/i.test(text)) {
    return {
      qualityLabel: "HD",
      qualityHeight: 720,
      qualityRank: 720,
      qualityExplicit: true
    };
  }

  if (/(^|[^a-z])sd([^a-z]|$)/i.test(text)) {
    return {
      qualityLabel: "SD",
      qualityHeight: 480,
      qualityRank: 480,
      qualityExplicit: true
    };
  }

  if (/(^|[^a-z])low([^a-z]|$)/i.test(text)) {
    return {
      qualityLabel: "Low",
      qualityRank: 240,
      qualityExplicit: true
    };
  }

  if (/(^|[^a-z])(medium|med)([^a-z]|$)/i.test(text)) {
    return {
      qualityLabel: "Medium",
      qualityRank: 480,
      qualityExplicit: true
    };
  }

  if (/(^|[^a-z])high([^a-z]|$)/i.test(text)) {
    return {
      qualityLabel: "High",
      qualityRank: 720,
      qualityExplicit: true
    };
  }

  return null;
}

function videoQualityMetadata(attributes, attributeName, rawValue) {
  const texts = [
    attributeName,
    rawValue,
    attributes.get("label"),
    attributes.get("title"),
    attributes.get("aria-label"),
    attributes.get("res"),
    attributes.get("size"),
    attributes.get("quality"),
    attributes.get("data-quality"),
    attributes.get("data-res"),
    attributes.get("data-resolution"),
    attributes.get("data-height"),
    attributes.get("height"),
    attributes.get("width")
  ];

  for (const text of texts) {
    const quality = qualityFromText(text);
    if (quality) {
      return quality;
    }
  }

  const height = normalizeQualityHeight(attributes.get("height") || attributes.get("data-height"));
  if (height) {
    return {
      qualityLabel: `${height}p`,
      qualityHeight: height,
      qualityRank: height,
      qualityExplicit: true
    };
  }

  return {};
}

function addVideoCandidate(videos, seen, rawValue, pageUrl, metadata = {}, requireVideoExtension = false) {
  const resolved = resolveImageUrl(rawValue, pageUrl);
  if (!resolved) {
    return;
  }
  if (looksLikeImageUrl(resolved)) {
    return;
  }
  if (requireVideoExtension && !looksLikeVideoSourceUrl(resolved)) {
    return;
  }

  const nextCandidate = {
    url: resolved,
    ...metadata
  };
  const existingIndex = seen.get(resolved);
  if (existingIndex != null) {
    const existing = videos[existingIndex];
    if (existing.isNoisy && !nextCandidate.isNoisy) {
      return;
    }
    if ((nextCandidate.sourceRank || 0) > (existing.sourceRank || 0)) {
      videos[existingIndex] = {
        ...existing,
        ...nextCandidate,
        poster: nextCandidate.poster || existing.poster || null,
        originalLabel: nextCandidate.originalLabel || existing.originalLabel || null,
        qualityLabel: nextCandidate.qualityLabel || existing.qualityLabel || null,
        qualityHeight: nextCandidate.qualityHeight || existing.qualityHeight || null,
        qualityWidth: nextCandidate.qualityWidth || existing.qualityWidth || null,
        qualityRank: nextCandidate.qualityRank || existing.qualityRank || null,
        qualityExplicit: Boolean(nextCandidate.qualityExplicit || existing.qualityExplicit),
        variantGroup: nextCandidate.variantGroup || existing.variantGroup || null
      };
    }
    return;
  }

  seen.set(resolved, videos.length);
  videos.push(nextCandidate);
}

function attributeValueMatches(attributes, pattern) {
  return [
    attributes.get("id"),
    attributes.get("class"),
    attributes.get("role"),
    attributes.get("itemprop"),
    attributes.get("property"),
    attributes.get("name")
  ].filter(Boolean).join(" ").toLowerCase().match(pattern);
}

function isPlayerLikeTag(attributes) {
  return Boolean(attributeValueMatches(attributes, /(^|[\s_-])(player|video|watch|main|content|media|jwplayer|vjs|plyr|html5video)([\s_-]|$)/i));
}

function isNoisyVideoTag(attributes) {
  return Boolean(attributeValueMatches(attributes, /(^|[\s_-])(ad|ads|advert|banner|promo|vast|vpaid|preroll|pre-roll|related|recommend|suggest|sidebar|thumb|trailer)([\s_-]|$)/i));
}

function extractMetaContents(html, pageUrl, pattern) {
  const values = [];
  const tagRegex = /<(meta|link)\b[^>]*>/gi;
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const attributes = parseAttributes(match[0]);
    const descriptor = [
      attributes.get("property"),
      attributes.get("name"),
      attributes.get("itemprop"),
      attributes.get("rel")
    ].filter(Boolean).join(" ").toLowerCase();
    if (!pattern.test(descriptor)) {
      continue;
    }

    const resolved = resolveImageUrl(attributes.get("content") || attributes.get("href"), pageUrl);
    if (resolved) {
      values.push(resolved);
    }
  }

  return values;
}

function extractMetaContent(html, pageUrl, pattern) {
  return extractMetaContents(html, pageUrl, pattern)[0] || null;
}

function extractPagePoster(html, pageUrl) {
  return extractMetaContent(html, pageUrl, /(^|:|\s)(image|thumbnail|poster|image_src)(:|\s|$)/i);
}

function jsonLdTexts(html) {
  const texts = [];
  const scriptRegex = /<script\b[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json')[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    texts.push(decodeHtmlAttribute(match[1].trim()));
  }
  return texts;
}

function flattenJsonLd(value) {
  if (Array.isArray(value)) {
    return value.flatMap(flattenJsonLd);
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const nested = [];
  for (const key of ["@graph", "mainEntity", "subjectOf", "hasPart", "video"]) {
    if (value[key]) {
      nested.push(...flattenJsonLd(value[key]));
    }
  }
  return [value, ...nested];
}

function firstStringValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(firstStringValue).find(Boolean) || "";
  }
  if (value && typeof value === "object") {
    return firstStringValue(value.url || value.contentUrl || value.embedUrl);
  }
  return "";
}

function addJsonLdVideoCandidates(html, pageUrl, add) {
  for (const text of jsonLdTexts(html)) {
    try {
      for (const item of flattenJsonLd(JSON.parse(text))) {
        const type = firstStringValue(item["@type"]).toLowerCase();
        if (!type.includes("video")) {
          continue;
        }

        const poster = resolveImageUrl(
          firstStringValue(item.thumbnailUrl || item.thumbnail || item.image),
          pageUrl
        );
        const metadata = {
          poster: poster || null,
          originalLabel: firstStringValue(item.name || item.headline).slice(0, 160) || null,
          kind: "main-video",
          sourceRank: 95
        };
        add(firstStringValue(item.contentUrl), metadata, false);
        add(firstStringValue(item.embedUrl), metadata, false);
        add(firstStringValue(item.url), metadata, true);
      }
    } catch {
    }
  }
}

function videoPageTokens(pageUrl) {
  try {
    const parsed = new URL(pageUrl);
    return parsed.pathname
      .split(/[^\p{L}\p{N}]+/u)
      .map((part) => part.toLowerCase())
      .filter((part) => part.length >= 3);
  } catch {
    return [];
  }
}

function videoCandidateScore(candidate, pageUrl, index) {
  let score = Number(candidate.sourceRank || 0) - index * 0.1;
  const haystack = [
    candidate.url,
    candidate.filename,
    candidate.kind,
    candidate.originalLabel
  ].filter(Boolean).join(" ").toLowerCase();

  if (looksLikeVideoSourceUrl(candidate.url)) {
    score += 24;
  }
  if (candidate.poster) {
    score += 8;
  }
  if (/main|player|content|watch|source|video-object/.test(String(candidate.kind || "").toLowerCase())) {
    score += 12;
  }
  if (/\b(ad|ads|advert|banner|promo|vast|vpaid|preroll|pre-roll|popunder|tracker|analytics|doubleclick|googlesyndication|outstream|related|recommend|suggest|sidebar|thumb|trailer)\b/i.test(haystack)) {
    score -= 55;
  }

  let candidateUrl = null;
  let page = null;
  try {
    candidateUrl = new URL(candidate.url);
    page = new URL(pageUrl);
    if (candidateUrl.hostname === page.hostname) {
      score += 5;
    }
    if (candidateUrl.pathname === page.pathname) {
      score -= 30;
    }
  } catch {
  }

  const tokens = videoPageTokens(pageUrl);
  const matchCount = tokens.filter((token) => haystack.includes(token)).length;
  score += Math.min(18, matchCount * 6);

  return score;
}

function primaryVideoCandidates(candidates, pageUrl, limit = maxVideoCandidateValidationCount) {
  if (!candidates.length) {
    return [];
  }

  const useful = candidates.filter((candidate) => {
    const kind = String(candidate.kind || "").toLowerCase();
    const sourceRank = Number(candidate.sourceRank || 0);
    const expandablePlayer = /main|player|embed|iframe|content|watch/.test(kind);
    const directish = looksLikeVideoSourceUrl(candidate.url) || sourceRank >= 70 || expandablePlayer;
    const noisyKind = candidate.isNoisy || /related|suggest|advert|linked-page/.test(kind);
    return directish && !noisyKind;
  });
  const pool = useful.length ? useful : candidates;
  return pool
    .map((candidate, index) => ({
      candidate,
      score: videoCandidateScore(candidate, pageUrl, index)
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

function extractVideoUrls(html, pageUrl) {
  const candidates = [];
  const seen = new Map();
  const pagePoster = extractPagePoster(html, pageUrl);

  function add(rawValue, metadata = {}, requireVideoExtension = false) {
    addVideoCandidate(candidates, seen, rawValue, pageUrl, {
      poster: metadata.poster || pagePoster || null,
      ...metadata
    }, requireVideoExtension);
  }

  addJsonLdVideoCandidates(html, pageUrl, add);

  const metaVideoUrl = extractMetaContents(html, pageUrl, /(^|:|\s)(video|player|movie)(:|\s|$)/i)
    .find((url) => !looksLikeImageUrl(url));
  if (metaVideoUrl) {
    add(metaVideoUrl, {
      kind: "main-video",
      sourceRank: 88
    }, false);
  }

  const tagRegex = /<(video|source|a|meta|link|iframe|div|span|li)\b[^>]*>/gi;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(html)) !== null && candidates.length < maxScannedVideos) {
    const tagName = tagMatch[1].toLowerCase();
    const attributes = parseAttributes(tagMatch[0]);
    const poster = resolveImageUrl(attributes.get("poster") || attributes.get("data-poster"), pageUrl);
    const label = attributes.get("title") || attributes.get("aria-label") || attributes.get("download") || "";
    const filename = attributes.get("download") || "";
    const type = normalizedContentType(attributes.get("type"));
    const isVideoTyped = type.startsWith("video/");
    const playerLike = isPlayerLikeTag(attributes);
    const noisyTag = isNoisyVideoTag(attributes);
    const metadata = {
      poster: poster || null,
      originalLabel: label ? String(label).slice(0, 160) : null,
      filename: filename ? sanitizeFileName(String(filename)) : null,
      kind: noisyTag
        ? "related-video"
        : tagName === "video" || tagName === "source"
        ? "main-video-source"
        : playerLike
          ? "player-video"
          : tagName === "a"
            ? "linked-video"
            : "embedded-video",
      isNoisy: noisyTag,
      sourceRank: noisyTag ? 6 : tagName === "source" ? 82 : tagName === "video" ? 78 : playerLike ? 58 : tagName === "a" ? 28 : 35
    };

    for (const name of [
      "src",
      "href",
      "content",
      "data-src",
      "data-original",
      "data-url",
      "data-video",
      "data-file",
      "data-media",
      "data-mp4",
      "data-webm",
      "data-hls",
      "data-m3u8",
      "data-stream",
      "data-playlist",
      "data-hd",
      "data-sd"
    ]) {
      const rawValue = attributes.get(name);
      if (!rawValue) {
        continue;
      }

      const requireVideoExtension = tagName === "video" || tagName === "source" || tagName === "iframe" || isVideoTyped || playerLike
        ? false
        : true;
      add(rawValue, {
        ...metadata,
        ...videoQualityMetadata(attributes, name, rawValue)
      }, requireVideoExtension);
    }

    for (const [name, value] of attributes.entries()) {
      if (/video|media|file|source|mp4|webm|hls|m3u8|playlist|stream|movie/i.test(name)) {
        add(value, {
          ...metadata,
          ...videoQualityMetadata(attributes, name, value)
        }, !(isVideoTyped || tagName === "video" || tagName === "source" || tagName === "iframe" || playerLike));
      }
    }
  }

  const videoUrlRegex = /(?:https?:)?\/\/[^\s"'<>\\]+\.(?:3gp|avi|flv|m3u8?|m4v|mkv|mov|mp4|mpe?g|ogv|ts|webm|wmv)(?:\?[^\s"'<>\\]*)?(?=$|[\s"'<>\\])|\/[^\s"'<>\\]+\.(?:3gp|avi|flv|m3u8?|m4v|mkv|mov|mp4|mpe?g|ogv|ts|webm|wmv)(?:\?[^\s"'<>\\]*)?(?=$|[\s"'<>\\])/gi;
  for (const sourceText of mediaSearchTexts(html)) {
    let urlMatch;
    while ((urlMatch = videoUrlRegex.exec(sourceText)) !== null && candidates.length < maxScannedVideos) {
      const rawValue = decodeHtmlAttribute(unescapeJsString(urlMatch[0]));
      add(rawValue, {
        kind: "script-video",
        sourceRank: 24,
        ...(qualityFromText(rawValue) || {})
      }, true);
    }
  }

  return primaryVideoCandidates(candidates.slice(0, maxScannedVideos), pageUrl);
}

function parseHlsAttributeList(value) {
  const attributes = {};
  const text = String(value || "");
  let index = 0;
  while (index < text.length) {
    while (text[index] === "," || /\s/.test(text[index] || "")) {
      index++;
    }
    const keyStart = index;
    while (index < text.length && text[index] !== "=" && text[index] !== ",") {
      index++;
    }
    const key = text.slice(keyStart, index).trim().toUpperCase();
    if (!key || text[index] !== "=") {
      while (index < text.length && text[index] !== ",") {
        index++;
      }
      continue;
    }
    index++;
    let rawValue = "";
    if (text[index] === "\"") {
      index++;
      const valueStart = index;
      while (index < text.length && text[index] !== "\"") {
        index++;
      }
      rawValue = text.slice(valueStart, index);
      index++;
    } else {
      const valueStart = index;
      while (index < text.length && text[index] !== ",") {
        index++;
      }
      rawValue = text.slice(valueStart, index).trim();
    }
    attributes[key] = rawValue;
  }
  return attributes;
}

function hlsQualityMetadata(attributes, fallbackUrl = "") {
  const resolution = String(attributes.RESOLUTION || "");
  const resolutionMatch = /^(\d+)x(\d+)$/i.exec(resolution);
  const height = normalizeQualityHeight(resolutionMatch?.[2]);
  if (height) {
    return {
      qualityLabel: `${height}p`,
      qualityHeight: height,
      qualityWidth: Number(resolutionMatch[1]),
      qualityRank: height,
      qualityExplicit: true
    };
  }

  const bandwidth = Number(attributes.BANDWIDTH || attributes["AVERAGE-BANDWIDTH"] || 0);
  if (Number.isFinite(bandwidth) && bandwidth > 0) {
    const megabits = bandwidth / 1000000;
    return {
      qualityLabel: `${megabits >= 10 ? Math.round(megabits) : megabits.toFixed(1)} Mbps`,
      qualityRank: Math.round(bandwidth / 1000),
      qualityExplicit: true
    };
  }

  return qualityFromText(fallbackUrl) || {};
}

function parseHlsMasterPlaylist(text, playlistUrl) {
  const lines = String(text || "").split(/\r?\n/);
  const variants = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) {
      continue;
    }

    const attributes = parseHlsAttributeList(line.slice("#EXT-X-STREAM-INF:".length));
    let uri = "";
    for (let uriIndex = index + 1; uriIndex < lines.length; uriIndex++) {
      const nextLine = lines[uriIndex].trim();
      if (!nextLine || nextLine.startsWith("#")) {
        continue;
      }
      uri = nextLine;
      break;
    }
    const url = resolveImageUrl(uri, playlistUrl);
    if (!url) {
      continue;
    }
    variants.push({
      url,
      protocol: "hls",
      contentType: "application/vnd.apple.mpegurl",
      kind: "hls-variant",
      variantGroup: playlistUrl,
      qualitySource: "hls-manifest",
      ...hlsQualityMetadata(attributes, url)
    });
  }
  return variants;
}

function hlsMapUriFromLine(line) {
  const attributes = parseHlsAttributeList(line.slice("#EXT-X-MAP:".length));
  return attributes.URI || "";
}

function parseHlsMediaPlaylist(text, playlistUrl) {
  const lines = String(text || "").split(/\r?\n/);
  const segments = [];
  let encrypted = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const attributes = parseHlsAttributeList(line.slice("#EXT-X-KEY:".length));
      if (attributes.METHOD && attributes.METHOD.toUpperCase() !== "NONE") {
        encrypted = true;
      }
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const mapUrl = resolveImageUrl(hlsMapUriFromLine(line), playlistUrl);
      if (mapUrl) {
        segments.push(mapUrl);
      }
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    const segmentUrl = resolveImageUrl(line, playlistUrl);
    if (segmentUrl) {
      segments.push(segmentUrl);
    }
  }

  return {
    encrypted,
    segments
  };
}

async function requestTextResource(urlInput, options = {}) {
  const response = await requestBuffer(urlInput, {
    maxBytes: options.maxBytes || maxHlsPlaylistBytes,
    timeout: options.timeout || 20000,
    headers: options.headers || videoRequestHeaders
  });
  return {
    ...response,
    text: response.buffer.toString("utf8")
  };
}

async function hlsVariantsForVideo(video) {
  try {
    const referer = video.referer || video.sourcePage || video.url;
    const customHeaders = normalizeVideoHttpHeaders(video.httpHeaders);
    const playlist = await requestTextResource(video.url, {
      headers: {
        ...videoRequestHeaders,
        ...customHeaders,
        Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,application/x-mpegurl,audio/mpegurl,video/*,*/*;q=0.8",
        Referer: referer
      }
    });
    if (!/^#EXTM3U/m.test(playlist.text)) {
      return [video];
    }

    const variants = parseHlsMasterPlaylist(playlist.text, playlist.finalUrl);
    if (!variants.length) {
      return [{
        ...video,
        url: playlist.finalUrl,
        protocol: "hls",
        contentType: normalizedContentType(playlist.contentType) || "application/vnd.apple.mpegurl",
        kind: video.kind || "hls-playlist",
        variantGroup: video.variantGroup || playlist.finalUrl,
        displaySize: video.displaySize || "HLS playlist"
      }];
    }

    return variants.map((variant) => ({
      ...video,
      ...variant,
      hlsMasterUrl: video.url,
      referer,
      sourcePage: video.sourcePage || referer,
      poster: video.poster || null,
      originalLabel: video.originalLabel || null,
      filename: video.filename || null,
      sourceRank: Math.max(Number(video.sourceRank || 0), 90)
    }));
  } catch {
    return [video];
  }
}

function isExpandableVideoCandidate(video, pageUrl) {
  if (!video?.url || looksLikeVideoSourceUrl(video.url)) {
    return false;
  }
  if (video.isNoisy || /related|suggest|advert|linked-page/i.test(String(video.kind || ""))) {
    return false;
  }
  try {
    const candidate = new URL(video.url);
    const page = new URL(pageUrl);
    if (candidate.href === page.href) {
      return false;
    }
  } catch {
  }
  return /main|player|embed|iframe|content|watch|video/i.test(String(video.kind || "")) ||
    Number(video.sourceRank || 0) >= 35;
}

async function expandVideoCandidates(videoUrls, pageUrl, depth = 0) {
  const expanded = [];
  const seen = new Map();

  function add(video) {
    if (!video?.url) return;
    const index = seen.get(video.url);
    if (index !== undefined) {
      const existing = expanded[index];
      // An actual playlist describes the stream more reliably than a page
      // label or a resolution guessed from its URL. Keep that evidence even
      // when the rendition was already discovered elsewhere on the page.
      if (video.qualitySource === "hls-manifest" && existing.qualitySource !== "hls-manifest") {
        expanded[index] = {
          ...existing, ...video,
          poster: video.poster || existing.poster || null,
          filename: video.filename || existing.filename || null,
          sourceRank: Math.max(Number(existing.sourceRank || 0), Number(video.sourceRank || 0))
        };
      }
      return;
    }
    seen.set(video.url, expanded.length);
    expanded.push(video);
  }

  videoUrls.forEach(add);

  const hlsExpanded = await mapWithConcurrency(
    expanded.filter((video) => looksLikeHlsPlaylistUrl(video.url)).slice(0, maxVideoCandidateValidationCount),
    2,
    hlsVariantsForVideo
  );
  hlsExpanded.flat().forEach(add);

  if (depth >= 2) {
    return expanded;
  }

  const playerCandidates = videoUrls
    .filter((video) => isExpandableVideoCandidate(video, pageUrl))
    .slice(0, maxExpandedPlayerPages);
  const nestedLists = await mapWithConcurrency(playerCandidates, 2, async (candidate) => {
    const referer = candidate.referer || candidate.sourcePage || pageUrl;
    try {
      const page = await requestBuffer(candidate.url, {
        maxBytes: maxPageBytes,
        timeout: 25000,
        headers: {
          ...browserNavigationHeaders,
          Referer: referer
        }
      });
      if (normalizedContentType(page.contentType).startsWith("video/") || looksLikeVideoSourceUrl(page.finalUrl)) {
        return [{
          ...candidate,
          url: page.finalUrl,
          referer,
          sourcePage: candidate.url,
          contentType: page.contentType
        }];
      }
      const html = page.buffer.toString("utf8");
      const nested = extractVideoUrls(html, page.finalUrl).map((video) => ({
        ...video,
        referer: page.finalUrl,
        sourcePage: page.finalUrl,
        poster: video.poster || candidate.poster || null,
        originalLabel: video.originalLabel || candidate.originalLabel || null,
        sourceRank: Math.max(Number(video.sourceRank || 0), Number(candidate.sourceRank || 0) + 10)
      }));
      return expandVideoCandidates(nested, page.finalUrl, depth + 1);
    } catch (error) {
      if (!shouldRenderVideoPageAfterFetchError(error)) {
        return [];
      }
      const renderedHtml = await renderPageWithEdge(candidate.url);
      if (!renderedHtml) {
        return [];
      }
      const nested = extractVideoUrls(renderedHtml, candidate.url).map((video) => ({
        ...video,
        referer: candidate.url,
        sourcePage: candidate.url,
        poster: video.poster || candidate.poster || null,
        originalLabel: video.originalLabel || candidate.originalLabel || null,
        sourceRank: Math.max(Number(video.sourceRank || 0), Number(candidate.sourceRank || 0) + 10)
      }));
      return expandVideoCandidates(nested, candidate.url, depth + 1);
    }
  });

  nestedLists.flat(2).forEach(add);
  return primaryVideoCandidates(expanded, pageUrl);
}

function isProbablyDecorativeImageUrl(value) {
  try {
    const parsed = new URL(value);
    const searchable = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    const basename = path.basename(parsed.pathname).toLowerCase();

    if (/\b(logo|sprite|icon|favicon|loading|spinner|blank|pixel|avatar|qrcode|qr|banner|advert|ad_|_ad|arrow|prev|next|pager|nav|button|roller|rating)\b/.test(searchable)) {
      return true;
    }

    return (
      basename === "logo.gif" ||
      basename === "logo.png" ||
      basename === "logo_mini.gif" ||
      basename === "blank.gif" ||
      basename === "mr.gif" ||
      basename === "roller.gif" ||
      basename === "ygm.png" ||
      basename.startsWith("icon_") ||
      basename.startsWith("ico_") ||
      basename.startsWith("btn_")
    );
  } catch {
    return false;
  }
}

function keepUsefulImages(urls) {
  const useful = urls.filter((candidate) => candidate.crop || !isProbablyDecorativeImageUrl(candidate.url));
  const croppedUrls = new Set(
    useful
      .filter((candidate) => candidate.crop)
      .map((candidate) => candidate.url)
  );

  return useful.filter((candidate) => candidate.crop || !croppedUrls.has(candidate.url));
}

function addImageCandidate(urls, seen, rawValue, pageUrl, requireImageExtension = false) {
  const resolved = resolveImageUrl(rawValue, pageUrl);
  if (!resolved || seen.has(resolved)) {
    return;
  }
  if (requireImageExtension && !looksLikeImageUrl(resolved)) {
    return;
  }
  seen.add(resolved);
  urls.push({ url: resolved });
}

function addCroppedImageCandidate(urls, seen, rawValue, pageUrl, crop) {
  const resolved = resolveImageUrl(rawValue, pageUrl);
  if (!resolved || !crop || !looksLikeImageUrl(resolved)) {
    return;
  }

  const key = `${resolved}#crop=${crop.x},${crop.y},${crop.width},${crop.height}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  urls.push({
    url: resolved,
    crop
  });
}

function parseCssPixel(style, propertyName) {
  const match = new RegExp(`${propertyName}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, "i").exec(style);
  return match ? Math.round(Number(match[1])) : 0;
}

function parseCssBackgroundSprite(style, pageUrl) {
  const width = parseCssPixel(style, "width");
  const height = parseCssPixel(style, "height");
  if (!width || !height) {
    return null;
  }

  const urlRegex = /url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/i;
  const urlMatch = urlRegex.exec(style);
  if (!urlMatch) {
    return null;
  }

  const rawUrl = urlMatch[1] || urlMatch[2] || urlMatch[3] || "";
  const resolved = resolveImageUrl(rawUrl, pageUrl);
  if (!resolved || !looksLikeImageUrl(resolved)) {
    return null;
  }

  let x = 0;
  let y = 0;
  const backgroundPositionMatch = /background-position\s*:\s*(-?\d+(?:\.\d+)?)(?:px)?\s+(-?\d+(?:\.\d+)?)(?:px)?/i.exec(style);
  const afterUrl = style.slice(urlMatch.index + urlMatch[0].length);
  const inlinePositionMatch = /(?:^|\s)(-?\d+(?:\.\d+)?)(?:px)?\s+(-?\d+(?:\.\d+)?)(?:px)?(?:\s|$)/i.exec(afterUrl);
  const positionMatch = backgroundPositionMatch || inlinePositionMatch;
  if (positionMatch) {
    x = Math.max(0, Math.round(Math.abs(Number(positionMatch[1]))));
    y = Math.max(0, Math.round(Math.abs(Number(positionMatch[2]))));
  }

  return {
    url: resolved,
    crop: {
      x,
      y,
      width,
      height
    }
  };
}

function extractPackedScriptText(html) {
  const decodedTexts = [];
  const packerRegex = /function\(p,a,c,k,e,d\)\{[\s\S]*?\}\(\s*'((?:\\.|[^'])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\.|[^'])*)'\.split\(\s*'(?:\\x7c|\|)'\s*\)/gi;
  let match;

  while ((match = packerRegex.exec(html)) !== null) {
    const payload = unescapeJsString(match[1]);
    const radix = Number(match[2]);
    const count = Number(match[3]);
    const words = unescapeJsString(match[4]).split("|");
    if (!payload || !radix || !count || words.length <= 1) {
      continue;
    }
    decodedTexts.push(unpackPackerPayload(payload, radix, count, words));
  }

  return decodedTexts.join("\n");
}

function unescapeJsString(value) {
  return value
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

function packerToken(value, radix) {
  const digit = (digitValue) => (
    digitValue > 35 ? String.fromCharCode(digitValue + 29) : digitValue.toString(36)
  );
  let current = value;
  let token = "";

  do {
    token = digit(current % radix) + token;
    current = Math.floor(current / radix);
  } while (current > 0);

  return token;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unpackPackerPayload(payload, radix, count, words) {
  let decoded = payload;

  for (let index = count - 1; index >= 0; index--) {
    if (!words[index]) {
      continue;
    }
    decoded = decoded.replace(
      new RegExp(`\\b${escapeRegex(packerToken(index, radix))}\\b`, "g"),
      words[index]
    );
  }

  return decoded;
}

function mediaSearchTexts(html) {
  const texts = [];
  const seen = new Set();

  function add(value) {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    texts.push(value);
  }

  for (const text of [html, extractPackedScriptText(html)]) {
    add(unescapeJsString(text || ""));
    add(text);
  }

  return texts;
}

async function findEdgeExecutable() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
    }
  }

  return null;
}

async function renderPageWithEdge(pageUrl, options = {}) {
  const edgePath = await findEdgeExecutable();
  if (!edgePath) {
    return null;
  }
  const timeout = Number(options.timeout || renderedPageTimeoutMs);
  const virtualTimeBudget = Number(options.virtualTimeBudget || renderedPageVirtualTimeBudgetMs);

  const userDataDir = path.join(
    os.tmpdir(),
    `local-torrent-downloader-edge-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  try {
    const { stdout } = await execFileAsync(edgePath, [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-extensions",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userDataDir}`,
      `--virtual-time-budget=${virtualTimeBudget}`,
      "--dump-dom",
      pageUrl
    ], {
      timeout,
      maxBuffer: maxPageBytes * 4,
      windowsHide: true
    });

    return stdout;
  } catch {
    return null;
  } finally {
    fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

function extractImageUrls(html, pageUrl) {
  const candidates = [];
  const seen = new Set();

  function add(rawValue, requireImageExtension = false) {
    addImageCandidate(candidates, seen, rawValue, pageUrl, requireImageExtension);
  }

  function addCrop(rawValue, crop) {
    addCroppedImageCandidate(candidates, seen, rawValue, pageUrl, crop);
  }

  const tagRegex = /<(img|source|picture|video|meta|link|a|div|span|li)\b[^>]*>/gi;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(html)) !== null && candidates.length < maxScannedImages) {
    const tagName = tagMatch[1].toLowerCase();
    const attributes = parseAttributes(tagMatch[0]);
    for (const name of [
      "src",
      "poster",
      "data-src",
      "data-original",
      "data-lazy-src",
      "data-url",
      "data-image",
      "data-img",
      "data-cover",
      "data-thumb",
      "data-thumbnail",
      "data-pic",
      "data-photo",
      "data-background",
      "data-bg",
      "lazy-src",
      "original"
    ]) {
      add(attributes.get(name));
    }
    if (tagName === "meta" || tagName === "link" || tagName === "a") {
      add(attributes.get("content"), true);
      add(attributes.get("href"), true);
    }
    for (const name of ["srcset", "data-srcset"]) {
      for (const candidate of parseSrcset(attributes.get(name) || "")) {
        add(candidate);
      }
    }

    for (const [name, value] of attributes.entries()) {
      if (/src|image|img|cover|thumb|photo|pic|poster|background|bg|url/i.test(name)) {
        add(value, !/^data-|src$|poster$|lazy-src$|original$/i.test(name));
      }
      if (name === "style") {
        const sprite = parseCssBackgroundSprite(value, pageUrl);
        if (sprite) {
          addCrop(sprite.url, sprite.crop);
        } else {
          const cssUrlRegex = /url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi;
          let cssMatch;
          while ((cssMatch = cssUrlRegex.exec(value)) !== null && candidates.length < maxScannedImages) {
            add(cssMatch[1] || cssMatch[2] || cssMatch[3], true);
          }
        }
      }
    }
  }

  const linkRegex = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null && candidates.length < maxScannedImages) {
    add(decodeHtmlAttribute(linkMatch[1] || linkMatch[2] || linkMatch[3] || ""), true);
  }

  const imageUrlRegex = /(?:https?:)?\/\/[^\s"'<>\\]+\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)(?:\?[^\s"'<>\\]*)?|\/[^\s"'<>\\]+\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)(?:\?[^\s"'<>\\]*)?/gi;
  for (const sourceText of mediaSearchTexts(html)) {
    let urlMatch;
    while ((urlMatch = imageUrlRegex.exec(sourceText)) !== null && candidates.length < maxScannedImages) {
      add(decodeHtmlAttribute(unescapeJsString(urlMatch[0])), true);
    }
  }

  return keepUsefulImages(candidates).slice(0, maxScannedImages);
}

function galleryNameFromUrl(pageUrl) {
  try {
    const parsed = new URL(pageUrl);
    const lastSegment = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) || "");
    const withoutExtension = lastSegment.replace(/\.[a-z0-9]{1,8}$/i, "");
    return sanitizeFileName(withoutExtension || parsed.hostname || "gallery");
  } catch {
    return "gallery";
  }
}

function galleryNameFromHtml(html, pageUrl) {
  const metaTitleRegex = /<meta\b[^>]*(?:property|name)\s*=\s*(?:"|')?(?:og:title|twitter:title|title)(?:"|')?[^>]*>/i;
  const metaMatch = metaTitleRegex.exec(html || "");
  const metaAttributes = metaMatch ? parseAttributes(metaMatch[0]) : null;
  const rawTitle = metaAttributes?.get("content") || /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html || "")?.[1] || "";
  const title = decodeHtmlAttribute(rawTitle.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return sanitizeFileName(title || galleryNameFromUrl(pageUrl));
}

function imageGalleryOutputDir(rootDir, galleryName, pageUrl) {
  const safeName = galleryName
    ? sanitizeFileName(String(galleryName).trim())
    : galleryNameFromUrl(pageUrl);
  return path.join(rootDir, safeName || "gallery");
}

function imageExtensionFromContentType(contentType) {
  const normalized = contentType.toLowerCase().split(";")[0].trim();
  if (normalized === "image/jpeg") {
    return ".jpg";
  }
  if (normalized === "image/png") {
    return ".png";
  }
  if (normalized === "image/gif") {
    return ".gif";
  }
  if (normalized === "image/webp") {
    return ".webp";
  }
  if (normalized === "image/avif") {
    return ".avif";
  }
  if (normalized === "image/svg+xml") {
    return ".svg";
  }
  if (normalized === "image/bmp") {
    return ".bmp";
  }
  return ".img";
}

function normalizedContentType(contentType) {
  return String(contentType || "").toLowerCase().split(";")[0].trim();
}

function filenameWithOutputExtension(baseName, contentType) {
  const extension = path.extname(baseName);
  const targetExtension = imageExtensionFromContentType(contentType);

  if (!extension) {
    return `${baseName}${targetExtension}`;
  }

  if (targetExtension === ".png" && extension.toLowerCase() === ".webp") {
    return `${baseName.slice(0, -extension.length)}.png`;
  }

  if (targetExtension === ".webp" && extension.toLowerCase() !== ".webp") {
    return `${baseName.slice(0, -extension.length)}.webp`;
  }

  return baseName;
}

function sanitizeFileName(value) {
  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  })();
  const sanitized = decoded
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);

  return sanitized || "image";
}

function makeImageFilename(imageUrl, index, contentType, usedNames) {
  const parsed = new URL(imageUrl);
  let baseName = sanitizeFileName(path.basename(parsed.pathname) || "image");
  baseName = filenameWithOutputExtension(baseName, contentType);

  let filename = `${String(index).padStart(3, "0")}-${baseName}`;
  let attempt = 2;
  while (usedNames.has(filename.toLowerCase())) {
    const extension = path.extname(baseName);
    const stem = extension ? baseName.slice(0, -extension.length) : baseName;
    filename = `${String(index).padStart(3, "0")}-${stem}-${attempt}${extension}`;
    attempt++;
  }

  usedNames.add(filename.toLowerCase());
  return filename;
}

function makePreferredImageFilename(imageUrl, index, contentType, usedNames, preferredFilename) {
  if (!preferredFilename) {
    return makeImageFilename(imageUrl, index, contentType, usedNames);
  }

  let baseName = filenameWithOutputExtension(sanitizeFileName(preferredFilename), contentType);

  let filename = `${String(index).padStart(3, "0")}-${baseName}`;
  let attempt = 2;
  while (usedNames.has(filename.toLowerCase())) {
    const extension = path.extname(baseName);
    const stem = extension ? baseName.slice(0, -extension.length) : baseName;
    filename = `${String(index).padStart(3, "0")}-${stem}-${attempt}${extension}`;
    attempt++;
  }

  usedNames.add(filename.toLowerCase());
  return filename;
}

async function cropImageBufferWithEdge(buffer, sourceUrl, crop) {
  const edgePath = await findEdgeExecutable();
  if (!edgePath) {
    throw new Error("Microsoft Edge is required to split this sprite image.");
  }

  const tempDir = path.join(
    os.tmpdir(),
    `local-torrent-downloader-crop-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const sourceExtension = imageExtensions.has(path.extname(new URL(sourceUrl).pathname).toLowerCase())
    ? path.extname(new URL(sourceUrl).pathname)
    : ".img";
  const sourceFile = path.join(tempDir, `source${sourceExtension}`);
  const htmlFile = path.join(tempDir, "crop.html");
  const outputFile = path.join(tempDir, "crop.png");

  try {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(sourceFile, buffer);
    await fs.writeFile(htmlFile, `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html, body {
  margin: 0;
  width: ${crop.width}px;
  height: ${crop.height}px;
  overflow: hidden;
  background: transparent;
}
img {
  position: absolute;
  left: -${crop.x}px;
  top: -${crop.y}px;
  max-width: none;
  max-height: none;
}
</style>
</head>
<body><img src="${pathToFileURL(sourceFile).href}"></body>
</html>`);

    await execFileAsync(edgePath, [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--disable-extensions",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      `--screenshot=${outputFile}`,
      `--window-size=${crop.width},${crop.height}`,
      pathToFileURL(htmlFile).href
    ], {
      timeout: 30000,
      windowsHide: true
    });

    return await fs.readFile(outputFile);
  } finally {
    fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function cropImageBufferWithSharp(buffer, crop) {
  if (!sharpModulePromise) {
    sharpModulePromise = import("sharp");
  }

  const sharpModule = await sharpModulePromise;
  const sharp = sharpModule.default || sharpModule;
  return sharp(buffer, { limitInputPixels: false })
    .extract({
      left: crop.x,
      top: crop.y,
      width: crop.width,
      height: crop.height
    })
    .png()
    .toBuffer();
}

async function cropImageBuffer(buffer, sourceUrl, crop) {
  try {
    return await cropImageBufferWithSharp(buffer, crop);
  } catch (sharpError) {
    try {
      return await cropImageBufferWithEdge(buffer, sourceUrl, crop);
    } catch (edgeError) {
      throw new Error(`Could not crop image. Sharp: ${sharpError.message}; Edge: ${edgeError.message}`);
    }
  }
}

async function sharpImage(buffer, options = {}) {
  if (!sharpModulePromise) {
    sharpModulePromise = import("sharp");
  }

  const sharpModule = await sharpModulePromise;
  const sharp = sharpModule.default || sharpModule;
  return sharp(buffer, {
    limitInputPixels: false,
    ...options
  });
}

async function webpIsAnimated(buffer) {
  const metadata = await (await sharpImage(buffer, { animated: true })).metadata();
  return Number(metadata.pages || 1) > 1;
}

async function convertImageBufferToPng(buffer) {
  return (await sharpImage(buffer))
    .png()
    .toBuffer();
}

async function outputImageBuffer(buffer, finalUrl, contentType, activeImage) {
  const sourceContentType = normalizedContentType(contentType);
  if (activeImage.crop) {
    return {
      buffer: await cropImageBuffer(buffer, finalUrl, activeImage.crop),
      contentType: "image/png",
      convertedFrom: sourceContentType && sourceContentType !== "image/png" ? sourceContentType : null
    };
  }

  if (sourceContentType === "image/webp" && !(await webpIsAnimated(buffer))) {
    return {
      buffer: await convertImageBufferToPng(buffer),
      contentType: "image/png",
      convertedFrom: "image/webp"
    };
  }

  return {
    buffer,
    contentType: sourceContentType || contentType,
    convertedFrom: null
  };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function duplicateImageExtensions() {
  return new Set([...imageExtensions, ".img"]);
}

async function buildOutputFileIndex(outputDir) {
  const usedNames = new Set();
  const existingHashes = new Map();
  const allowedExtensions = duplicateImageExtensions();
  let entries = [];

  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch {
    return { usedNames, existingHashes };
  }

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) {
      return;
    }

    usedNames.add(entry.name.toLowerCase());
    const extension = path.extname(entry.name).toLowerCase();
    if (!allowedExtensions.has(extension)) {
      return;
    }

    const filePath = path.join(outputDir, entry.name);
    try {
      const buffer = await fs.readFile(filePath);
      const hash = sha256(buffer);
      if (!existingHashes.has(hash)) {
        existingHashes.set(hash, {
          filename: entry.name,
          path: filePath,
          bytes: buffer.byteLength
        });
      }
    } catch {
    }
  }));

  return { usedNames, existingHashes };
}

async function fetchHtmlPage(pageUrl, referer = null) {
  const { buffer, contentType, finalUrl } = await requestBuffer(pageUrl, {
    maxBytes: maxPageBytes,
    timeout: 30000,
    headers: {
      ...imageRequestHeaders,
      Referer: referer || pageUrl
    }
  });

  if (contentType.toLowerCase().startsWith("image/")) {
    return {
      contentType,
      finalUrl,
      html: null
    };
  }

  return {
    contentType,
    finalUrl,
    html: buffer.toString("utf8")
  };
}

function extractEhentaiGalleryPageUrls(html, pageUrl) {
  const parsedBase = new URL(pageUrl);
  parsedBase.search = "";
  parsedBase.hash = "";

  let maxPage = 0;
  const hrefRegex = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    const rawHref = decodeHtmlAttribute(match[1] || match[2] || match[3] || "");
    try {
      const href = new URL(rawHref, pageUrl);
      if (href.origin !== parsedBase.origin || href.pathname !== parsedBase.pathname) {
        continue;
      }
      const page = Number(href.searchParams.get("p"));
      if (Number.isInteger(page) && page > maxPage && page < 1000) {
        maxPage = page;
      }
    } catch {
    }
  }

  const urls = [parsedBase.href];
  for (let page = 1; page <= maxPage; page++) {
    const nextPage = new URL(parsedBase.href);
    nextPage.searchParams.set("p", String(page));
    urls.push(nextPage.href);
  }
  return urls;
}

function extractEhentaiReaderLinks(html, pageUrl) {
  const links = new Map();
  const hrefRegex = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;

  while ((match = hrefRegex.exec(html)) !== null) {
    const rawHref = decodeHtmlAttribute(match[1] || match[2] || match[3] || "");
    try {
      const href = new URL(rawHref, pageUrl);
      if (!isEhentaiReaderUrl(href.href)) {
        continue;
      }
      href.hash = "";
      const pageNumber = ehentaiPageNumber(href.href);
      links.set(href.href, {
        url: href.href,
        pageNumber
      });
    } catch {
    }
  }

  return Array.from(links.values()).sort(sortByPageNumber);
}

function filenameForEhentaiReaderImage(imageUrl, readerUrl, infoFilename) {
  const parsed = new URL(imageUrl);
  const imageExtension = path.extname(parsed.pathname) || ".jpg";
  const pageNumber = ehentaiPageNumber(readerUrl);
  const sourceName = infoFilename
    ? path.basename(sanitizeFileName(infoFilename), path.extname(infoFilename))
    : String(pageNumber || 1).padStart(3, "0");

  return `${sourceName}${imageExtension}`;
}

function extractEhentaiReaderImage(html, readerUrl) {
  const imgTagMatch = /<img\b(?=[^>]*\bid\s*=\s*(?:"img"|'img'))[^>]*>/i.exec(html);
  if (!imgTagMatch) {
    return null;
  }

  const attributes = parseAttributes(imgTagMatch[0]);
  const imageUrl = resolveImageUrl(attributes.get("src"), readerUrl);
  if (!imageUrl || !looksLikeImageUrl(imageUrl)) {
    return null;
  }

  const infoMatch = /<div>\s*([^<>"']+?\.(?:png|jpe?g|gif|webp))\s*::\s*(\d+)\s*x\s*(\d+)\s*::\s*([^<]+?)\s*<\/div>/i.exec(html);
  const fullImageMatch = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*\/fullimg\/[^"]+)"|'([^']*\/fullimg\/[^']+)')[^>]*>\s*Download original\s+(\d+)\s*x\s*(\d+)\s+([^<]+?)\s*<\/a>/i.exec(html);
  const originalUrl = fullImageMatch
    ? resolveImageUrl(fullImageMatch[1] || fullImageMatch[2], readerUrl)
    : null;

  const result = {
    url: imageUrl,
    referer: readerUrl,
    filename: filenameForEhentaiReaderImage(imageUrl, readerUrl, infoMatch?.[1]),
    sourcePage: readerUrl,
    pageNumber: ehentaiPageNumber(readerUrl),
    kind: "reader-image"
  };

  if (infoMatch) {
    result.width = Number(infoMatch[2]);
    result.height = Number(infoMatch[3]);
    result.displaySize = infoMatch[4].trim();
  }

  if (originalUrl) {
    result.originalUrl = originalUrl;
    result.originalLabel = fullImageMatch[0].replace(/<[^>]+>/g, "").trim();
  }

  return result;
}

async function mapWithConcurrency(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await callback(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function scanEhentaiReaderPage(pageUrl) {
  const { html, finalUrl } = await fetchHtmlPage(pageUrl);
  if (!html) {
    return null;
  }

  const image = extractEhentaiReaderImage(html, finalUrl);
  return image
    ? { images: [image], galleryName: galleryNameFromHtml(html, finalUrl) }
    : null;
}

async function scanEhentaiGallery(pageUrl) {
  const firstPage = await fetchHtmlPage(pageUrl);
  if (!firstPage.html) {
    return null;
  }

  const galleryPageUrls = extractEhentaiGalleryPageUrls(firstPage.html, firstPage.finalUrl);
  const galleryPages = [firstPage];
  if (galleryPageUrls.length > 1) {
    const rest = await mapWithConcurrency(galleryPageUrls.slice(1), 4, async (galleryPageUrl) => {
      try {
        return await fetchHtmlPage(galleryPageUrl, firstPage.finalUrl);
      } catch {
        return null;
      }
    });
    galleryPages.push(...rest.filter(Boolean));
  }

  const readerLinks = new Map();
  for (const galleryPage of galleryPages) {
    for (const link of extractEhentaiReaderLinks(galleryPage.html || "", galleryPage.finalUrl)) {
      readerLinks.set(link.url, link);
    }
  }

  const sortedReaderLinks = Array.from(readerLinks.values()).sort(sortByPageNumber).slice(0, maxScannedImages);
  if (sortedReaderLinks.length === 0) {
    return null;
  }

  const readerImages = await mapWithConcurrency(sortedReaderLinks, 4, async (readerLink) => {
    try {
      const { html, finalUrl } = await fetchHtmlPage(readerLink.url, firstPage.finalUrl);
      return html ? extractEhentaiReaderImage(html, finalUrl) : null;
    } catch {
      return null;
    }
  });

  return {
    images: readerImages.filter(Boolean).sort(sortByPageNumber),
    galleryName: galleryNameFromHtml(firstPage.html, firstPage.finalUrl)
  };
}

async function fetchPageForImages(pageUrl) {
  if (isEhentaiGalleryUrl(pageUrl)) {
    const galleryImages = await scanEhentaiGallery(pageUrl);
    if (galleryImages?.images?.length > 0) {
      return {
        contentType: "text/html",
        imageUrls: galleryImages.images,
        galleryName: galleryImages.galleryName
      };
    }
  }

  if (isEhentaiReaderUrl(pageUrl)) {
    const readerImages = await scanEhentaiReaderPage(pageUrl);
    if (readerImages?.images?.length > 0) {
      return {
        contentType: "text/html",
        imageUrls: readerImages.images,
        galleryName: readerImages.galleryName
      };
    }
  }

  const { buffer, contentType, finalUrl } = await requestBuffer(pageUrl, {
    maxBytes: maxPageBytes,
    timeout: 30000,
    headers: imageRequestHeaders
  });

  if (contentType.toLowerCase().startsWith("image/")) {
    return {
      contentType,
      imageUrls: [{ url: finalUrl }],
      galleryName: galleryNameFromUrl(finalUrl)
    };
  }

  const html = buffer.toString("utf8");
  let imageUrls = extractImageUrls(html, finalUrl);
  let galleryName = galleryNameFromHtml(html, finalUrl);
  if (imageUrls.length === 0) {
    const renderedHtml = await renderPageWithEdge(finalUrl);
    if (renderedHtml) {
      imageUrls = extractImageUrls(renderedHtml, finalUrl);
      galleryName = galleryNameFromHtml(renderedHtml, finalUrl);
    }
  }

  return {
    contentType,
    imageUrls,
    galleryName
  };
}

async function scanImagePage(pageUrlInput) {
  const pageUrl = parseHttpUrl(pageUrlInput, "page URL").href;
  const { imageUrls, galleryName } = await fetchPageForImages(pageUrl);
  return {
    pageUrl,
    galleryName: galleryName || galleryNameFromUrl(pageUrl),
    count: imageUrls.length,
    images: imageUrls.map((image, index) => {
      const url = typeof image === "string" ? image : image.url;
      const result = {
        url,
        referer: typeof image === "object" && image.referer ? image.referer : pageUrl,
        filename: typeof image === "object" && image.filename
          ? sanitizeFileName(String(image.filename))
          : suggestedImageFilename(image, index)
      };
      for (const key of ["sourcePage", "pageNumber", "width", "height", "displaySize", "kind", "originalUrl", "originalLabel"]) {
        if (typeof image === "object" && image[key] != null) {
          result[key] = image[key];
        }
      }
      const crop = typeof image === "object" ? normalizeCrop(image.crop) : null;
      if (crop) {
        result.crop = crop;
        result.isCrop = true;
        result.cropX = crop.x;
        result.cropY = crop.y;
        result.cropWidth = crop.width;
        result.cropHeight = crop.height;
      }
      return result;
    })
  };
}

function shouldRenderVideoPageAfterFetchError(error) {
  if (error?.accessBlocked) {
    return false;
  }

  const code = String(error?.code || "");
  const statusCode = Number(error?.statusCode || 0);
  const message = String(error?.message || "").toLowerCase();
  const browserRecoverableCodes = new Set([
    "ECONNRESET",
    "ECONNABORTED",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT"
  ]);
  return statusCode === 403 ||
    statusCode === 408 ||
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    code === "HTTP_403" ||
    browserRecoverableCodes.has(code) ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("connect");
}

function accessBlockedVideoError() {
  const error = new Error("HTTP 403");
  error.statusCode = 403;
  error.code = "HTTP_403";
  error.accessBlocked = true;
  return error;
}

function browserVerificationPageState(html, pageUrl) {
  return verifiedPageState({
    url: pageUrl, status: 200, readyState: "complete", html,
    title: /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || ""
  }, pageUrl);
}

function videoScanTimeoutError() {
  const error = new Error("Video scan timed out.");
  error.code = "VIDEO_SCAN_TIMEOUT";
  return error;
}

function withTimeout(promise, timeoutMs, createError) {
  let timeoutId;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      clearTimeout(timeoutId);
    }),
    new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(createError());
      }, timeoutMs);
    })
  ]);
}

function looksLikeAccessChallengeHtml(html) {
  return /(?:cf-challenge|cdn-cgi\/challenge|turnstile|captcha|Just a moment|Checking your browser|Attention Required|Cloudflare Ray ID|Access denied)/i.test(
    String(html || "").slice(0, 200000)
  );
}

function hasDirectVideoReference(html) {
  return /(?:https?:)?\/\/[^\s"'<>\\]+\.(?:3gp|avi|flv|m3u8?|m4v|mkv|mov|mp4|mpe?g|ogv|ts|webm|wmv)(?:\?[^\s"'<>\\]*)?(?=$|[\s"'<>\\])|\/[^\s"'<>\\]+\.(?:3gp|avi|flv|m3u8?|m4v|mkv|mov|mp4|mpe?g|ogv|ts|webm|wmv)(?:\?[^\s"'<>\\]*)?(?=$|[\s"'<>\\])/i.test(
    String(html || "").slice(0, 500000)
  );
}

function shouldStopForAccessChallenge(html) {
  return looksLikeAccessChallengeHtml(html) && !hasDirectVideoReference(html);
}

function renderedVideoCandidates(html, pageUrl) {
  const videoUrls = extractVideoUrls(html, pageUrl);
  const directVideoUrls = videoUrls.filter((video) => looksLikeVideoSourceUrl(video.url));
  return directVideoUrls.length ? directVideoUrls : videoUrls;
}

async function fetchPageForVideos(pageUrl) {
  if (looksLikeVideoSourceUrl(pageUrl)) {
    return {
      contentType: looksLikeHlsPlaylistUrl(pageUrl) ? "application/vnd.apple.mpegurl" : "video/*",
      videoUrls: await expandVideoCandidates([{ url: pageUrl }], pageUrl),
      usedBrowserFallback: false
    };
  }

  let page;
  try {
    page = await requestBuffer(pageUrl, {
      maxBytes: maxPageBytes,
      timeout: videoPageRequestTimeoutMs,
      headers: browserNavigationHeaders
    });
  } catch (error) {
    if (error?.browserChallenge) throw error;
    if (!shouldRenderVideoPageAfterFetchError(error)) {
      throw error;
    }

    const renderedHtml = await renderPageWithEdge(pageUrl);
    if (!renderedHtml) {
      throw error;
    }
    if (shouldStopForAccessChallenge(renderedHtml)) {
      throw accessBlockedVideoError();
    }

    return {
      contentType: "text/html",
      videoUrls: renderedVideoCandidates(renderedHtml, pageUrl),
      usedBrowserFallback: true
    };
  }

  const { buffer, contentType, finalUrl } = page;
  if (normalizedContentType(contentType).startsWith("video/") || isHlsContentType(contentType) || looksLikeVideoSourceUrl(finalUrl)) {
    return {
      contentType,
      videoUrls: await expandVideoCandidates([{ url: finalUrl, contentType }], finalUrl),
      usedBrowserFallback: false
    };
  }

  const html = buffer.toString("utf8");
  if (shouldStopForAccessChallenge(html)) {
    throw accessBlockedVideoError();
  }

  let videoUrls = extractVideoUrls(html, finalUrl);
  let usedBrowserFallback = false;
  if (videoUrls.length === 0) {
    const renderedHtml = await renderPageWithEdge(finalUrl);
    if (renderedHtml) {
      if (shouldStopForAccessChallenge(renderedHtml)) {
        throw accessBlockedVideoError();
      }
      videoUrls = renderedVideoCandidates(renderedHtml, finalUrl);
      usedBrowserFallback = true;
    }
  }
  if (!usedBrowserFallback) {
    videoUrls = await expandVideoCandidates(videoUrls, finalUrl);
  }

  return {
    contentType,
    videoUrls,
    usedBrowserFallback
  };
}

function videoQualityLabel(video, fallbackIndex = 0) {
  if (video.qualityLabel) {
    return String(video.qualityLabel);
  }

  if (video.qualityHeight) {
    return `${video.qualityHeight}p`;
  }

  return fallbackIndex ? `Source ${fallbackIndex}` : "Source";
}

function stripQualityTokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(?:2160p|1440p|1080p|720p|540p|480p|360p|240p|4k|2k|uhd|qhd|fhd|hd|sd|low|medium|med|high)\b/g, "")
    .replace(/(?:^|[-_.\s])(?:2160|1440|1080|720|540|480|360|240)(?=$|[-_.\s])/g, "")
    .replace(/[-_.\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function videoVariantFamilyKey(video) {
  try {
    const parsed = new URL(video.url);
    const extension = path.posix.extname(parsed.pathname).toLowerCase();
    const dirname = path.posix.dirname(parsed.pathname);
    const basename = path.posix.basename(parsed.pathname, extension);
    const stem = stripQualityTokens(basename) || basename.toLowerCase() || "video";
    const search = new URLSearchParams(parsed.search);
    for (const key of Array.from(search.keys())) {
      if (/^(q|quality|res|resolution|height|size|label)$/i.test(key)) {
        search.delete(key);
      }
    }
    const query = search.toString();
    return `${parsed.origin}${dirname}/${stem}${extension}${query ? `?${query}` : ""}`;
  } catch {
    return "";
  }
}

function isVideoQualityVariant(primary, candidate) {
  if (primary.url === candidate.url) {
    return true;
  }

  if (primary.variantGroup && primary.variantGroup === candidate.variantGroup) {
    return true;
  }

  const primaryQuality = Boolean(primary.qualityExplicit || primary.qualityLabel || primary.qualityHeight);
  const candidateQuality = Boolean(candidate.qualityExplicit || candidate.qualityLabel || candidate.qualityHeight);
  if (!primaryQuality && !candidateQuality) {
    return false;
  }

  const primaryFamily = videoVariantFamilyKey(primary);
  const candidateFamily = videoVariantFamilyKey(candidate);
  if (primaryFamily && primaryFamily === candidateFamily) {
    return true;
  }

  const primaryLabel = String(primary.originalLabel || "").trim().toLowerCase();
  const candidateLabel = String(candidate.originalLabel || "").trim().toLowerCase();
  return Boolean(primaryLabel && primaryLabel === candidateLabel);
}

function videoVariantRank(variant) {
  const qualityRank = Number(variant.qualityRank || variant.qualityHeight || 0);
  if (Number.isFinite(qualityRank) && qualityRank > 0) {
    return qualityRank * 1024 ** 4;
  }

  return Number(variant.bytes || 0);
}

function normalizedVideoVariant(video, index) {
  return {
    url: video.url,
    fallbackUrls: normalizeVideoUrlList(video.fallbackUrls, video.url)
      .filter((url) => url !== video.url),
    referer: video.referer || video.sourcePage || null,
    sourcePage: video.sourcePage || video.referer || null,
    poster: video.poster || null,
    filename: video.filename || suggestedVideoFilename(video, index),
    displaySize: video.displaySize || null,
    bytes: video.bytes || 0,
    contentType: video.contentType || null,
    protocol: video.protocol || (looksLikeHlsPlaylistUrl(video.url) || isHlsContentType(video.contentType) ? "hls" : "file"),
    kind: video.kind || null,
    originalLabel: video.originalLabel || null,
    qualityLabel: videoQualityLabel(video, index + 1),
    qualityHeight: video.qualityHeight || null,
    qualityWidth: video.qualityWidth || null,
    qualityTierLabel: video.qualityTierLabel || null,
    qualityTierHeight: video.qualityTierHeight || null,
    bilibiliQualityId: video.bilibiliQualityId || null,
    qualityRank: video.qualityRank || video.qualityHeight || null,
    qualityExplicit: Boolean(video.qualityExplicit || video.qualityLabel || video.qualityHeight),
    qualitySource: video.qualitySource || null,
    extractor: video.extractor || null,
    extractorKey: video.extractorKey || null,
    pageUrl: video.pageUrl || null,
    formatId: video.formatId || null,
    formatSelector: video.formatSelector || null,
    formatExt: video.formatExt || null,
    hasAudio: video.hasAudio ?? null,
    requiresAudioMerge: Boolean(video.requiresAudioMerge),
    audioUrl: video.audioUrl || null,
    audioFallbackUrls: normalizeVideoUrlList(video.audioFallbackUrls, video.audioUrl || video.url)
      .filter((url) => url !== video.audioUrl),
    audioBytes: Number(video.audioBytes || 0) || 0,
    audioContentType: video.audioContentType || null,
    cookiesFromBrowser: video.cookiesFromBrowser || null,
    authSessionId: video.authSessionId || null,
    impersonate: video.impersonate || null,
    httpHeaders: normalizeVideoHttpHeaders(video.httpHeaders)
  };
}

let ytDlpCommandPromise = null;
const videoAuthentication = createVideoAuthenticationRegistry();

function localYtDlpVendorDir() {
  return path.join(rootDir, "vendor", "python");
}

function localYtDlpBinaryPath() {
  return path.join(
    localYtDlpVendorDir(),
    "bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
  );
}

function ytDlpProcessEnv() {
  const vendorDir = localYtDlpVendorDir();
  return {
    ...process.env,
    PYTHONPATH: process.env.PYTHONPATH
      ? `${vendorDir}${path.delimiter}${process.env.PYTHONPATH}`
      : vendorDir
  };
}

async function findYtDlpCommand() {
  const candidates = [];
  if (process.env.MAGIC_BOX_YTDLP_PATH) {
    candidates.push({ command: process.env.MAGIC_BOX_YTDLP_PATH, args: [] });
  }

  const localBinary = localYtDlpBinaryPath();
  if (await fileExists(localBinary)) {
    candidates.push({ command: localBinary, args: [] });
  }

  candidates.push(
    { command: "py", args: ["-m", "yt_dlp"] },
    { command: "python", args: ["-m", "yt_dlp"] },
    { command: "yt-dlp", args: [] }
  );

  const env = ytDlpProcessEnv();
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate.command, [...candidate.args, "--version"], {
        encoding: "utf8",
        env,
        timeout: ytDlpProbeTimeoutMs,
        windowsHide: true
      });
      return {
        ...candidate,
        env
      };
    } catch {
      // Try the next candidate.
    }
  }

  const error = new Error("yt-dlp is not available.");
  error.code = "YTDLP_UNAVAILABLE";
  throw error;
}

async function resolveYtDlpCommand() {
  if (!ytDlpCommandPromise) {
    ytDlpCommandPromise = findYtDlpCommand();
  }

  try {
    return await ytDlpCommandPromise;
  } catch (error) {
    ytDlpCommandPromise = null;
    throw error;
  }
}

async function execYtDlp(args, options = {}) {
  const command = await resolveYtDlpCommand();
  const prepared = await prepareVideoCookieArgs(args);
  try {
    return await execFileAsync(command.command, [...command.args, "--ignore-config", ...prepared.args], {
      encoding: "utf8",
      env: command.env,
      maxBuffer: options.maxBuffer || 50 * 1024 * 1024,
      timeout: options.timeout || ytDlpScanTimeoutMs,
      windowsHide: true
    });
  } finally {
    await prepared.cleanup();
  }
}

async function spawnYtDlp(args) {
  const command = await resolveYtDlpCommand();
  const prepared = await prepareVideoCookieArgs(args);
  try {
    const child = spawn(command.command, [...command.args, "--ignore-config", ...prepared.args], {
      env: command.env,
      windowsHide: true
    });
    const cleanup = () => { prepared.cleanup().catch(() => {}); };
    child.once("error", cleanup);
    child.once("close", cleanup);
    return child;
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }
}

function ytDlpPrimaryInfo(info) {
  if (!info || typeof info !== "object") {
    return null;
  }

  if (Array.isArray(info.entries)) {
    return info.entries.find((entry) => entry && Array.isArray(entry.formats)) ||
      info.entries.find((entry) => entry && entry.url) ||
      null;
  }

  return info;
}

function ytDlpFormatExtension(format) {
  const extension = String(format?.ext || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (extension && videoExtensions.has(`.${extension}`)) {
    return extension;
  }
  return "mp4";
}

function ytDlpFormatBytes(format) {
  const value = Number(format?.filesize || format?.filesize_approx || 0);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function ytDlpFormatHasAudio(format) {
  const acodec = String(format?.acodec || "").toLowerCase();
  return !acodec || acodec !== "none";
}

function ytDlpFormatIsVideo(format) {
  if (!format || typeof format !== "object" || !format.url) {
    return false;
  }

  const vcodec = String(format.vcodec || "").toLowerCase();
  if (vcodec === "none") {
    return false;
  }

  const extension = String(format.ext || "").toLowerCase();
  if (imageExtensions.has(`.${extension}`) || extension === "mhtml" || extension === "storyboard") {
    return false;
  }

  const protocol = String(format.protocol || "").toLowerCase();
  return !protocol.includes("mhtml");
}

const bilibiliQualityTiers = new Map([
  [6, { label: "240P 极速", height: 240 }],
  [16, { label: "360P 流畅", height: 360 }],
  [32, { label: "480P 标清", height: 480 }],
  [64, { label: "720P 准高清", height: 720 }],
  [74, { label: "720P 60帧", height: 720 }],
  [80, { label: "1080P 高清", height: 1080 }],
  [112, { label: "1080P 高码率", height: 1080 }],
  [116, { label: "1080P 60帧", height: 1080 }],
  [120, { label: "4K 超清", height: 2160 }],
  [125, { label: "HDR 真彩", height: null }],
  [126, { label: "杜比视界", height: null }],
  [127, { label: "8K 超高清", height: 4320 }]
]);

function bilibiliFormatTier(format) {
  // yt-dlp's quality is the BiliBili tier (e.g. 80), while format_id may
  // instead be a codec/CDN selector (e.g. 30080). Never substitute the latter.
  const id = Number(format?.quality);
  const tier = bilibiliQualityTiers.get(id);
  const description = String(format?.format_note || format?.format || "").trim().slice(0, 160);
  const namedTier = /\d{3,4}\s*p|[248]\s*k|HDR|Dolby|杜比|高码率|高帧率|增强/i.test(description);
  const namedHeight = namedTier ? qualityFromText(description)?.qualityHeight || null : null;
  return {
    bilibiliQualityId: Number.isInteger(id) && id > 0 ? id : null,
    qualityTierLabel: namedTier ? description : tier?.label || null,
    qualityTierHeight: tier?.height || namedHeight || null
  };
}

function ytDlpFormatQuality(format, options = {}) {
  const fromText = qualityFromText([
    format?.format_note,
    format?.format,
    format?.resolution
  ].filter(Boolean).join(" "));
  const qualityHeight = normalizeQualityHeight(format?.height) || fromText?.qualityHeight || null;
  const qualityWidth = Number(format?.width || 0) > 0 ? Math.round(Number(format.width)) : fromText?.qualityWidth || null;
  const fps = Number(format?.fps || 0);
  const tbr = Number(format?.tbr || format?.vbr || 0);
  return {
    qualityHeight,
    qualityWidth,
    ...(options.bilibili ? bilibiliFormatTier(format) : {}),
    fps: Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 0,
    tbr: Number.isFinite(tbr) && tbr > 0 ? Math.round(tbr) : 0
  };
}

function ytDlpQualityLabel(format, fallbackIndex, options = {}) {
  const quality = ytDlpFormatQuality(format, options);
  const parts = [];
  if (quality.qualityTierLabel) {
    parts.push(quality.qualityTierLabel);
  } else if (quality.qualityHeight) {
    parts.push(`${quality.qualityHeight}p`);
  } else if (format?.resolution && format.resolution !== "audio only") {
    parts.push(String(format.resolution));
  } else if (format?.format_note) {
    parts.push(String(format.format_note));
  } else {
    parts.push(`Source ${fallbackIndex}`);
  }

  if (quality.fps > 30 && !parts[0].includes(`${quality.fps}`)) {
    parts.push(`${quality.fps}fps`);
  }
  if (quality.qualityTierLabel && quality.qualityWidth && quality.qualityHeight && quality.qualityHeight !== quality.qualityTierHeight) {
    parts.push(`(${quality.qualityWidth}×${quality.qualityHeight})`);
  }

  const extension = ytDlpFormatExtension(format);
  if (extension) {
    parts.push(extension);
  }

  const protocol = String(format?.protocol || "").toLowerCase();
  if (protocol.includes("m3u8")) {
    parts.push("HLS");
  } else if (protocol.includes("dash")) {
    parts.push("DASH");
  }

  if (!ytDlpFormatHasAudio(format)) {
    parts.push(options.mergeAudio ? "+ audio" : "video-only");
  }

  return parts.join(" ");
}

function ytDlpVariantRank(variant) {
  const audioOnly = variant.kind === "bilibili-audio" ||
    String(variant.contentType || "").toLowerCase().startsWith("audio/") ||
    String(variant.formatExt || "").toLowerCase() === "mp3";
  const audioBonus = !audioOnly && (variant.hasAudio || variant.requiresAudioMerge || variant.audioUrl)
    ? 1_000_000_000
    : 0;
  const height = Number(variant.qualityTierHeight || variant.qualityHeight || 0);
  const fps = Number(variant.fps || 0);
  const bitrate = Number(variant.bitrate || 0);
  return (audioOnly ? -1_000_000_000 : audioBonus) + height * 1_000_000 + fps * 10_000 + bitrate;
}

function compareYtDlpVariants(left, right) {
  if (left.bilibiliQualityId && right.bilibiliQualityId) {
    const tierHeight = left.qualityTierHeight && right.qualityTierHeight
      ? right.qualityTierHeight - left.qualityTierHeight
      : (right.qualityHeight || 0) - (left.qualityHeight || 0);
    if (tierHeight) return tierHeight;
    const tierId = right.bilibiliQualityId - left.bilibiliQualityId;
    if (tierId) return tierId;
  }
  return ytDlpVariantRank(right) - ytDlpVariantRank(left);
}

function buildYtDlpScannedVideoResults(info, pageUrlInput, options = {}) {
  const pageUrl = parseHttpUrl(pageUrlInput, "page URL").href;
  const entry = ytDlpPrimaryInfo(info);
  if (!entry) {
    return [];
  }

  const formats = Array.isArray(entry.formats) && entry.formats.length
    ? entry.formats
    : [entry];
  const hasSeparateAudio = formats.some((format) => format?.url &&
    String(format.vcodec || "").toLowerCase() === "none" && ytDlpFormatHasAudio(format));
  const sourcePage = normalizeOptionalUrl(entry.webpage_url || info?.webpage_url, pageUrl, "source page URL") || pageUrl;
  const bilibili = isBilibiliUrl(pageUrl) || isBilibiliUrl(sourcePage) || /^bilibili(?:$|:)/i.test(String(entry.extractor_key || info?.extractor_key || entry.extractor || ""));
  const poster = normalizeOptionalUrl(entry.thumbnail || info?.thumbnail, sourcePage, "poster URL");
  const title = sanitizeFileName(
    entry.title ||
    info?.title ||
    entry.fulltitle ||
    entry.id ||
    new URL(pageUrl).hostname ||
    "video"
  );
  const baseHeaders = normalizeVideoHttpHeaders(entry.http_headers || info?.http_headers);
  const seen = new Set();
  const variants = formats
    .filter(ytDlpFormatIsVideo)
    .map((format, index) => {
      const resolvedUrl = resolveImageUrl(format.url, sourcePage);
      if (!resolvedUrl) {
        return null;
      }

      const formatId = String(format.format_id || format.format || index + 1).slice(0, 160);
      const dedupeKey = `${formatId}\n${resolvedUrl}`;
      if (seen.has(dedupeKey)) {
        return null;
      }
      seen.add(dedupeKey);

      const extension = ytDlpFormatExtension(format);
      const contentType = videoContentTypeFromExtension(extension) || format.http_headers?.["Content-Type"] || "video/*";
      const bytes = ytDlpFormatBytes(format);
      const quality = ytDlpFormatQuality(format, { bilibili });
      const hasAudio = ytDlpFormatHasAudio(format);
      const requiresAudioMerge = !hasAudio && hasSeparateAudio;
      const httpHeaders = normalizeVideoHttpHeaders({
        ...(baseHeaders || {}),
        ...(format.http_headers || {})
      }) || baseHeaders;
      const referer = httpHeaders?.Referer || sourcePage;
      const protocol = String(format.protocol || "").toLowerCase();
      const videoProtocol = protocol.includes("m3u8") ? "hls" : "yt-dlp";

      return {
        url: resolvedUrl,
        referer,
        sourcePage,
        poster,
        filename: `${title}.${extension || "mp4"}`,
        displaySize: formatByteCount(bytes),
        bytes,
        contentType,
        protocol: videoProtocol,
        kind: "yt-dlp-format",
        originalLabel: format.format || format.format_note || null,
        qualityLabel: ytDlpQualityLabel(format, index + 1, { mergeAudio: requiresAudioMerge, bilibili }),
        qualityHeight: quality.qualityHeight,
        qualityWidth: quality.qualityWidth,
        ...(bilibili ? {
          qualityTierLabel: quality.qualityTierLabel,
          qualityTierHeight: quality.qualityTierHeight,
          bilibiliQualityId: quality.bilibiliQualityId
        } : {}),
        qualityRank: quality.qualityTierHeight || quality.qualityHeight || quality.tbr || 0,
        qualityExplicit: true,
        extractor: "yt-dlp",
        extractorKey: entry.extractor_key || info?.extractor_key || null,
        pageUrl,
        formatId,
        formatSelector: requiresAudioMerge ? `${formatId}+bestaudio` : formatId,
        formatExt: extension,
        hasAudio,
        requiresAudioMerge,
        fps: quality.fps,
        bitrate: quality.tbr,
        cookiesFromBrowser: options.cookiesFromBrowser || null,
        cookiesFile: options.cookiesFile || null,
        impersonate: options.impersonate || null,
        httpHeaders
      };
    })
    .filter(Boolean)
    .sort(compareYtDlpVariants);

  if (!variants.length) {
    return [];
  }

  const selected = variants[0];
  return [{
    ...selected,
    id: "video-1",
    listIndex: 1,
    selectedQualityUrl: selected.url,
    variants: variants.map((variant, index) => ({
      ...variant,
      id: `video-1-quality-${index + 1}`
    }))
  }];
}

function shouldAttemptYtDlpScan(pageUrl) {
  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return false;
    }
    return !isDouyinUrl(pageUrl) && !isMissAvUrl(pageUrl) && !isJavtifulUrl(pageUrl);
  } catch {
    return false;
  }
}

function ytDlpErrorSummary(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  if (stderr) {
    return stderr.split(/\r?\n/).slice(-2).join(" ");
  }
  return error?.message || "yt-dlp failed.";
}

async function extractVideosWithYtDlp(pageUrl, options = {}) {
  if (!shouldAttemptYtDlpScan(pageUrl) && !isDouyinUrl(pageUrl)) {
    return [];
  }

  const { stdout } = await execYtDlp([
    ...(options.cookiesFile ? ["--cookies", options.cookiesFile]
      : options.browser ? ["--cookies-from-browser", options.browser] : []),
    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "--no-check-certificate",
    "--socket-timeout",
    "20",
    pageUrl
  ]);
  const info = JSON.parse(stdout);
  return buildYtDlpScannedVideoResults(info, pageUrl, {
    cookiesFromBrowser: options.cookiesFile ? null : options.browser,
    cookiesFile: options.cookiesFile
  });
}

const supportedBrowserCookieSources = new Set(["edge", "chrome", "firefox"]);

function normalizeBrowserCookieSource(value) {
  if (value == null || value === "") {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!supportedBrowserCookieSources.has(normalized)) {
    const error = new Error("Choose Edge, Chrome, or Firefox for video site login.");
    error.code = "INVALID_BROWSER_SOURCE";
    throw error;
  }
  return normalized;
}

async function extractBilibiliVideosWithBrowserLogin(pageUrl, browserInput, options = {}) {
  const cookiesFile = options.cookiesFile || null;
  const browser = cookiesFile ? null : normalizeBrowserCookieSource(browserInput);
  if (!browser && !cookiesFile) {
    return [];
  }

  try {
    const { stdout } = await (options.execYtDlp || execYtDlp)([
      ...(cookiesFile ? ["--cookies", cookiesFile] : ["--cookies-from-browser", browser]),
      "--dump-single-json",
      "--no-playlist",
      "--skip-download",
      "--no-warnings",
      "--no-check-certificate",
      "--socket-timeout",
      "30",
      pageUrl
    ], { timeout: Math.max(ytDlpScanTimeoutMs, 2 * 60 * 1000) });
    const videos = buildYtDlpScannedVideoResults(JSON.parse(stdout), pageUrl, {
      cookiesFromBrowser: browser,
      cookiesFile
    });
    return videos;
  } catch (error) {
    if (error?.code === "YTDLP_UNAVAILABLE") {
      throw error;
    }
    const wrapped = new Error(
      cookiesFile
        ? "Could not use the BiliBili cookie file. Export a fresh Netscape cookie file from a signed-in BiliBili session and scan again."
        : `Could not use the ${browser} BiliBili session. Sign in to BiliBili in that browser, close the browser if its cookie database is locked, or use an exported Netscape cookie file and scan again.`
    );
    wrapped.code = "BILIBILI_BROWSER_LOGIN_FAILED";
    wrapped.cause = error;
    throw wrapped;
  }
}

function isBilibiliUrl(pageUrl) {
  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase();
    return hostname === "bilibili.com" ||
      hostname.endsWith(".bilibili.com") ||
      hostname === "b23.tv" ||
      hostname.endsWith(".b23.tv");
  } catch {
    return false;
  }
}

function extractWindowJsonAssignment(html, assignmentName) {
  const assignmentMatch = new RegExp(`${escapeRegex(assignmentName)}\\s*=\\s*`).exec(html);
  if (!assignmentMatch) {
    return null;
  }

  let index = assignmentMatch.index + assignmentMatch[0].length;
  while (index < html.length && /\s/.test(html[index])) {
    index++;
  }
  if (html[index] !== "{" && html[index] !== "[") {
    return null;
  }

  const opening = html[index];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let cursor = index; cursor < html.length; cursor++) {
    const char = html[cursor];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === opening) {
      depth++;
    } else if (char === closing) {
      depth--;
      if (depth === 0) {
        return JSON.parse(html.slice(index, cursor + 1));
      }
    }
  }

  return null;
}

function bilibiliTitleFromPage(html, initialState, pageUrl) {
  const rawTitle = initialState?.videoData?.title ||
    initialState?.videoData?.bvid ||
    /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1] ||
    new URL(pageUrl).hostname;
  return sanitizeFileName(
    decodeHtmlAttribute(String(rawTitle))
      .replace(/_哔哩哔哩_bilibili.*$/i, "")
      .replace(/\s*-\s*bilibili.*$/i, "")
      .trim()
  );
}

function bilibiliPosterFromPage(html, initialState, pageUrl) {
  const rawPoster = initialState?.videoData?.pic || initialState?.videoData?.pic_url || extractPagePoster(html, pageUrl);
  if (!rawPoster) {
    return null;
  }
  return resolveImageUrl(rawPoster, pageUrl);
}

function bilibiliQualityDescriptionMap(playInfo) {
  const data = playInfo?.data || {};
  const ids = Array.isArray(data.accept_quality) ? data.accept_quality : [];
  const descriptions = Array.isArray(data.accept_description) ? data.accept_description : [];
  const map = new Map();
  ids.forEach((id, index) => {
    if (descriptions[index]) {
      map.set(Number(id), String(descriptions[index]));
    }
  });
  for (const format of data.support_formats || []) {
    const description = format?.new_description || format?.display_desc || format?.description;
    if (description) {
      map.set(Number(format.quality), String(description));
    }
  }
  return map;
}

function bilibiliStreamFps(stream) {
  const value = String(stream?.frameRate || stream?.frame_rate || "0");
  const [numerator, denominator = "1"] = value.split("/");
  const fps = Number(numerator) / Number(denominator);
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 0;
}

function bilibiliQualityLabel(stream, descriptionMap, fallbackIndex, suffix = "DASH video-only") {
  const format = {
    quality: stream.id,
    height: stream.height,
    width: stream.width,
    fps: bilibiliStreamFps(stream),
    tbr: stream.bandwidth ? Number(stream.bandwidth) / 1000 : 0,
    format_note: descriptionMap.get(Number(stream.id)) || "",
    acodec: "mp4a",
    ext: "mp4"
  };
  return `${ytDlpQualityLabel(format, fallbackIndex, { bilibili: true })} ${suffix}`.trim();
}

function bilibiliStreamUrls(stream, pageUrl) {
  return normalizeVideoUrlList([
    stream?.baseUrl,
    stream?.base_url,
    ...(Array.isArray(stream?.backupUrl) ? stream.backupUrl : []),
    ...(Array.isArray(stream?.backup_url) ? stream.backup_url : [])
  ], pageUrl);
}

function preferredBilibiliDashAudio(dash) {
  const candidates = Array.isArray(dash?.audio) ? dash.audio.filter(Boolean) : [];
  return candidates.sort((left, right) => Number(right?.bandwidth || 0) - Number(left?.bandwidth || 0))[0] || null;
}

function buildBilibiliPlayInfoScannedVideoResults(playInfo, initialState, html, pageUrlInput) {
  const pageUrl = parseHttpUrl(pageUrlInput, "page URL").href;
  if (!playInfo?.data) {
    return [];
  }

  const data = playInfo.data;
  const sourcePage = pageUrl;
  const title = bilibiliTitleFromPage(html, initialState, pageUrl);
  const poster = bilibiliPosterFromPage(html, initialState, pageUrl);
  const descriptionMap = bilibiliQualityDescriptionMap(playInfo);
  const duration = Number(data.dash?.duration || data.timelength / 1000 || 0);
  const dashAudio = preferredBilibiliDashAudio(data.dash);
  const dashAudioUrls = bilibiliStreamUrls(dashAudio, pageUrl);
  const dashAudioBytes = dashAudio && Number.isFinite(duration) && duration > 0
    ? Math.round((Number(dashAudio.bandwidth || 0) * duration) / 8)
    : 0;
  const httpHeaders = normalizeVideoHttpHeaders({
    "User-Agent": browserUserAgent,
    Referer: pageUrl,
    Origin: "https://www.bilibili.com",
    Accept: "*/*"
  });
  const seen = new Set();
  const variants = [];

  const addVariant = (rawUrl, stream, index, options = {}) => {
    const streamUrls = bilibiliStreamUrls(stream, pageUrl);
    const resolvedUrl = resolveImageUrl(rawUrl, pageUrl) || streamUrls[0];
    if (!resolvedUrl || seen.has(resolvedUrl)) {
      return;
    }
    seen.add(resolvedUrl);

    const height = normalizeQualityHeight(stream?.height) ||
      qualityFromText(descriptionMap.get(Number(stream?.id)))?.qualityHeight ||
      null;
    const width = Number(stream?.width || 0) > 0 ? Math.round(Number(stream.width)) : null;
    const tier = bilibiliFormatTier({ quality: stream?.id, format: descriptionMap.get(Number(stream?.id)) });
    const bandwidth = Number(stream?.bandwidth || 0);
    const estimatedBytes = Number(stream?.size || options.size || 0) > 0
      ? Math.round(Number(stream.size || options.size))
      : (Number.isFinite(duration) && duration > 0 && bandwidth > 0
        ? Math.round((bandwidth * duration) / 8)
        : 0);

    variants.push({
      url: resolvedUrl,
      fallbackUrls: streamUrls.filter((url) => url !== resolvedUrl),
      referer: pageUrl,
      sourcePage,
      poster,
      filename: `${title}.mp4`,
      displaySize: formatByteCount(estimatedBytes),
      bytes: estimatedBytes,
      contentType: "video/mp4",
      protocol: "file",
      kind: options.kind || "bilibili-dash-video",
      originalLabel: descriptionMap.get(Number(stream?.id)) || stream?.codecs || null,
      qualityLabel: options.qualityLabel || bilibiliQualityLabel(stream, descriptionMap, index + 1),
      qualityHeight: height,
      qualityWidth: width,
      qualityTierLabel: tier.qualityTierLabel,
      qualityTierHeight: tier.qualityTierHeight,
      qualityRank: tier.qualityTierHeight || height || Math.round(bandwidth / 1000) || 0,
      qualityExplicit: true,
      extractor: "bilibili-page",
      extractorKey: "BiliBili",
      pageUrl,
      formatId: options.formatId || `bilibili-${stream?.id || index + 1}-${index + 1}`,
      formatSelector: options.formatId || `bilibili-${stream?.id || index + 1}-${index + 1}`,
      formatExt: "mp4",
      hasAudio: Boolean(options.hasAudio),
      requiresAudioMerge: Boolean(options.audioUrl),
      audioUrl: options.audioUrl || null,
      audioFallbackUrls: options.audioFallbackUrls || [],
      audioBytes: Number(options.audioBytes || 0) || 0,
      audioContentType: options.audioUrl ? "audio/mp4" : null,
      httpHeaders,
      bilibiliQualityId: Number(stream?.id || 0),
      fps: bilibiliStreamFps(stream),
      bitrate: Math.round(bandwidth / 1000)
    });
  };

  const progressiveEntries = Array.isArray(data.durl) ? data.durl.filter(Boolean) : [];
  progressiveEntries.forEach((entry, index) => {
    addVariant(entry.url || entry.baseUrl || entry.base_url, {
      id: data.quality,
      bandwidth: entry.size && duration > 0 ? (Number(entry.size) * 8) / duration : 0,
      size: entry.size
    }, index, {
      hasAudio: true,
      kind: "bilibili-progressive-video",
      qualityLabel: bilibiliQualityLabel({ id: data.quality }, descriptionMap, index + 1, ""),
      formatId: `bilibili-progressive-${index + 1}`
    });
  });

  const dashVideos = Array.isArray(data.dash?.video) ? data.dash.video : [];
  dashVideos.forEach((stream, index) => {
    addVariant(stream.baseUrl || stream.base_url, stream, progressiveEntries.length + index, {
      hasAudio: false,
      kind: "bilibili-dash-video",
      audioUrl: dashAudioUrls[0] || null,
      audioFallbackUrls: dashAudioUrls.slice(1),
      audioBytes: dashAudioBytes,
      qualityLabel: bilibiliQualityLabel(
        stream,
        descriptionMap,
        progressiveEntries.length + index + 1,
        dashAudioUrls.length ? "DASH + audio" : "DASH video-only"
      )
    });
  });

  if (dashAudioUrls.length) {
    variants.push({
      url: dashAudioUrls[0],
      fallbackUrls: dashAudioUrls.slice(1),
      referer: pageUrl,
      sourcePage,
      poster,
      filename: `${title}.mp3`,
      displaySize: formatByteCount(dashAudioBytes),
      bytes: dashAudioBytes,
      contentType: "audio/mpeg",
      protocol: "file",
      kind: "bilibili-audio",
      originalLabel: dashAudio?.codecs || "BiliBili audio",
      qualityLabel: "MP3 audio",
      qualityHeight: null,
      qualityWidth: null,
      qualityRank: -1,
      qualityExplicit: true,
      extractor: "bilibili-audio",
      extractorKey: "BiliBili",
      pageUrl,
      formatId: `bilibili-audio-${dashAudio?.id || "best"}`,
      formatSelector: `bilibili-audio-${dashAudio?.id || "best"}`,
      formatExt: "mp3",
      hasAudio: true,
      requiresAudioMerge: false,
      audioUrl: null,
      audioFallbackUrls: [],
      audioBytes: 0,
      audioContentType: null,
      httpHeaders,
      bitrate: Math.round(Number(dashAudio?.bandwidth || 0) / 1000)
    });
  }

  const qualityKeys = new Set();
  const sorted = variants
    .sort(compareYtDlpVariants)
    .filter((variant) => {
      const key = [variant.kind, variant.bilibiliQualityId, variant.qualityHeight, variant.fps, variant.qualityLabel].join(":");
      if (qualityKeys.has(key)) {
        return false;
      }
      qualityKeys.add(key);
      return true;
    });
  if (!sorted.length) {
    return [];
  }

  const selected = sorted[0];
  return [{
    ...selected,
    id: "video-1",
    listIndex: 1,
    selectedQualityUrl: selected.url,
    variants: sorted.map((variant, index) => ({
      ...variant,
      id: `video-1-quality-${index + 1}`
    }))
  }];
}

function buildBilibiliPageScannedVideoResults(html, pageUrlInput) {
  return buildBilibiliPlayInfoScannedVideoResults(
    extractWindowJsonAssignment(html, "window.__playinfo__"),
    extractWindowJsonAssignment(html, "window.__INITIAL_STATE__"),
    html,
    pageUrlInput
  );
}

function bilibiliPlayerIdentifiers(html, initialState, pageUrl) {
  const videoData = initialState?.videoData || {};
  const pageNumber = Math.max(1, Number(new URL(pageUrl).searchParams.get("p") || 1));
  const pages = Array.isArray(videoData.pages) ? videoData.pages : [];
  const selectedPage = pages.find((entry) => Number(entry?.page) === pageNumber) || pages[pageNumber - 1] || pages[0];
  const bvid = String(videoData.bvid || /"bvid"\s*:\s*"([^"]+)"/i.exec(html)?.[1] || "").trim();
  const cid = Number(selectedPage?.cid || videoData.cid || /"cid"\s*:\s*(\d+)/i.exec(html)?.[1] || 0);
  const aid = Number(videoData.aid || /"aid"\s*:\s*(\d+)/i.exec(html)?.[1] || 0);
  return {
    bvid: bvid || null,
    cid: Number.isFinite(cid) && cid > 0 ? Math.round(cid) : null,
    aid: Number.isFinite(aid) && aid > 0 ? Math.round(aid) : null
  };
}

async function requestBilibiliJson(url, pageUrl) {
  if (process.platform === "win32") {
    const script = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$headers = @{
  "User-Agent" = "${browserUserAgent}"
  "Referer" = $env:MAGIC_BOX_BILIBILI_REFERER
  "Accept" = "application/json, text/plain, */*"
}
$response = Invoke-WebRequest -Uri $env:MAGIC_BOX_BILIBILI_API_URL -Headers $headers -UseBasicParsing -TimeoutSec 20
Write-Output $response.Content
`;
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          MAGIC_BOX_BILIBILI_API_URL: url,
          MAGIC_BOX_BILIBILI_REFERER: pageUrl
        },
        maxBuffer: maxPageBytes * 2,
        timeout: 30 * 1000,
        windowsHide: true
      });
      return JSON.parse(stdout);
    } catch (error) {
      warnDiagnostic(`BiliBili PowerShell API request failed for ${url}: ${error.message}`);
    }
  }

  const response = await requestBuffer(url, {
    maxBytes: maxPageBytes,
    timeout: 15 * 1000,
    headers: {
      ...browserNavigationHeaders,
      Referer: pageUrl,
      Origin: "https://www.bilibili.com",
      Accept: "application/json, text/plain, */*"
    }
  });
  return JSON.parse(response.buffer.toString("utf8"));
}

function signBilibiliPlayUrl(apiUrl, navInfo, now = Date.now()) {
  const images = navInfo?.data?.wbi_img;
  const imageKeys = [images?.img_url, images?.sub_url].map((value) => {
    try {
      return new URL(value).pathname.split("/").pop().split(".")[0];
    } catch {
      return "";
    }
  }).join("");
  if (imageKeys.length < 64) {
    return null;
  }
  const permutation = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13
  ];
  const mixinKey = permutation.map((index) => imageKeys[index]).join("");
  const signedUrl = new URL(apiUrl);
  signedUrl.pathname = "/x/player/wbi/playurl";
  signedUrl.searchParams.set("wts", String(Math.round(now / 1000)));
  const sortedParams = new URLSearchParams([...signedUrl.searchParams]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value.replace(/[!'()*]/g, "")]));
  sortedParams.set("w_rid", createHash("md5").update(`${sortedParams.toString()}${mixinKey}`).digest("hex"));
  signedUrl.search = sortedParams.toString();
  return signedUrl.href;
}

async function requestBilibiliPlayInfo(html, pageUrl, initialStateInput = null, options = {}) {
  const initialState = initialStateInput || extractWindowJsonAssignment(html, "window.__INITIAL_STATE__");
  const identifiers = bilibiliPlayerIdentifiers(html, initialState, pageUrl);
  if (!identifiers.cid || (!identifiers.bvid && !identifiers.aid)) {
    return [];
  }

  const apiUrl = new URL("https://api.bilibili.com/x/player/playurl");
  if (identifiers.bvid) {
    apiUrl.searchParams.set("bvid", identifiers.bvid);
  } else {
    apiUrl.searchParams.set("avid", String(identifiers.aid));
  }
  apiUrl.searchParams.set("cid", String(identifiers.cid));
  apiUrl.searchParams.set("qn", "127");
  apiUrl.searchParams.set("fnver", "0");
  apiUrl.searchParams.set("fnval", "4048");
  apiUrl.searchParams.set("fourk", "1");

  const requestJson = options.requestJson || requestBilibiliJson;
  // Current BiliBili players use a signed WBI endpoint. Keep the legacy
  // endpoint as a fallback for pages/accounts where the WBI request fails.
  try {
    const navInfo = await requestJson("https://api.bilibili.com/x/web-interface/nav", pageUrl);
    const signedUrl = signBilibiliPlayUrl(apiUrl.href, navInfo, options.now);
    if (signedUrl) {
      const signedPlayInfo = await requestJson(signedUrl, pageUrl);
      if (Number(signedPlayInfo?.code || 0) === 0) {
        const signedResults = buildBilibiliPlayInfoScannedVideoResults(signedPlayInfo, initialState, html, pageUrl);
        if (signedResults.length) {
          return signedResults;
        }
      }
    }
  } catch {
    // A failed signing/metadata request must not discard playable legacy formats.
  }
  const playInfo = await requestJson(apiUrl.href, pageUrl);
  if (Number(playInfo?.code || 0) !== 0 || !playInfo?.data) {
    return [];
  }
  return buildBilibiliPlayInfoScannedVideoResults(playInfo, initialState, html, pageUrl);
}

function bilibiliBvidFromUrl(pageUrl) {
  try {
    return /(?:^|\/)(BV[0-9A-Za-z]+)(?:\/|$)/i.exec(new URL(pageUrl).pathname)?.[1] || "";
  } catch {
    return "";
  }
}

async function requestBilibiliApiResults(pageUrl) {
  const bvid = bilibiliBvidFromUrl(pageUrl);
  if (!bvid) {
    return [];
  }

  const viewUrl = new URL("https://api.bilibili.com/x/web-interface/view");
  viewUrl.searchParams.set("bvid", bvid);
  const metadata = await requestBilibiliJson(viewUrl.href, pageUrl);
  if (Number(metadata?.code || 0) !== 0 || !metadata?.data) {
    return [];
  }
  const initialState = { videoData: metadata.data };
  return requestBilibiliPlayInfo("", pageUrl, initialState);
}

function mergeBilibiliVideoResults(...resultSets) {
  const seen = new Set();
  const variants = resultSets.flatMap((results) => results.flatMap((video) => video.variants || [video]))
    .sort(compareYtDlpVariants)
    .filter((variant) => {
      const key = `${variant.kind}:${variant.bilibiliQualityId}:${variant.qualityHeight}:${variant.fps}:${variant.qualityLabel}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  if (!variants.length) {
    return [];
  }
  return [{
    ...variants[0],
    id: "video-1",
    listIndex: 1,
    selectedQualityUrl: variants[0].url,
    variants: variants.map((variant, index) => ({ ...variant, id: `video-1-quality-${index + 1}` }))
  }];
}

async function buildBilibiliPageOrApiResults(html, pageUrl, options = {}) {
  const embeddedResults = buildBilibiliPageScannedVideoResults(html, pageUrl);
  try {
    const apiResults = await requestBilibiliPlayInfo(html, pageUrl, null, options);
    return mergeBilibiliVideoResults(embeddedResults, apiResults);
  } catch (error) {
    warnDiagnostic(`BiliBili player API failed for ${pageUrl}: ${error.message}`);
    return embeddedResults;
  }
}

async function extractBilibiliVideosWithSiteSession(pageUrlInput, options = {}) {
  let pageUrl = parseVideoPageInput(pageUrlInput).href;
  if (!isBilibiliUrl(pageUrl)) throw new Error("Choose a BiliBili video link.");
  if (!bilibiliBvidFromUrl(pageUrl)) {
    const page = await (options.requestPage || requestBuffer)(pageUrl, {
      headers: browserNavigationHeaders, timeout: 12000, maxBytes: maxPageBytes, signal: options.signal
    });
    if (!isBilibiliUrl(page.finalUrl)) {
      throw Object.assign(new Error("The BiliBili link redirected to another site."), { code: "VIDEO_VERIFICATION_REDIRECT" });
    }
    pageUrl = parseVideoPageInput(page.finalUrl).href;
  }
  const bvid = bilibiliBvidFromUrl(pageUrl);
  if (!bvid) throw Object.assign(new Error("Copy the BiliBili video's BV link, rather than a profile or home page."), { code: "BILIBILI_NOT_VIDEO" });
  const part = Math.max(1, Number(new URL(pageUrl).searchParams.get("p") || 1));
  const visible = options.verifyInBrowser === true;
  const capture = await (options.capturePage || captureVerifiedVideoPage)(pageUrl, {
    profileRoot: options.profileRoot,
    headless: !visible,
    timeoutMs: visible ? 150000 : 40000,
    signal: options.signal,
    async inspectPage({ html, finalUrl, userAgent, evaluate }) {
      const finalPart = Math.max(1, Number(new URL(finalUrl).searchParams.get("p") || 1));
      if (bilibiliBvidFromUrl(finalUrl) !== bvid || finalPart !== part) {
        throw Object.assign(new Error("The browser switched to another BiliBili video or part. Scan that video's link separately."), { code: "VIDEO_VERIFICATION_REDIRECT" });
      }
      const requestJson = async (url) => {
        const target = new URL(url);
        if (target.origin !== "https://api.bilibili.com" || ![
          "/x/web-interface/nav", "/x/web-interface/view", "/x/player/playurl", "/x/player/wbi/playurl"
        ].includes(target.pathname)) throw new Error("Unsupported BiliBili player request.");
        // Fetch within the signed-in browser. Cookies stay in its own profile;
        // they are never exported, decrypted, or sent back to the frontend.
        const response = await evaluate(`(async () => {
          if (location.origin !== "https://www.bilibili.com" || !location.pathname.includes(${JSON.stringify(`/video/${bvid}`)}) || Number(new URL(location.href).searchParams.get("p") || 1) !== ${part}) return { wrongPage: true };
          try {
            const response = await fetch(${JSON.stringify(url)}, { credentials: "include", signal: AbortSignal.timeout(8000) });
            if (!response.ok) return { status: response.status };
            const data = await response.json();
            if (${JSON.stringify(target.pathname)} === "/x/web-interface/nav") return { data: { code: data.code, data: { isLogin: data.data?.isLogin, wbi_img: data.data?.wbi_img } } };
            return { data };
          } catch { return { status: 0 }; }
        })()`);
        if (response?.wrongPage) throw Object.assign(new Error("The verification browser switched videos."), { code: "VIDEO_VERIFICATION_REDIRECT" });
        if (!response?.data) throw Object.assign(new Error("BiliBili did not accept the player request. Complete verification in the browser and retry."), { code: "BILIBILI_SESSION_REQUIRED" });
        return response.data;
      };
      let navInfo;
      try { navInfo = await requestJson("https://api.bilibili.com/x/web-interface/nav"); }
      catch (error) { if (visible && error?.code === "BILIBILI_SESSION_REQUIRED") return null; throw error; }
      if (navInfo?.data?.isLogin !== true) {
        if (visible) return null;
        throw Object.assign(new Error("The saved BiliBili login has expired. Sign in in the dedicated browser to restore available qualities."), { code: "BILIBILI_SESSION_REQUIRED" });
      }
      const metadata = await requestJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
      if (Number(metadata?.code) !== 0 || metadata?.data?.bvid !== bvid) {
        throw Object.assign(new Error("BiliBili did not return metadata for the requested video."), { code: "BILIBILI_SESSION_REQUIRED" });
      }
      const pages = metadata.data.pages;
      if (Array.isArray(pages) && !pages.some((entry) => Number(entry?.page) === part)) {
        throw Object.assign(new Error("This BiliBili video does not contain the requested part."), { code: "BILIBILI_NOT_VIDEO" });
      }
      const initialState = { videoData: metadata.data };
      const videos = await requestBilibiliPlayInfo(html, pageUrl, initialState, {
        requestJson: (url) => new URL(url).pathname === "/x/web-interface/nav" ? navInfo : requestJson(url)
      });
      if (!videos.length) throw Object.assign(new Error("BiliBili did not expose a playable stream for this signed-in account."), { code: "VIDEO_VERIFIED_NO_MEDIA" });
      const withHeaders = (video) => ({
        ...video,
        httpHeaders: { ...video.httpHeaders, "User-Agent": userAgent || browserUserAgent },
        ...(video.variants ? { variants: video.variants.map(withHeaders) } : {})
      });
      return { videos: videos.map(withHeaders) };
    }
  });
  if (!capture?.inspection?.videos?.length) throw Object.assign(new Error("BiliBili browser verification did not return playable video data."), { code: "VIDEO_VERIFIED_NO_MEDIA" });
  return { pageUrl, videos: capture.inspection.videos };
}

async function fetchBilibiliHtmlWithPowerShell(pageUrl) {
  if (process.platform !== "win32") {
    return null;
  }

  const script = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$headers = @{
  "User-Agent" = "${browserUserAgent}"
  "Accept-Language" = "en-US,en;q=0.9"
}
$response = Invoke-WebRequest -Uri $env:MAGIC_BOX_BILIBILI_URL -Headers $headers -UseBasicParsing -TimeoutSec 30
Write-Output $response.Content
`;

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        MAGIC_BOX_BILIBILI_URL: pageUrl
      },
      maxBuffer: maxPageBytes * 4,
      timeout: videoPageRequestTimeoutMs + 15000,
      windowsHide: true
    });
    return stdout;
  } catch (error) {
    warnDiagnostic(`BiliBili PowerShell fetch failed for ${pageUrl}: ${error.message}`);
    return null;
  }
}

async function extractBilibiliVideosFromPage(pageUrl) {
  if (!isBilibiliUrl(pageUrl)) {
    return [];
  }

  try {
    const apiResults = await requestBilibiliApiResults(pageUrl);
    if (apiResults.length) {
      return apiResults;
    }
  } catch (error) {
    warnDiagnostic(`BiliBili fast API scan failed for ${pageUrl}: ${error.message}`);
  }

  let finalUrl = pageUrl;
  let html = "";
  let fetchError = null;
  try {
    const page = await requestBuffer(pageUrl, {
      maxBytes: maxPageBytes,
      timeout: videoPageRequestTimeoutMs,
      headers: browserNavigationHeaders
    });
    finalUrl = page.finalUrl || pageUrl;
    html = page.buffer.toString("utf8");
    const directResults = await buildBilibiliPageOrApiResults(html, finalUrl);
    if (directResults.length) {
      return directResults;
    }
  } catch (error) {
    fetchError = error;
  }

  const powerShellHtml = await fetchBilibiliHtmlWithPowerShell(pageUrl);
  if (powerShellHtml) {
    const powerShellResults = await buildBilibiliPageOrApiResults(powerShellHtml, finalUrl);
    if (powerShellResults.length) {
      return powerShellResults;
    }
  }

  if (fetchError && !html) {
    warnDiagnostic(`BiliBili direct fetch failed for ${pageUrl}: ${fetchError.message}`);
  }

  const renderedHtml = await renderPageWithEdge(pageUrl, {
    timeout: Math.min(renderedPageTimeoutMs, 90 * 1000),
    virtualTimeBudget: 20 * 1000
  });
  return renderedHtml
    ? buildBilibiliPageOrApiResults(renderedHtml, finalUrl)
    : [];
}

function pageTitleFromHtml(html, fallback) {
  const metaTitle = extractMetaContents(html, fallback, /(^|:|\s)(title|name)(:|\s|$)/i)[0];
  const titleText = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "";
  const rawTitle = metaTitle && !/^https?:/i.test(metaTitle)
    ? metaTitle
    : decodeHtmlAttribute(titleText.replace(/<[^>]+>/g, " "));
  return sanitizeFileName(rawTitle.trim() || fallback);
}

function videoSiteHeaders(pageUrl, userAgent = browserUserAgent) {
  const parsed = new URL(pageUrl);
  return normalizeVideoHttpHeaders({
    "User-Agent": userAgent,
    Referer: pageUrl,
    Origin: parsed.origin,
    Accept: "*/*"
  });
}

function hostnameIncludes(pageUrl, token) {
  try {
    return new URL(pageUrl).hostname.toLowerCase().includes(token);
  } catch {
    return false;
  }
}

function isMissAvUrl(pageUrl) {
  return hostnameIncludes(pageUrl, "missav");
}

function isJavtifulUrl(pageUrl) {
  return hostnameIncludes(pageUrl, "javtiful");
}

function isDouyinUrl(pageUrl) {
  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase();
    return hostname === "douyin.com" ||
      hostname.endsWith(".douyin.com") ||
      hostname === "iesdouyin.com" ||
      hostname.endsWith(".iesdouyin.com");
  } catch {
    return false;
  }
}

function isPreviewVideoCandidate(video) {
  try {
    const parsed = new URL(video?.url || "");
    return /(?:^|\/)(?:previews?|trailers?)(?:\/|$)|(?:^|[_-])preview(?:[_-]|\.)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function buildSitePageResults(candidates, pageUrl, metadata) {
  if (!candidates.length) {
    return [];
  }

  // Playlist discovery needs the same browser identity and page referer as
  // playback. Adding them only after expansion can hide protected HD variants.
  const prepared = candidates.map((video) => ({
    ...video,
    referer: pageUrl,
    sourcePage: pageUrl,
    httpHeaders: { ...metadata.httpHeaders, ...video.httpHeaders }
  }));
  const expanded = await expandVideoCandidates(prepared, pageUrl);
  const expandedMasters = new Set(expanded
    .filter((video) => video.qualitySource === "hls-manifest")
    .flatMap((video) => [video.variantGroup, video.hlsMasterUrl].filter(Boolean)));
  const decorated = expanded
    .filter((video) => !isPreviewVideoCandidate(video) && !expandedMasters.has(video.url))
    .map((video) => ({
      ...video,
      referer: pageUrl,
      sourcePage: pageUrl,
      poster: video.poster || metadata.poster || null,
      filename: video.filename || `${metadata.title}.mp4`,
      variantGroup: metadata.variantGroup,
      extractor: metadata.extractor,
      extractorKey: metadata.extractorKey,
      pageUrl,
      httpHeaders: metadata.httpHeaders,
      impersonate: metadata.impersonate || null,
      sourceRank: Math.max(Number(video.sourceRank || 0), 100)
    }));
  if (metadata.probeUnknownHls) {
    const unknown = decorated.filter((video) => !video.qualityHeight && looksLikeHlsPlaylistUrl(video.url)).slice(0, 3);
    const ffprobe = unknown.length ? await resolveMediaTool("ffprobe") : null;
    if (ffprobe) {
      await mapWithConcurrency(unknown, 2, async (video) => {
        const dimensions = await probeVideoDimensions(video, { ffprobePath: ffprobe.command, signal: metadata.signal });
        if (dimensions) Object.assign(video, dimensions);
      });
    }
  }
  const seenQualities = new Set();
  const deduped = metadata.dedupeQuality
    ? decorated.filter((video) => {
        const key = video.qualityHeight || video.qualityLabel;
        if (!key) {
          // An unlabelled source may be the original rendition. The presence
          // of a named 720p alternative does not make that source redundant.
          return true;
        }
        if (seenQualities.has(String(key))) {
          return false;
        }
        seenQualities.add(String(key));
        return true;
      })
    : decorated;
  return buildScannedVideoResults(primaryVideoCandidates(deduped, pageUrl));
}

async function buildMissAvPageScannedVideoResults(html, finalUrl, metadata = {}) {
  const packedText = extractPackedScriptText(html);
  const packedCandidates = packedText ? extractVideoUrls(packedText, finalUrl) : [];
  const pageCandidates = extractVideoUrls(html, finalUrl)
    .filter((video) => !video.isNoisy && !isPreviewVideoCandidate(video));
  const candidates = [...packedCandidates, ...pageCandidates.filter((video) =>
    !packedCandidates.length || /^(?:main-video|player-video)/.test(String(video.kind || ""))
  )];
  return buildSitePageResults(candidates, finalUrl, {
    title: pageTitleFromHtml(html, "missav-video"),
    poster: extractPagePoster(html, finalUrl),
    variantGroup: `missav:${finalUrl}`,
    extractor: "missav-page",
    extractorKey: "MissAV",
    dedupeQuality: true,
    probeUnknownHls: Boolean(metadata.probeUnknownHls),
    signal: metadata.signal,
    impersonate: "chrome",
    httpHeaders: videoSiteHeaders(finalUrl, metadata.userAgent || browserUserAgent)
  });
}

async function extractMissAvVideosFromPage(pageUrl) {
  if (!isMissAvUrl(pageUrl)) {
    return [];
  }

  const page = await requestBuffer(pageUrl, {
    maxBytes: maxPageBytes,
    timeout: videoPageRequestTimeoutMs,
    headers: browserNavigationHeaders
  });
  const finalUrl = page.finalUrl || pageUrl;
  const html = page.buffer.toString("utf8");
  if (browserVerificationPageState(html, finalUrl) === "challenge") throw accessBlockedVideoError();
  return buildMissAvPageScannedVideoResults(html, finalUrl, { probeUnknownHls: true });
}

async function buildJavtifulPageScannedVideoResults(html, pageUrl, metadata = {}) {
  const candidates = extractVideoUrls(html, pageUrl)
    .filter((video) =>
      !video.isNoisy &&
      !isPreviewVideoCandidate(video) &&
      looksLikeVideoSourceUrl(video.url)
    );
  const mainCandidates = candidates.filter((video) =>
    /main-video|player-video/i.test(String(video.kind || ""))
  );
  return buildSitePageResults(mainCandidates.length ? mainCandidates : candidates, pageUrl, {
    title: metadata.title || pageTitleFromHtml(html, "javtiful-video"),
    poster: metadata.poster || extractPagePoster(html, pageUrl),
    variantGroup: `javtiful:${pageUrl}`,
    extractor: "javtiful-page",
    extractorKey: "Javtiful",
    httpHeaders: videoSiteHeaders(pageUrl, metadata.userAgent || browserUserAgent)
  });
}

async function extractJavtifulVideosFromPage(pageUrl) {
  if (!isJavtifulUrl(pageUrl)) {
    return [];
  }

  const page = await requestBuffer(pageUrl, {
    maxBytes: maxPageBytes,
    timeout: videoPageRequestTimeoutMs,
    headers: browserNavigationHeaders
  });
  const finalUrl = page.finalUrl || pageUrl;
  const html = page.buffer.toString("utf8");
  const title = pageTitleFromHtml(html, "javtiful-video");
  const poster = extractPagePoster(html, finalUrl);
  let results = await buildJavtifulPageScannedVideoResults(html, finalUrl, { title, poster });

  if (!results.length) {
    const renderedHtml = await renderPageWithEdge(finalUrl, {
      timeout: Math.min(renderedPageTimeoutMs, 90 * 1000),
      virtualTimeBudget: 30 * 1000
    });
    if (renderedHtml) {
      results = await buildJavtifulPageScannedVideoResults(renderedHtml, finalUrl, { title, poster });
    }
  }
  return results;
}

function scriptContentById(html, id) {
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    const openingTag = match[0].slice(0, match[0].indexOf(">") + 1);
    if (parseAttributes(openingTag).get("id") === id) {
      return decodeHtmlAttribute(match[1].trim());
    }
  }
  return "";
}

function douyinItemId(value) {
  return String(value?.aweme_id || value?.awemeId || value?.group_id_str || value?.item_id || value?.itemId || value?.id || "");
}

function collectDouyinVideoItems(value, items = [], seen = new Set(), depth = 0) {
  if (!value || depth > 32) {
    return items;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectDouyinVideoItems(item, items, seen, depth + 1));
    return items;
  }
  if (typeof value !== "object") {
    return items;
  }

  const video = value.video;
  const itemId = douyinItemId(value);
  const playAddress = video?.play_addr || video?.playAddr || video?.play_addr_h264 || video?.play_addr_265;
  const bitrates = video?.bit_rate || video?.bitRate || video?.bitRateList;
  const hasPlayableAddress = douyinAddressUrls(playAddress, "https://www.douyin.com/").length ||
    (Array.isArray(bitrates) && bitrates.some((format) =>
      douyinAddressUrls(format?.play_addr || format?.playAddr, "https://www.douyin.com/").length
    ));
  if (video && hasPlayableAddress && itemId && !seen.has(itemId)) {
    seen.add(itemId);
    items.push(value);
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key !== "video") {
      collectDouyinVideoItems(nested, items, seen, depth + 1);
    }
  }
  return items;
}

function douyinAddressUrls(address, pageUrl) {
  const values = typeof address === "string" ? [address]
    : Array.isArray(address) ? address.map((entry) => typeof entry === "string" ? entry : entry?.src || entry?.url)
      : address?.url_list || address?.urlList || address?.src || address?.url || [];
  return normalizeVideoUrlList(typeof values === "string" ? [values] : values, pageUrl);
}

function douyinPageData(html) {
  const payloads = [];
  for (const name of ["window._ROUTER_DATA", "window.RENDER_DATA", "window.__INITIAL_STATE__"]) {
    try {
      const data = extractWindowJsonAssignment(html, name);
      if (data) payloads.push(data);
    } catch {
      // A stale/malformed bootstrap must not hide another valid page payload.
    }
  }
  for (const id of ["_ROUTER_DATA", "RENDER_DATA", "__NEXT_DATA__"]) {
    let text = scriptContentById(html, id);
    for (let attempt = 0; text && attempt < 3; attempt++) {
      try {
        const data = JSON.parse(text);
        if (typeof data === "string") {
          text = data;
          continue;
        }
        if (data && typeof data === "object") payloads.push(data);
        break;
      } catch {
        try {
          const decoded = decodeURIComponent(text);
          if (decoded === text) break;
          text = decoded;
        } catch {
          break;
        }
      }
    }
  }
  return payloads;
}

function douyinQualityMetadata(video, format, address, fallbackIndex) {
  const rawWidth = Number(address?.width || format?.width || video?.width || 0);
  const rawHeight = Number(address?.height || format?.height || video?.height || 0);
  const shortEdge = rawWidth > 0 && rawHeight > 0 ? Math.min(rawWidth, rawHeight) : rawHeight;
  const qualityHeight = normalizeQualityHeight(shortEdge) ||
    qualityFromText(format?.gear_name || format?.gearName || format?.quality_type)?.qualityHeight ||
    null;
  const bitrate = Number(format?.bit_rate || format?.bitRate || 0);
  return {
    qualityLabel: qualityHeight
      ? `${qualityHeight}p`
      : (qualityFromText(format?.gear_name || format?.gearName || "")?.qualityLabel || `Source ${fallbackIndex}`),
    qualityHeight,
    qualityWidth: rawWidth > 0 ? Math.round(rawWidth) : null,
    qualityRank: (qualityHeight || 0) * 1_000_000 + (Number.isFinite(bitrate) ? bitrate : 0),
    qualityExplicit: true,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate / 1000) : 0
  };
}

function buildDouyinShareScannedVideoResults(html, pageUrlInput, requestedVideoId = "") {
  return buildDouyinDataScannedVideoResults(douyinPageData(html), pageUrlInput, requestedVideoId);
}

function buildDouyinDataScannedVideoResults(data, pageUrlInput, requestedVideoId = "") {
  const pageUrl = parseHttpUrl(pageUrlInput, "page URL").href;
  const items = collectDouyinVideoItems(data);
  const targetId = requestedVideoId || douyinVideoIdFromUrl(pageUrl);
  const item = targetId ? items.find((entry) => douyinItemId(entry) === targetId) : items[0];
  if (!item?.video) {
    return [];
  }
  const video = item.video;
  const itemId = douyinItemId(item);
  const title = sanitizeFileName(item.desc || item.title || `douyin-${itemId}`);
  const poster = douyinAddressUrls(video.cover || video.origin_cover || video.originCover || video.dynamic_cover || video.dynamicCover, pageUrl)[0] || null;
  const bitrates = video.bit_rate || video.bitRate || video.bitRateList;
  const formats = (Array.isArray(bitrates) ? bitrates : []).filter((format) =>
    douyinAddressUrls(format?.play_addr || format?.playAddr, pageUrl).length
  );
  const directAddress = video.play_addr || video.playAddr || video.play_addr_h264 || video.play_addr_265;
  // Some payloads contain a higher-resolution original outside the bitrate list.
  // Only claim that quality when the address itself supplies dimensions.
  const directQuality = douyinQualityMetadata({}, {}, directAddress, 1).qualityHeight || 0;
  const highestListed = Math.max(0, ...formats.map((format) =>
    douyinQualityMetadata(video, format, format?.play_addr || format?.playAddr, 1).qualityHeight || 0
  ));
  if (douyinAddressUrls(directAddress, pageUrl).length && (!formats.length || directQuality > highestListed)) {
    formats.push({ play_addr: directAddress });
  }
  const headers = videoSiteHeaders(pageUrl, "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36");
  const seen = new Set();
  const variants = formats.map((format, index) => {
    const address = format?.play_addr || format?.playAddr || video.play_addr || video.playAddr;
    const urls = douyinAddressUrls(address, pageUrl);
    const url = urls[0];
    if (!url || seen.has(url)) {
      return null;
    }
    seen.add(url);
    const bytes = Number(address?.data_size || address?.dataSize || format?.data_size || format?.dataSize || 0);
    return {
      url,
      fallbackUrls: urls.slice(1),
      referer: pageUrl,
      sourcePage: pageUrl,
      poster,
      filename: `${title}.mp4`,
      displaySize: formatByteCount(bytes),
      bytes: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0,
      contentType: "video/mp4",
      protocol: "file",
      kind: "douyin-video",
      originalLabel: format?.gear_name || format?.gearName || null,
      ...douyinQualityMetadata(video, format, address, index + 1),
      extractor: "douyin-share",
      extractorKey: "Douyin",
      pageUrl,
      formatId: String(format?.gear_name || format?.gearName || format?.quality_type || index + 1),
      formatExt: "mp4",
      hasAudio: true,
      duration: Number(video.duration || 0) > 0 ? Number(video.duration) / 1000 : null,
      httpHeaders: headers
    };
  }).filter(Boolean).sort((left, right) => videoVariantRank(right) - videoVariantRank(left));

  if (!variants.length) {
    return [];
  }
  const selected = variants[0];
  return [{
    ...selected,
    id: "video-1",
    listIndex: 1,
    selectedQualityUrl: selected.url,
    variants: variants.map((variant, index) => ({
      ...variant,
      id: `video-1-quality-${index + 1}`
    }))
  }];
}

function douyinVideoIdFromUrl(pageUrl) {
  try {
    const parsed = new URL(pageUrl);
    const pathId = /\/(?:video|share\/video)\/(\d+)(?:\/|$)/i.exec(parsed.pathname)?.[1];
    if (pathId) return pathId;
    for (const key of ["modal_id", "aweme_id", "item_id", "itemId", "vid"]) {
      const value = parsed.searchParams.get(key);
      if (/^\d+$/.test(value || "")) return value;
    }
    return "";
  } catch {
    return "";
  }
}

async function extractDouyinVideosFromPage(pageUrl, options = {}) {
  if (!isDouyinUrl(pageUrl)) {
    return [];
  }

  const checkCancelled = () => {
    if (options.signal?.aborted) throw Object.assign(new Error("Douyin scan was cancelled."), { code: "VIDEO_VERIFICATION_CANCELLED" });
  };
  checkCancelled();
  const verifying = options.verifyInBrowser === true;
  const requestPage = options.requestPage || requestBuffer;
  const mobileHeaders = {
    ...browserNavigationHeaders,
    "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36"
  };
  let videoId = douyinVideoIdFromUrl(pageUrl);
  const attachSource = (results) => results.map((video) => ({
      ...video,
      pageUrl,
      sourcePage: pageUrl,
      variants: video.variants.map((variant) => ({
        ...variant,
        pageUrl,
        sourcePage: pageUrl
      }))
    }));
  const attempted = new Set();
  const deadline = Date.now() + 28000;
  let lastError = null;
  let fetchedPage = false;
  const tryPage = async (url, headers) => {
    checkCancelled();
    if (attempted.has(url) || Date.now() >= deadline) return [];
    attempted.add(url);
    try {
      const page = await requestPage(url, {
        maxBytes: maxPageBytes,
        timeout: Math.max(1, Math.min(videoPageRequestTimeoutMs, 12000, deadline - Date.now())),
        headers,
        signal: options.signal
      });
      checkCancelled();
      fetchedPage = true;
      const finalUrl = page.finalUrl || url;
      if (!isDouyinUrl(finalUrl)) {
        throw Object.assign(new Error("The Douyin link redirected to another site. Copy the video's Douyin link and try again."), { code: "VIDEO_VERIFICATION_REDIRECT" });
      }
      const html = page.buffer.toString("utf8");
      videoId ||= douyinVideoIdFromUrl(finalUrl);
      // Only use a page's own route metadata, never an ID from recommendations.
      videoId ||= /snssdk\d+:\/\/aweme\/detail\/(\d+)/i.exec(html)?.[1] || "";
      if (!videoId) {
        for (const data of douyinPageData(html)) {
          const route = data?.loaderData?.["video_(id)/page"];
          if (/^\d{5,30}$/.test(String(route?.itemId || ""))) videoId = String(route.itemId);
        }
      }
      if (verifying || !videoId) return [];
      const results = buildDouyinShareScannedVideoResults(html, finalUrl, videoId);
      if (results.length) return attachSource(results);
    } catch (error) {
      checkCancelled();
      if (error?.code === "VIDEO_VERIFICATION_REDIRECT") throw error;
      lastError = error;
    }
    return [];
  };

  // A shared link can carry the context required to expose the video. Parse its
  // resolved response before issuing a fresh request without those parameters.
  const initialHeaders = /^(?:www\.)?douyin\.com$/i.test(new URL(pageUrl).hostname)
    ? browserNavigationHeaders : mobileHeaders;
  let results = verifying && videoId ? [] : await tryPage(pageUrl, initialHeaders);
  if (results.length) return results;
  if (videoId) {
    if (!verifying) {
      results = await tryPage(`https://www.iesdouyin.com/share/video/${videoId}/`, mobileHeaders);
      if (results.length) return results;
      results = await tryPage(`https://www.douyin.com/video/${videoId}`, browserNavigationHeaders);
      if (results.length) return results;
    }
    try {
      checkCancelled();
      const capture = await (options.captureVideoData || captureDouyinVideoData)(videoId, {
        headless: !verifying,
        profileRoot: options.profileRoot,
        signal: options.signal,
        timeoutMs: verifying ? 150000 : 25000,
        inspectPage: ({ html, finalUrl }) => {
          if (new URL(finalUrl).origin !== "https://www.douyin.com") return null;
          const item = collectDouyinVideoItems(douyinPageData(html)).find(entry => douyinItemId(entry) === videoId);
          return item ? { aweme_detail: item } : null;
        }
      });
      checkCancelled();
      if (capture?.data) {
        const canonicalUrl = `https://www.douyin.com/video/${videoId}`;
        const videos = buildDouyinDataScannedVideoResults(capture.data, canonicalUrl, videoId);
        const withHeaders = (video) => ({
          ...video,
          httpHeaders: { ...video.httpHeaders, "User-Agent": capture.userAgent || browserUserAgent, Referer: canonicalUrl },
          ...(video.variants ? { variants: video.variants.map(withHeaders) } : {})
        });
        if (videos.length) return attachSource(videos.map(withHeaders));
      }
    } catch (error) {
      checkCancelled();
      if (verifying || ["VIDEO_VERIFICATION_BUSY", "VIDEO_VERIFICATION_CANCELLED"].includes(error?.code)) throw error;
      lastError = error;
      warnDiagnostic(`Douyin browser extraction failed: ${videoErrorCode(error)}`);
    }
  }
  if (verifying) {
    if (!videoId) {
      if (lastError) throw lastError;
      throw Object.assign(new Error("This Douyin link does not identify a video. Use Share > Copy link on the video, or copy its /video/ address."), { code: "DOUYIN_NOT_VIDEO" });
    }
    throw Object.assign(new Error("Douyin's browser did not return playable data for this video. Complete any login or verification, open the requested video and retry."), { code: "VIDEO_VERIFIED_NO_MEDIA" });
  }
  if (!fetchedPage && lastError) throw lastError;
  return [];
}

async function extractSiteAwareVideos(pageUrl, options = {}) {
  if (isBilibiliUrl(pageUrl)) {
    return extractBilibiliVideosFromPage(pageUrl);
  }
  if (isDouyinUrl(pageUrl)) {
    return extractDouyinVideosFromPage(pageUrl, options);
  }
  if (isMissAvUrl(pageUrl)) {
    return extractMissAvVideosFromPage(pageUrl);
  }
  if (isJavtifulUrl(pageUrl)) {
    return extractJavtifulVideosFromPage(pageUrl);
  }
  return [];
}

function supportedVideoSiteName(pageUrl) {
  if (isBilibiliUrl(pageUrl)) {
    return "Bilibili";
  }
  if (isDouyinUrl(pageUrl)) {
    return "Douyin";
  }
  if (isMissAvUrl(pageUrl)) {
    return "MissAV";
  }
  if (isJavtifulUrl(pageUrl)) {
    return "Javtiful";
  }
  return null;
}

function buildScannedVideoResults(playableVideos) {
  if (!playableVideos.length) {
    return [];
  }

  const primary = playableVideos[0];
  const seen = new Set();
  const variants = playableVideos
    .filter((candidate) => isVideoQualityVariant(primary, candidate))
    .filter((candidate) => {
      if (seen.has(candidate.url)) {
        return false;
      }
      seen.add(candidate.url);
      return true;
    })
    .map(normalizedVideoVariant)
    .sort((left, right) => videoVariantRank(right) - videoVariantRank(left));

  const variantList = variants.length ? variants : [normalizedVideoVariant(primary, 0)];
  const selected = variantList[0];
  return [{
    ...primary,
    ...selected,
    id: "video-1",
    listIndex: 1,
    poster: selected.poster || primary.poster || null,
    originalLabel: primary.originalLabel || selected.originalLabel || null,
    selectedQualityUrl: selected.url,
    qualityLabel: selected.qualityLabel,
    qualityHeight: selected.qualityHeight,
    qualityRank: selected.qualityRank,
    variants: variantList.map((variant, index) => ({
      ...variant,
      id: `video-1-quality-${index + 1}`
    }))
  }];
}

function videoSiteScanResult(pageUrl, videos, { browser, cookiesFile, usedLogin = false, authenticationWarning = null, authenticationMethod = null } = {}) {
  const bilibili = isBilibiliUrl(pageUrl);
  const highestQuality = videos.flatMap((video) => video.variants || [video])
    .reduce((height, video) => Math.max(height, Number(video.qualityTierHeight || video.qualityHeight) || 0), 0);
  const needsBilibiliLogin = bilibili && highestQuality > 0 && highestQuality <= 480 && authenticationMethod !== "verification-browser";
  const verificationMessage = needsBilibiliLogin
    ? `BiliBili returned at most ${highestQuality}p. If the site offers higher qualities, sign in in the dedicated browser and rescan. That session is saved locally for later videos.`
    : null;
  const qualityWarning = bilibili && highestQuality > 0 && highestQuality <= 480
    ? `Bilibili exposed at most ${highestQuality}p to this ${usedLogin ? "session" : "public scan"}. ${needsBilibiliLogin ? "Enable site login or use the BiliBili sign-in button below to request higher qualities." : "This signed-in account was checked for its highest available quality."} Available quality depends on the upload and your account; original/4K is not guaranteed.`
    : null;
  return {
    pageUrl,
    count: videos.length,
    videos: usedLogin ? videoAuthentication.bind(videos, cookiesFile) : videos,
    ...(needsBilibiliLogin ? { canVerifyInBrowser: true, verificationReason: "bilibili-login", verificationMessage } : {}),
    ...(bilibili || isDouyinUrl(pageUrl) ? {
      site: bilibili ? "bilibili" : "douyin",
      ...(bilibili ? { bvid: bilibiliBvidFromUrl(pageUrl) } : {}),
      authenticated: usedLogin,
      authenticationMethod: usedLogin ? authenticationMethod || (cookiesFile ? "cookies-file" : "browser") : null,
      browser: usedLogin && !cookiesFile ? browser : null,
      requestedBrowser: authenticationWarning && !cookiesFile ? browser : null,
      authenticationWarning,
      qualityWarning
    } : {})
  };
}

async function scanVideoPage(pageUrlInput, options = {}, adapters = {}) {
  const pageUrl = parseVideoPageInput(pageUrlInput, "page URL").href;
  const profileRoot = path.join(path.dirname(settingsFilePath()), "video-verification");
  const scanBilibiliSession = adapters.bilibiliSession || extractBilibiliVideosWithSiteSession;
  const bilibiliSessionOptions = {
    profileRoot, signal: options.signal, capturePage: adapters.bilibiliCapturePage, requestPage: adapters.bilibiliRequestPage
  };
  const douyinOptions = isDouyinUrl(pageUrl) ? {
    profileRoot,
    signal: options.signal,
    requestPage: adapters.douyinRequestPage,
    captureVideoData: adapters.douyinCaptureVideoData
  } : {};
  if (options.verifyInBrowser === true) {
    if (isBilibiliUrl(pageUrl)) {
      const result = await scanBilibiliSession(pageUrl, { ...bilibiliSessionOptions, verifyInBrowser: true });
      return {
        ...videoSiteScanResult(result.pageUrl || pageUrl, result.videos, { usedLogin: true, authenticationMethod: "verification-browser" }),
        usedBrowserVerification: true
      };
    }
    if (isDouyinUrl(pageUrl)) {
      const videos = await extractDouyinVideosFromPage(pageUrl, { ...douyinOptions, verifyInBrowser: true });
      return { ...videoSiteScanResult(pageUrl, videos), usedBrowserVerification: true };
    }
    const capture = await (adapters.verifyPage || captureVerifiedVideoPage)(pageUrl, {
      profileRoot: path.join(path.dirname(settingsFilePath()), "video-verification"),
      timeoutMs: 150000,
      signal: options.signal
    });
    const finalUrl = parseHttpUrl(capture.finalUrl || pageUrl, "verified page URL").href;
    if (new URL(finalUrl).origin !== new URL(pageUrl).origin) {
      throw Object.assign(new Error("The verification browser navigated to another site. Scan that page's address separately."), { code: "VIDEO_VERIFICATION_REDIRECT" });
    }
    const html = String(capture.html || "");
    if (browserVerificationPageState(html, finalUrl) !== "ready") throw accessBlockedVideoError();
    let videos;
    if (isMissAvUrl(finalUrl)) {
      videos = await buildMissAvPageScannedVideoResults(html, finalUrl, {
        userAgent: capture.userAgent, probeUnknownHls: true, signal: options.signal
      });
    } else if (isJavtifulUrl(finalUrl)) {
      videos = await buildJavtifulPageScannedVideoResults(html, finalUrl, { userAgent: capture.userAgent });
    } else {
      videos = await buildSitePageResults(extractVideoUrls(html, finalUrl), finalUrl, {
        title: pageTitleFromHtml(html, "video"),
        poster: extractPagePoster(html, finalUrl),
        variantGroup: `verified:${finalUrl}`,
        httpHeaders: videoSiteHeaders(finalUrl, capture.userAgent || browserUserAgent)
      });
    }
    if (!videos.length) {
      throw Object.assign(new Error("Browser verification completed, but this page did not expose a playable video. The player may require a separate login or additional interaction."), { code: "VIDEO_VERIFIED_NO_MEDIA" });
    }
    return { pageUrl: finalUrl, count: videos.length, videos, usedBrowserVerification: true };
  }
  const browserCookieSource = normalizeBrowserCookieSource(options.browser ?? options.bilibiliBrowser);
  const sessionSite = isBilibiliUrl(pageUrl) || isDouyinUrl(pageUrl);
  const cookiesFile = sessionSite ? await validateVideoCookiesFile(options.cookiesFile) : null;
  const useLogin = sessionSite && Boolean(browserCookieSource || cookiesFile);
  const scanBilibiliLogin = adapters.bilibiliLogin || extractBilibiliVideosWithBrowserLogin;
  const scanSite = adapters.site || extractSiteAwareVideos;
  const scanExtractor = adapters.extractor || extractVideosWithYtDlp;
  const session = { browser: cookiesFile ? null : browserCookieSource, cookiesFile };
  let authenticationWarning = null;
  // The application-owned session is independent of the browser-cookie selector.
  // It exists only after opening BiliBili's explicit sign-in/verification flow.
  if (isBilibiliUrl(pageUrl) && !cookiesFile && await (adapters.hasSiteSession || hasVerificationProfile)(profileRoot, "https://www.bilibili.com")) {
    try {
      const result = await scanBilibiliSession(pageUrl, bilibiliSessionOptions);
      if (result.videos?.length) return videoSiteScanResult(result.pageUrl || pageUrl, result.videos, {
        usedLogin: true, authenticationMethod: "verification-browser"
      });
    } catch (error) {
      if (options.signal?.aborted || ["VIDEO_VERIFICATION_BUSY", "VIDEO_VERIFICATION_CANCELLED", "VIDEO_VERIFICATION_REDIRECT", "BILIBILI_NOT_VIDEO"].includes(error?.code)) throw error;
      authenticationWarning = "The saved BiliBili session could not provide video data. Use the BiliBili sign-in button to refresh it if higher qualities are missing.";
      warnDiagnostic(`BiliBili saved session unavailable: ${videoErrorCode(error)}`);
    }
  }
  if (useLogin && isBilibiliUrl(pageUrl)) {
    try {
      const authenticatedVideos = await scanBilibiliLogin(pageUrl, session.browser, { cookiesFile });
      if (!authenticatedVideos.length) throw Object.assign(new Error("The selected login did not expose any video formats. Sign in to Bilibili and scan again."), { code: "BILIBILI_BROWSER_LOGIN_FAILED" });
      return videoSiteScanResult(pageUrl, authenticatedVideos, { ...session, usedLogin: true });
    } catch (error) {
      if (!["BILIBILI_BROWSER_LOGIN_FAILED", "BILIBILI_HD_UNAVAILABLE", "YTDLP_UNAVAILABLE"].includes(error?.code)) {
        throw error;
      }
      authenticationWarning = error.message;
      warnDiagnostic(`BiliBili browser login unavailable; using public formats for ${pageUrl}: ${error.message}`);
    }
  }
  const supportedSite = supportedVideoSiteName(pageUrl);
  let siteError = null;
  try {
    const siteVideos = await scanSite(pageUrl, douyinOptions);
    if (siteVideos.length) {
      return videoSiteScanResult(pageUrl, siteVideos, { ...session, authenticationWarning });
    }
  } catch (error) {
    if (options.signal?.aborted || ["VIDEO_VERIFICATION_BUSY", "VIDEO_VERIFICATION_CANCELLED", "VIDEO_VERIFICATION_REDIRECT"].includes(error?.code)) throw error;
    siteError = error;
    warnDiagnostic(`Site-aware page scan fallback for ${pageUrl}: ${videoErrorCode(error)} ${error.message}`);
    if (!sessionSite && (error?.accessBlocked || error?.browserChallenge)) throw error;
  }

  // A site's public parser failing must not suppress its independent extractor.
  // Douyin's API often requires a fresh session; only read a browser when opted in.
  if (sessionSite) {
    if (options.signal?.aborted) throw Object.assign(new Error("Video scan was cancelled."), { code: "VIDEO_VERIFICATION_CANCELLED" });
    try {
      const extractorVideos = await scanExtractor(pageUrl, isDouyinUrl(pageUrl) && useLogin ? session : {});
      if (extractorVideos.length) {
        return videoSiteScanResult(pageUrl, extractorVideos, {
          ...session,
          usedLogin: isDouyinUrl(pageUrl) && useLogin,
          authenticationWarning
        });
      }
    } catch (error) {
      if (isDouyinUrl(pageUrl) && useLogin) {
        authenticationWarning = "Douyin could not use the selected login. Click Verify in browser and retry, then sign in or complete verification in the window that opens. Its session will be reused for later scans.";
      }
      // Do not surface extractor stderr: it may include authentication data.
      warnDiagnostic(`Video extractor fallback failed for ${pageUrl}: ${videoErrorCode(error)}`);
    }
  }

  if (supportedSite) {
    if (isDouyinUrl(pageUrl)) {
      if (siteError?.code === "DOUYIN_VIDEO_UNAVAILABLE" || siteError?.code === "DOUYIN_NOT_VIDEO") throw siteError;
      throw Object.assign(new Error(authenticationWarning || "Douyin did not return playable video data. Click Verify in browser and retry, then open the video and complete any login or verification in that window. Its session will be reused for later scans."), { code: "DOUYIN_SESSION_REQUIRED" });
    }
    const reason = siteError?.message ? ` ${siteError.message}` : "";
    throw new Error(`${supportedSite} did not expose a playable main video for this page.${authenticationWarning ? ` ${authenticationWarning}` : reason}`);
  }

  try {
    const ytDlpVideos = await scanExtractor(pageUrl);
    if (ytDlpVideos.length) {
      return {
        pageUrl,
        count: ytDlpVideos.length,
        videos: ytDlpVideos
      };
    }
  } catch (error) {
    warnDiagnostic(`yt-dlp scan fallback for ${pageUrl}: ${ytDlpErrorSummary(error)}`);
  }

  const { videoUrls, usedBrowserFallback } = await fetchPageForVideos(pageUrl);
  const videos = videoUrls.map((video, index) => {
    const url = typeof video === "string" ? video : video.url;
    const result = {
      url,
      referer: typeof video === "object" && video.referer ? video.referer : pageUrl,
      filename: typeof video === "object" && video.filename
        ? sanitizeFileName(String(video.filename))
        : suggestedVideoFilename(video, index)
    };
    for (const key of [
      "sourcePage",
      "poster",
      "duration",
      "displaySize",
      "kind",
      "originalLabel",
      "qualityLabel",
      "qualityHeight",
      "qualityWidth",
      "qualityRank",
      "qualityExplicit",
      "protocol",
      "variantGroup",
      "httpHeaders"
    ]) {
      if (typeof video === "object" && video[key] != null) {
        result[key] = video[key];
      }
    }
    return result;
  });
  const enrichedVideos = usedBrowserFallback
    ? videos
    : await mapWithConcurrency(videos, 2, (video) => enrichScannedVideo(video, pageUrl));
  const playableVideos = enrichedVideos.filter(isScannedVideoPlayable);
  const scannedVideos = buildScannedVideoResults(playableVideos);
  return {
    pageUrl,
    count: scannedVideos.length,
    videos: scannedVideos
  };
}

function suggestedImageFilename(image, index) {
  const url = typeof image === "string" ? image : image.url;
  const baseName = sanitizeFileName(path.basename(new URL(url).pathname) || `image-${index + 1}`);
  if (!(typeof image === "object" && image.crop)) {
    return baseName;
  }

  const extension = path.extname(baseName);
  const stem = extension ? baseName.slice(0, -extension.length) : baseName;
  return `${stem}-slice-${String(index + 1).padStart(2, "0")}.png`;
}

function suggestedVideoFilename(video, index) {
  const url = typeof video === "string" ? video : video.url;
  const parsed = new URL(url);
  const baseName = sanitizeFileName(path.basename(parsed.pathname) || `video-${index + 1}`);
  const extension = path.extname(baseName);
  if (extension && videoExtensions.has(extension.toLowerCase())) {
    return baseName;
  }

  const sourceExtension = videoExtensions.has(path.extname(parsed.pathname).toLowerCase())
    ? path.extname(parsed.pathname)
    : ".mp4";
  return `${baseName}${sourceExtension}`;
}

function filenameWithVideoExtension(baseName, contentType, finalUrl) {
  const extension = path.extname(baseName);
  if (extension && videoExtensions.has(extension.toLowerCase())) {
    return baseName;
  }

  const contentTypeExtension = videoExtensionFromContentType(contentType);
  if (contentTypeExtension) {
    if (extension && hlsPlaylistExtensions.has(extension.toLowerCase())) {
      return `${baseName.slice(0, -extension.length)}${contentTypeExtension}`;
    }
    return `${baseName}${contentTypeExtension}`;
  }

  try {
    const sourceExtension = path.extname(new URL(finalUrl).pathname);
    if (sourceExtension && videoExtensions.has(sourceExtension.toLowerCase())) {
      return `${baseName}${sourceExtension}`;
    }
    if (sourceExtension && hlsPlaylistExtensions.has(sourceExtension.toLowerCase())) {
      return `${baseName}.ts`;
    }
  } catch {
  }

  return `${baseName}.mp4`;
}

function makeVideoFilename(videoUrl, index, contentType, usedNames) {
  const parsed = new URL(videoUrl);
  let baseName = sanitizeFileName(path.basename(parsed.pathname) || `video-${index}`);
  baseName = filenameWithVideoExtension(baseName, contentType, videoUrl);

  let filename = `${String(index).padStart(3, "0")}-${baseName}`;
  let attempt = 2;
  while (usedNames.has(filename.toLowerCase())) {
    const extension = path.extname(baseName);
    const stem = extension ? baseName.slice(0, -extension.length) : baseName;
    filename = `${String(index).padStart(3, "0")}-${stem}-${attempt}${extension}`;
    attempt++;
  }

  usedNames.add(filename.toLowerCase());
  return filename;
}

function makePreferredVideoFilename(videoUrl, index, contentType, usedNames, preferredFilename) {
  if (!preferredFilename) {
    return makeVideoFilename(videoUrl, index, contentType, usedNames);
  }

  let baseName = filenameWithVideoExtension(sanitizeFileName(preferredFilename), contentType, videoUrl);

  let filename = `${String(index).padStart(3, "0")}-${baseName}`;
  let attempt = 2;
  while (usedNames.has(filename.toLowerCase())) {
    const extension = path.extname(baseName);
    const stem = extension ? baseName.slice(0, -extension.length) : baseName;
    filename = `${String(index).padStart(3, "0")}-${stem}-${attempt}${extension}`;
    attempt++;
  }

  usedNames.add(filename.toLowerCase());
  return filename;
}

function normalizeCrop(crop) {
  if (!crop || typeof crop !== "object") {
    return null;
  }

  const normalized = {
    x: Math.max(0, Math.round(Number(crop.x || 0))),
    y: Math.max(0, Math.round(Number(crop.y || 0))),
    width: Math.round(Number(crop.width || 0)),
    height: Math.round(Number(crop.height || 0))
  };

  if (!normalized.width || !normalized.height || normalized.width > 4000 || normalized.height > 4000) {
    return null;
  }

  return normalized;
}

function normalizeCropFromItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const nestedCrop = normalizeCrop(item.crop);
  if (nestedCrop) {
    return nestedCrop;
  }

  return normalizeCrop({
    x: item.cropX,
    y: item.cropY,
    width: item.cropWidth,
    height: item.cropHeight
  });
}

function normalizeOptionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeOptionalUrl(value, baseUrl, label) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const resolved = resolveImageUrl(value, baseUrl || value);
  if (!resolved) {
    return null;
  }

  return parseHttpUrl(resolved, label).href;
}

function sameCrop(left, right) {
  return Boolean(
    left &&
    right &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function normalizeImageRequestList(images, pageUrlInput) {
  if (!Array.isArray(images)) {
    throw new Error("Scan images before downloading.");
  }

  const pageUrl = pageUrlInput ? parseHttpUrl(pageUrlInput, "page URL").href : null;
  const seen = new Set();
  const urls = [];
  for (const item of images) {
    const objectItem = item && typeof item === "object" ? item : null;
    const rawUrl = typeof item === "string" ? item : objectItem?.url;
    const resolved = pageUrl ? resolveImageUrl(rawUrl, pageUrl) : parseHttpUrl(rawUrl, "image URL").href;
    const crop = normalizeCropFromItem(item);
    const key = crop
      ? `${resolved}#crop=${crop.x},${crop.y},${crop.width},${crop.height}`
      : resolved;
    if (resolved && !seen.has(key)) {
      const sourcePage = normalizeOptionalUrl(objectItem?.sourcePage, pageUrl || resolved, "source page URL");
      const referer = objectItem?.referer
        ? normalizeOptionalUrl(objectItem.referer, sourcePage || pageUrl || resolved, "referer URL")
        : (sourcePage || pageUrl);
      const originalUrl = normalizeOptionalUrl(objectItem?.originalUrl, sourcePage || referer || pageUrl || resolved, "original image URL");
      seen.add(key);
      urls.push({
        url: resolved,
        referer,
        sourcePage,
        pageNumber: normalizeOptionalNumber(objectItem?.pageNumber),
        listIndex: normalizeOptionalNumber(objectItem?.listIndex ?? objectItem?.selectionIndex ?? objectItem?.index),
        originalUrl: originalUrl && originalUrl !== resolved ? originalUrl : null,
        originalLabel: objectItem?.originalLabel ? String(objectItem.originalLabel).slice(0, 160) : null,
        displaySize: objectItem?.displaySize ? String(objectItem.displaySize).slice(0, 80) : null,
        kind: objectItem?.kind ? String(objectItem.kind).slice(0, 80) : null,
        crop,
        filename: objectItem?.filename
          ? sanitizeFileName(String(item.filename))
          : null
      });
    }
    if (urls.length >= maxScannedImages) {
      break;
    }
  }

  if (urls.length === 0) {
    throw new Error("No downloadable image URLs were found.");
  }

  return urls;
}

function normalizeVideoRequestList(videos, pageUrlInput) {
  if (!Array.isArray(videos)) {
    throw new Error("Scan videos before downloading.");
  }

  const pageUrl = pageUrlInput ? parseHttpUrl(pageUrlInput, "page URL").href : null;
  const seen = new Set();
  const urls = [];
  for (const item of videos) {
    const objectItem = item && typeof item === "object" ? item : null;
    const rawUrl = typeof item === "string" ? item : objectItem?.url;
    const resolved = pageUrl ? resolveImageUrl(rawUrl, pageUrl) : parseHttpUrl(rawUrl, "video URL").href;
    if (resolved && !seen.has(resolved)) {
      const sourcePage = normalizeOptionalUrl(objectItem?.sourcePage, pageUrl || resolved, "source page URL");
      const referer = objectItem?.referer
        ? normalizeOptionalUrl(objectItem.referer, sourcePage || pageUrl || resolved, "referer URL")
        : (sourcePage || pageUrl);
      const poster = normalizeOptionalUrl(objectItem?.poster, sourcePage || referer || pageUrl || resolved, "poster URL");
      const extractor = objectItem?.extractor ? String(objectItem.extractor).slice(0, 80) : null;
      const originalPageUrl = normalizeOptionalUrl(objectItem?.pageUrl, pageUrl || sourcePage || referer || resolved, "page URL");
      const httpHeaders = normalizeVideoHttpHeaders(objectItem?.httpHeaders);
      const fallbackUrls = normalizeVideoUrlList(objectItem?.fallbackUrls, sourcePage || pageUrl || resolved)
        .filter((url) => url !== resolved);
      const audioUrl = normalizeOptionalUrl(objectItem?.audioUrl, sourcePage || pageUrl || resolved, "audio URL");
      const audioFallbackUrls = normalizeVideoUrlList(
        objectItem?.audioFallbackUrls,
        audioUrl || sourcePage || pageUrl || resolved
      ).filter((url) => url !== audioUrl);
      seen.add(resolved);
      urls.push({
        url: resolved,
        fallbackUrls,
        referer,
        sourcePage,
        poster,
        listIndex: normalizeOptionalNumber(objectItem?.listIndex ?? objectItem?.selectionIndex ?? objectItem?.index),
        originalLabel: objectItem?.originalLabel ? String(objectItem.originalLabel).slice(0, 160) : null,
        displaySize: objectItem?.displaySize ? String(objectItem.displaySize).slice(0, 80) : null,
        bytes: normalizeOptionalNumber(objectItem?.bytes),
        contentType: objectItem?.contentType ? String(objectItem.contentType).slice(0, 80) : null,
        protocol: objectItem?.protocol ? String(objectItem.protocol).slice(0, 30) : null,
        kind: objectItem?.kind ? String(objectItem.kind).slice(0, 80) : null,
        extractor,
        extractorKey: objectItem?.extractorKey ? String(objectItem.extractorKey).slice(0, 80) : null,
        pageUrl: originalPageUrl || pageUrl || sourcePage || referer || resolved,
        formatId: objectItem?.formatId ? String(objectItem.formatId).slice(0, 160) : null,
        formatSelector: objectItem?.formatSelector ? String(objectItem.formatSelector).slice(0, 160) : null,
        formatExt: objectItem?.formatExt ? String(objectItem.formatExt).replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase() : null,
        hasAudio: typeof objectItem?.hasAudio === "boolean" ? objectItem.hasAudio : null,
        requiresAudioMerge: Boolean(objectItem?.requiresAudioMerge),
        audioUrl,
        audioFallbackUrls,
        audioBytes: normalizeOptionalNumber(objectItem?.audioBytes),
        audioContentType: objectItem?.audioContentType ? String(objectItem.audioContentType).slice(0, 80) : null,
        cookiesFromBrowser: normalizeBrowserCookieSource(objectItem?.cookiesFromBrowser),
        authSessionId: objectItem?.authSessionId || null,
        cookiesFile: videoAuthentication.resolve(objectItem?.authSessionId),
        impersonate: objectItem?.impersonate ? String(objectItem.impersonate).slice(0, 80) : null,
        httpHeaders,
        filename: objectItem?.filename
          ? sanitizeFileName(String(objectItem.filename))
          : null
      });
    }
    if (urls.length >= maxScannedVideos) {
      break;
    }
  }

  if (urls.length === 0) {
    throw new Error("No downloadable video URLs were found.");
  }

  return urls;
}

function requestBuffer(urlInput, options = {}) {
  const url = parseHttpUrl(urlInput, "image URL");
  const maxBytes = options.maxBytes || maxSingleImageBytes;
  const timeout = options.timeout || 30000;
  const redirectsLeft = options.redirectsLeft ?? 5;
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    let finished = false;
    let hardTimeoutId;
    let request;

    const abortError = () => {
      const error = new Error("Image download cancelled.");
      error.code = "ABORT_ERR";
      return error;
    };
    const onAbort = () => {
      const error = abortError();
      request?.destroy(error);
      finish(reject, error);
    };
    const finish = (callback, value) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(hardTimeoutId);
      options.signal?.removeEventListener("abort", onAbort);
      callback(value);
    };

    if (options.signal?.aborted) {
      finish(reject, abortError());
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutError = () => {
      const error = new Error("Request timed out.");
      error.code = "ETIMEDOUT";
      return error;
    };

    request = transport.request(
      url,
      {
        method: "GET",
        timeout,
        headers: {
          ...options.headers,
          "User-Agent": options.headers?.["User-Agent"] || browserUserAgent,
          Accept: options.headers?.Accept || "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        }
      },
      (response) => {
        clearTimeout(hardTimeoutId);
        const location = response.headers.location;
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          location &&
          redirectsLeft > 0
        ) {
          response.resume();
          const redirected = new URL(location, url).href;
          requestBuffer(redirected, { ...options, redirectsLeft: redirectsLeft - 1 })
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          const error = new Error(`HTTP ${response.statusCode}`);
          error.statusCode = response.statusCode;
          error.code = `HTTP_${response.statusCode}`;
          error.responseServer = response.headers.server || "";
          error.accessBlocked = response.statusCode === 403 && /cloudflare/i.test(error.responseServer);
          error.browserChallenge = String(response.headers["cf-mitigated"] || "").toLowerCase() === "challenge";
          finish(reject, error);
          return;
        }

        const contentLength = Number(response.headers["content-length"] || 0);
        if (contentLength > maxBytes) {
          response.resume();
          const error = new Error("Image is larger than 50 MB.");
          error.code = "IMAGE_TOO_LARGE";
          finish(reject, error);
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        response.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            const error = new Error("Image is larger than 50 MB.");
            error.code = "IMAGE_TOO_LARGE";
            request.destroy(error);
            finish(reject, error);
            return;
          }
          chunks.push(chunk);
          options.onProgress?.({
            bytesDownloaded: totalBytes,
            bytesTotal: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0,
            progress: contentLength > 0 ? Math.min(1, totalBytes / contentLength) : null
          });
        });
        response.on("error", (error) => finish(reject, error));
        response.on("end", () => {
          finish(resolve, {
            buffer: Buffer.concat(chunks),
            contentType: response.headers["content-type"] || "",
            finalUrl: url.href
          });
        });
      }
    );

    hardTimeoutId = setTimeout(() => {
      const error = timeoutError();
      request.destroy(error);
      finish(reject, error);
    }, timeout);
    request.setTimeout(timeout);
    request.on("timeout", () => {
      const error = timeoutError();
      request.destroy(error);
      finish(reject, error);
    });
    request.on("error", (error) => finish(reject, error));
    request.end();
  });
}

function byteLimitStream(maxBytes, message, code) {
  let totalBytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        const error = new Error(message);
        error.code = code;
        callback(error);
        return;
      }
      callback(null, chunk);
    }
  });
}

function videoDownloadCancelledError() {
  const error = new Error("Video download cancelled.");
  error.code = "ECANCELLED";
  return error;
}

function throwIfVideoDownloadCancelled(signal) {
  if (signal?.aborted) {
    throw videoDownloadCancelledError();
  }
}

function requestVideoStream(urlInput, options = {}) {
  const url = parseHttpUrl(urlInput, "video URL");
  const maxBytes = options.maxBytes || maxSingleVideoBytes;
  const timeout = options.timeout || 30000;
  const redirectsLeft = options.redirectsLeft ?? 5;
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) {
      reject(videoDownloadCancelledError());
      return;
    }

    let settled = false;
    const request = transport.request(
      url,
      {
        method: "GET",
        timeout,
        headers: {
          ...options.headers,
          "User-Agent": options.headers?.["User-Agent"] || browserUserAgent,
          Accept: options.headers?.Accept || "application/vnd.apple.mpegurl,application/x-mpegURL,video/mp4,video/webm,video/ogg,video/*,*/*;q=0.8"
        }
      },
      (response) => {
        const location = response.headers.location;
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          location &&
          redirectsLeft > 0
        ) {
          response.destroy();
          const redirected = new URL(location, url).href;
          requestVideoStream(redirected, { ...options, redirectsLeft: redirectsLeft - 1 })
            .then(finishResolve)
            .catch(finishReject);
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          const error = new Error(`HTTP ${response.statusCode}`);
          error.statusCode = response.statusCode;
          error.code = `HTTP_${response.statusCode}`;
          finishReject(error);
          return;
        }

        const contentLength = Number(response.headers["content-length"] || 0);
        if (contentLength > maxBytes) {
          response.destroy();
          const error = new Error("Video is larger than 4 GB.");
          error.code = "VIDEO_TOO_LARGE";
          finishReject(error);
          return;
        }

        finishResolve({
          stream: response,
          contentType: response.headers["content-type"] || "",
          contentLength,
          finalUrl: url.href
        });
      }
    );

    function cleanup() {
      signal?.removeEventListener("abort", abortRequest);
    }

    function finishResolve(value) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    }

    function finishReject(error) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    function abortRequest() {
      request.destroy(videoDownloadCancelledError());
    }

    signal?.addEventListener("abort", abortRequest, { once: true });
    request.on("timeout", () => {
      const error = new Error("Video request timed out.");
      error.code = "ETIMEDOUT";
      request.destroy(error);
    });
    request.on("error", finishReject);
    request.end();
  });
}

async function requestVideoStreamWithFallback(video, options = {}) {
  const urls = normalizeVideoUrlList([video.url, ...(video.fallbackUrls || [])], video.url);
  let lastError = null;
  for (const url of urls) {
    try {
      return await requestVideoStream(url, options);
    } catch (error) {
      lastError = error;
      throwIfVideoDownloadCancelled(options.signal);
    }
  }
  throw lastError || new Error("Video URL did not return a stream.");
}

function parseResourceContentLength(headers) {
  const contentRange = String(headers["content-range"] || "");
  const rangeMatch = /\/(\d+)\s*$/i.exec(contentRange);
  if (rangeMatch) {
    const rangeLength = Number(rangeMatch[1]);
    if (Number.isFinite(rangeLength) && rangeLength > 0) {
      return rangeLength;
    }
  }

  const contentLength = Number(headers["content-length"] || 0);
  return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
}

function requestResourceMetadata(urlInput, options = {}) {
  const url = parseHttpUrl(urlInput, "video URL");
  const timeout = options.timeout || videoPageRequestTimeoutMs;
  const redirectsLeft = options.redirectsLeft ?? 5;
  const method = options.method || "HEAD";
  const transport = url.protocol === "https:" ? https : http;
  const headers = {
    ...videoRequestHeaders,
    ...options.headers,
    "User-Agent": options.headers?.["User-Agent"] || browserUserAgent,
    Accept: options.headers?.Accept || "application/vnd.apple.mpegurl,application/x-mpegURL,video/mp4,video/webm,video/ogg,video/*,*/*;q=0.8",
    Referer: options.referer || options.headers?.Referer || url.href
  };
  if (options.range) {
    headers.Range = options.range;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const request = transport.request(
      url,
      {
        method,
        timeout,
        headers
      },
      (response) => {
        const location = response.headers.location;
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          location &&
          redirectsLeft > 0
        ) {
          response.resume();
          requestResourceMetadata(new URL(location, url).href, {
            ...options,
            redirectsLeft: redirectsLeft - 1
          }).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          const error = new Error(`HTTP ${response.statusCode}`);
          error.statusCode = response.statusCode;
          error.code = `HTTP_${response.statusCode}`;
          reject(error);
          return;
        }

        settled = true;
        resolve({
          contentType: response.headers["content-type"] || "",
          contentLength: parseResourceContentLength(response.headers),
          finalUrl: url.href,
          statusCode: response.statusCode
        });

        response.on("error", () => {});
        if (method === "HEAD") {
          response.resume();
        } else {
          response.destroy();
        }
      }
    );

    request.on("timeout", () => {
      const error = new Error("Video metadata request timed out.");
      error.code = "ETIMEDOUT";
      request.destroy(error);
    });
    request.on("error", (error) => {
      if (!settled) {
        reject(error);
      }
    });
    request.end();
  });
}

async function getVideoResourceMetadata(video) {
  const referer = video.referer || video.sourcePage || video.url;
  const headers = normalizeVideoHttpHeaders(video.httpHeaders);
  try {
    return await requestResourceMetadata(video.url, {
      headers,
      referer,
      method: "HEAD"
    });
  } catch (headError) {
    try {
      return await requestResourceMetadata(video.url, {
        headers,
        referer,
        method: "GET",
        range: "bytes=0-0"
      });
    } catch {
      throw headError;
    }
  }
}

function formatByteCount(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  const formatted = scaled >= 10 || index === 0
    ? Math.round(scaled).toString()
    : scaled.toFixed(1);
  return `${formatted} ${units[index]}`;
}

async function enrichScannedVideo(video) {
  try {
    const metadata = await getVideoResourceMetadata(video);
    const bytes = metadata.contentLength || 0;
    return {
      ...video,
      contentType: normalizedContentType(metadata.contentType) || metadata.contentType || null,
      bytes,
      displaySize: video.displaySize || formatByteCount(bytes)
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ...video,
      metadataError: videoErrorCode(error)
    };
  }
}

function isScannedVideoPlayable(video) {
  if (looksLikeImageUrl(video.url)) {
    return false;
  }

  const contentType = normalizedContentType(video.contentType);
  if (!contentType) {
    return true;
  }

  return contentType.startsWith("video/") ||
    isHlsContentType(contentType) ||
    contentType === "application/octet-stream" ||
    looksLikeVideoSourceUrl(video.url);
}

function proxyVideoStream(urlInput, options = {}, response) {
  const url = parseHttpUrl(urlInput, "video URL");
  const redirectsLeft = options.redirectsLeft ?? 5;
  const transport = url.protocol === "https:" ? https : http;
  const passthroughHeaders = normalizeVideoHttpHeaders(options.headers);
  const headers = {
    ...videoRequestHeaders,
    ...passthroughHeaders,
    Referer: options.referer || passthroughHeaders?.Referer || url.href
  };
  if (options.range) {
    headers.Range = options.range;
  }

  const upstream = transport.request(
    url,
    {
      method: "GET",
      timeout: options.timeout || 30000,
      headers
    },
    (upstreamResponse) => {
      const location = upstreamResponse.headers.location;
      if (
        upstreamResponse.statusCode >= 300 &&
        upstreamResponse.statusCode < 400 &&
        location &&
        redirectsLeft > 0
      ) {
        upstreamResponse.resume();
        proxyVideoStream(new URL(location, url).href, { ...options, redirectsLeft: redirectsLeft - 1 }, response);
        return;
      }

      if (upstreamResponse.statusCode < 200 || upstreamResponse.statusCode >= 300) {
        upstreamResponse.resume();
        warnDiagnostic(`Video preview failed: HTTP ${upstreamResponse.statusCode} for ${url.href}`);
        if (!response.headersSent) {
          response.status(upstreamResponse.statusCode).end();
        }
        return;
      }

      const contentType = normalizedContentType(upstreamResponse.headers["content-type"] || "");
      const sourceLooksLikeVideo = looksLikeVideoUrl(url.href);
      if (contentType && !contentType.startsWith("video/") && contentType !== "application/octet-stream" && !sourceLooksLikeVideo) {
        upstreamResponse.resume();
        warnDiagnostic(`Video preview failed: non-video response ${contentType} for ${url.href}`);
        if (!response.headersSent) {
          response.status(415).json({ error: "Preview URL did not return a playable video." });
        }
        return;
      }

      const passthroughHeaders = {};
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
        if (upstreamResponse.headers[name]) {
          passthroughHeaders[name] = upstreamResponse.headers[name];
        }
      }
      if (!passthroughHeaders["accept-ranges"]) {
        passthroughHeaders["accept-ranges"] = "bytes";
      }

      response.writeHead(upstreamResponse.statusCode, passthroughHeaders);
      upstreamResponse.pipe(response);
    }
  );

  upstream.on("timeout", () => {
    upstream.destroy(new Error("Video preview timed out."));
  });
  upstream.on("error", (error) => {
    warnDiagnostic(`Video preview failed: ${error.message} for ${url.href}`);
    if (!response.headersSent) {
      response.status(400).end();
    } else {
      response.end();
    }
  });
  upstream.end();
}

function imageBufferCacheKey(image) {
  return `${image.url}\n${image.referer || ""}`;
}

function pruneImageBufferCache() {
  const now = Date.now();
  for (const [key, entry] of imageBufferCache.entries()) {
    if (now - entry.createdAt > imageBufferCacheTtlMs) {
      imageBufferCache.delete(key);
    }
  }

  while (imageBufferCache.size > maxImageBufferCacheEntries) {
    const oldestKey = imageBufferCache.keys().next().value;
    imageBufferCache.delete(oldestKey);
  }
}

async function requestImageBuffer(image, options = {}) {
  pruneImageBufferCache();
  const cacheKey = imageBufferCacheKey(image);
  const cached = imageBufferCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt <= imageBufferCacheTtlMs) {
    options.onProgress?.({
      bytesDownloaded: cached.result.buffer.byteLength,
      bytesTotal: cached.result.buffer.byteLength,
      progress: 1
    });
    return cached.result;
  }

  const fetchImage = () => requestBuffer(image.url, {
    maxBytes: maxSingleImageBytes,
    timeout: 20000,
    headers: {
      Referer: image.referer || image.url,
      "User-Agent": browserUserAgent,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    },
    signal: options.signal,
    onProgress: options.onProgress
  });
  const result = options.hostPacing
    ? await withImageHostPacing(image.url, fetchImage)
    : await fetchImage();

  if (result.buffer.byteLength <= maxCachedImageBytes) {
    imageBufferCache.set(cacheKey, {
      createdAt: Date.now(),
      result
    });
    pruneImageBufferCache();
  }

  return result;
}

async function refreshScannedImage(image) {
  if (!image.referer) {
    return null;
  }

  const refreshed = await scanImagePage(image.referer);
  const crop = normalizeCropFromItem(image);
  const filename = image.filename ? sanitizeFileName(String(image.filename)) : null;
  const pageNumber = Number(image.pageNumber || 0);
  const match = refreshed.images.find((candidate) => (
    pageNumber > 0 && Number(candidate.pageNumber || 0) === pageNumber
  )) || refreshed.images.find((candidate) => (
    filename && candidate.filename === filename
  )) || refreshed.images.find((candidate) => sameCrop(crop, normalizeCropFromItem(candidate)))
    || (refreshed.images.length === 1 ? refreshed.images[0] : null);

  return match ? normalizeImageRequestList([match], null)[0] : null;
}

function mergeImageMetadata(previous, next) {
  return {
    ...previous,
    ...next,
    pageNumber: next.pageNumber || previous.pageNumber || null,
    listIndex: next.listIndex || previous.listIndex || null,
    sourcePage: next.sourcePage || previous.sourcePage || null,
    originalUrl: next.originalUrl || previous.originalUrl || null,
    originalLabel: next.originalLabel || previous.originalLabel || null,
    displaySize: next.displaySize || previous.displaySize || null,
    kind: next.kind || previous.kind || null
  };
}

function imageRequestCandidates(image) {
  const candidates = [];
  const seen = new Set();

  function add(candidate) {
    if (!candidate?.url || seen.has(candidate.url)) {
      return;
    }
    seen.add(candidate.url);
    candidates.push(candidate);
  }

  add(image);
  if (image.originalUrl && image.originalUrl !== image.url) {
    add({
      ...image,
      url: image.originalUrl
    });
  }

  return candidates;
}

async function requestImageBufferWithRefresh(image, options = {}) {
  let activeImage = image;
  let lastError = null;
  let attempts = 0;
  const maxAttempts = 5;
  let refreshAttempted = false;
  let refreshSucceeded = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let hadRetryableError = false;
    for (const candidate of imageRequestCandidates(activeImage)) {
      try {
        attempts++;
        return {
          image: candidate,
          response: await requestImageBuffer(candidate, options),
          attempts,
          refreshAttempted,
          refreshSucceeded
        };
      } catch (error) {
        lastError = error;
        if (error?.code === "ABORT_ERR") {
          break;
        }
        hadRetryableError = hadRetryableError || isRetryableImageError(error);
      }
    }

    if (lastError?.code === "ABORT_ERR") {
      break;
    }

    const refreshable = refreshableImageStatusCodes.has(Number(lastError?.statusCode));
    if (refreshable && !refreshAttempted && activeImage.referer) {
      refreshAttempted = true;
      const refreshed = await refreshScannedImage(activeImage).catch(() => null);
      if (refreshed && (refreshed.url !== activeImage.url || refreshed.referer !== activeImage.referer || refreshed.originalUrl !== activeImage.originalUrl)) {
        activeImage = mergeImageMetadata(activeImage, refreshed);
        refreshSucceeded = true;
        continue;
      }
    }

    if (lastError && !hadRetryableError && !isRetryableImageError(lastError)) {
      break;
    }

    const refreshed = await refreshScannedImage(activeImage).catch(() => null);
    if (refreshed && (refreshed.url !== activeImage.url || refreshed.referer !== activeImage.referer || refreshed.originalUrl !== activeImage.originalUrl)) {
      activeImage = mergeImageMetadata(activeImage, refreshed);
    }

    if (attempt < maxAttempts - 1) {
      await sleep(900 * (attempt + 1));
    }
  }

  const error = lastError || new Error("Image request failed.");
  error.image = activeImage;
  error.attempts = Math.max(1, attempts);
  error.refreshAttempted = refreshAttempted;
  error.refreshSucceeded = refreshSucceeded;
  throw error;
}

function downloadOutputIndex(image, fallbackIndex) {
  return image.listIndex || image.pageNumber || fallbackIndex;
}

async function downloadImageFile(image, outputDir, index, usedNames, existingHashes, options = {}) {
  const normalized = normalizeImageRequestList([image], null)[0];
  const { image: activeImage, response, attempts, refreshAttempted, refreshSucceeded } = await requestImageBufferWithRefresh(normalized, {
    hostPacing: true,
    signal: options.signal,
    onProgress: options.onProgress
  });
  const { buffer, contentType, finalUrl } = response;

  if (!contentType.toLowerCase().startsWith("image/")) {
    const error = new Error("URL did not return an image.");
    error.code = "NON_IMAGE_RESPONSE";
    error.image = activeImage;
    error.attempts = attempts;
    error.refreshAttempted = refreshAttempted;
    error.refreshSucceeded = refreshSucceeded;
    throw error;
  }

  let output;
  try {
    output = await outputImageBuffer(buffer, finalUrl, contentType, activeImage);
  } catch (processingError) {
    processingError.code = processingError.code || "IMAGE_PROCESSING_FAILED";
    processingError.image = activeImage;
    processingError.attempts = attempts;
    processingError.refreshAttempted = refreshAttempted;
    processingError.refreshSucceeded = refreshSucceeded;
    throw processingError;
  }

  const outputHash = sha256(output.buffer);
  const duplicate = existingHashes?.get(outputHash);
  if (duplicate) {
    return {
      skipped: true,
      reason: "duplicate",
      url: finalUrl,
      sourceUrl: activeImage.url,
      sourcePage: activeImage.sourcePage || activeImage.referer || null,
      referer: activeImage.referer || null,
      pageNumber: activeImage.pageNumber || null,
      listIndex: activeImage.listIndex || null,
      originalUrl: activeImage.originalUrl || null,
      filename: activeImage.filename || path.basename(new URL(finalUrl).pathname) || "image",
      duplicateOf: duplicate.filename,
      duplicatePath: duplicate.path,
      bytes: output.buffer.byteLength,
      sha256: outputHash,
      contentType: output.contentType,
      convertedFrom: output.convertedFrom,
      attempts,
      refreshAttempted,
      refreshSucceeded,
      outputIndex: index
    };
  }

  const filename = makePreferredImageFilename(finalUrl, index, output.contentType, usedNames, activeImage.filename);
  const filePath = path.join(outputDir, filename);
  if (existingHashes) {
    existingHashes.set(outputHash, {
      filename,
      path: filePath,
      bytes: output.buffer.byteLength
    });
  }

  try {
    await fs.writeFile(filePath, output.buffer);
  } catch (writeError) {
    if (existingHashes?.get(outputHash)?.path === filePath) {
      existingHashes.delete(outputHash);
    }
    writeError.image = activeImage;
    writeError.attempts = attempts;
    writeError.refreshAttempted = refreshAttempted;
    writeError.refreshSucceeded = refreshSucceeded;
    throw writeError;
  }

  return {
    url: finalUrl,
    sourceUrl: activeImage.url,
    sourcePage: activeImage.sourcePage || activeImage.referer || null,
    referer: activeImage.referer || null,
    pageNumber: activeImage.pageNumber || null,
    listIndex: activeImage.listIndex || null,
    originalUrl: activeImage.originalUrl || null,
    filename,
    path: filePath,
    bytes: output.buffer.byteLength,
    sha256: outputHash,
    contentType: output.contentType,
    convertedFrom: output.convertedFrom,
    attempts,
    refreshAttempted,
    refreshSucceeded,
    outputIndex: index
  };
}

function imageFailureLabel(image, fallbackIndex) {
  if (image.pageNumber) {
    return `Page ${image.pageNumber}`;
  }

  if (image.listIndex) {
    return `Item ${image.listIndex}`;
  }

  return `Item ${fallbackIndex}`;
}

function imageFailureDetails(image, error, fallbackIndex, options = {}) {
  const attempts = Math.max(1, Number(error.attempts || 1));
  const autoRetried = Boolean(options.autoRetried || error.autoRetried);
  const errorCode = imageErrorCode(error);
  const retryable = isRetryableImageError(error);
  const details = {
    url: image.url,
    sourcePage: image.sourcePage || image.referer || null,
    referer: image.referer || null,
    originalUrl: image.originalUrl || null,
    originalLabel: image.originalLabel || null,
    filename: image.filename || null,
    pageNumber: image.pageNumber || null,
    listIndex: image.listIndex || fallbackIndex || null,
    displaySize: image.displaySize || null,
    kind: image.kind || null,
    pageLabel: imageFailureLabel(image, fallbackIndex),
    error: friendlyImageErrorMessage(error, autoRetried),
    rawError: error.message,
    errorCode,
    retryable,
    attempts,
    autoRetried,
    refreshAttempted: Boolean(error.refreshAttempted),
    refreshSucceeded: Boolean(error.refreshSucceeded),
    refreshedUrl: error.refreshAttempted ? image.url : null,
    refreshedReferer: error.refreshAttempted ? image.referer || null : null,
    outputIndex: fallbackIndex
  };

  const crop = normalizeCropFromItem(image);
  if (crop) {
    details.crop = crop;
    details.cropX = crop.x;
    details.cropY = crop.y;
    details.cropWidth = crop.width;
    details.cropHeight = crop.height;
  }

  return details;
}

function imageDownloadSummary(outputDir, requested, files, failures, skippedDuplicates = []) {
  return {
    outputDir,
    requested,
    downloaded: files.length,
    skipped: skippedDuplicates.length,
    failed: failures.length,
    skippedDuplicates: skippedDuplicates.map((skipped) => ({
      pageLabel: skipped.pageLabel,
      pageNumber: skipped.pageNumber,
      listIndex: skipped.listIndex,
      filename: skipped.filename,
      duplicateOf: skipped.duplicateOf,
      sourcePage: skipped.sourcePage,
      url: skipped.url,
      sha256: skipped.sha256
    })),
    failedPages: failures.map((failure) => ({
      pageLabel: failure.pageLabel,
      pageNumber: failure.pageNumber,
      listIndex: failure.listIndex,
      filename: failure.filename,
      sourcePage: failure.sourcePage,
      url: failure.url,
      error: failure.error,
      errorCode: failure.errorCode,
      retryable: failure.retryable,
      attempts: failure.attempts,
      autoRetried: failure.autoRetried,
      refreshAttempted: failure.refreshAttempted,
      refreshSucceeded: failure.refreshSucceeded
    }))
  };
}

async function appendImageHistory(pageUrl, outputDir, requested, result) {
  const id = makeHistoryId("image");
  const failures = Array.isArray(result.failures) ? result.failures : [];
  const entry = {
    type: "image",
    id,
    sourceUrl: pageUrl || null,
    outputDir,
    requested,
    downloaded: result.downloaded || 0,
    skipped: result.skipped || 0,
    failed: result.failed || 0,
    failureCount: failures.length,
    failureManifestId: failures.length ? id : null,
    savedFiles: (result.files || []).slice(0, 80).map((file) => ({
      filename: file.filename,
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      contentType: file.contentType,
      convertedFrom: file.convertedFrom || null
    })),
    skippedDuplicates: (result.skippedDuplicates || []).slice(0, 80).map((item) => ({
      filename: item.filename,
      duplicateOf: item.duplicateOf,
      duplicatePath: item.duplicatePath,
      sourcePage: item.sourcePage,
      url: item.url,
      pageNumber: item.pageNumber,
      listIndex: item.listIndex,
      sha256: item.sha256
    })),
    failures: failures.slice(0, 80).map((failure) => ({
      url: failure.url,
      sourcePage: failure.sourcePage,
      referer: failure.referer,
      originalUrl: failure.originalUrl,
      originalLabel: failure.originalLabel,
      filename: failure.filename,
      pageNumber: failure.pageNumber,
      listIndex: failure.listIndex,
      displaySize: failure.displaySize,
      kind: failure.kind,
      crop: failure.crop || null,
      cropX: failure.cropX,
      cropY: failure.cropY,
      cropWidth: failure.cropWidth,
      cropHeight: failure.cropHeight,
      error: failure.error,
      errorCode: failure.errorCode,
      retryable: failure.retryable,
      attempts: failure.attempts,
      refreshAttempted: failure.refreshAttempted,
      refreshSucceeded: failure.refreshSucceeded,
      refreshedUrl: failure.refreshedUrl,
      refreshedReferer: failure.refreshedReferer
    }))
  };

  if (failures.length) {
    await writeImageFailureManifest(id, failures).catch((error) => {
      warnDiagnostic(`Could not write image failure manifest: ${error.message}`);
      entry.failureManifestId = null;
    });
  }
  await appendHistoryEntry(entry).catch((error) => {
    warnDiagnostic(`Could not write image history: ${error.message}`);
    deleteImageFailureManifest(entry.failureManifestId).catch(() => {});
  });
}

async function buildOutputNameIndex(outputDir) {
  const usedNames = new Set();
  let entries = [];

  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch {
    return usedNames;
  }

  entries.forEach((entry) => {
    if (entry.isFile()) {
      usedNames.add(entry.name.toLowerCase());
    }
  });

  return usedNames;
}

function videoErrorCode(error) {
  if (Number.isFinite(error?.statusCode)) {
    return `HTTP_${error.statusCode}`;
  }

  if (error?.code) {
    const code = String(error.code);
    if (code === "UND_ERR_CONNECT_TIMEOUT") {
      return "ETIMEDOUT";
    }
    return code;
  }

  const message = String(error?.message || "").toLowerCase();
  if (message.includes("socket hang up") || message.includes("connection reset")) {
    return "ECONNRESET";
  }
  if (message.includes("timed out") || message.includes("timeout") || message.includes("connect timeout")) {
    return "ETIMEDOUT";
  }
  if (message.includes("getaddrinfo") && message.includes("enotfound")) {
    return "ENOTFOUND";
  }
  if (message.includes("ehostunreach")) {
    return "EHOSTUNREACH";
  }
  if (message.includes("enetunreach")) {
    return "ENETUNREACH";
  }
  if (message.includes("econnrefused")) {
    return "ECONNREFUSED";
  }
  if (message.includes("eacces")) {
    return "EACCES";
  }

  return "VIDEO_REQUEST_FAILED";
}

function friendlyVideoErrorMessage(error) {
  const code = videoErrorCode(error);
  if (code === "ECONNRESET") {
    return "Connection reset by server.";
  }
  if (code === "ETIMEDOUT" || code === "ECONNABORTED") {
    return "Could not connect to the video site before timeout.";
  }
  if (code === "VIDEO_SCAN_TIMEOUT") {
    return "Video scan timed out. This site may be blocking automated access.";
  }
  if (code === "ENOTFOUND") {
    return "Video site could not be found by DNS.";
  }
  if (code === "EAI_AGAIN") {
    return "Temporary DNS lookup failed.";
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return "Network could not reach the video site.";
  }
  if (code === "ECONNREFUSED") {
    return "Video site refused the connection.";
  }
  if (code === "EACCES") {
    return "Network blocked the connection to the video site.";
  }
  if (code === "HTTP_403") {
    if (error?.accessBlocked) {
      return "Site blocked automated access (HTTP 403).";
    }
    return "Video server refused access.";
  }
  if (code === "HTTP_404") {
    return "Video was not found.";
  }
  if (code === "VIDEO_TOO_LARGE") {
    return "Video is larger than 4 GB.";
  }
  if (code === "HLS_ENCRYPTED") {
    return "Encrypted HLS playlists are not supported.";
  }
  if (code === "NON_VIDEO_RESPONSE") {
    return "URL did not return a video.";
  }
  if (code === "YTDLP_UNAVAILABLE") {
    return "Site-aware video extractor is not available.";
  }
  if (code === "YTDLP_FAILED") {
    return "Site-aware video download failed.";
  }
  if (code === "BILIBILI_AUDIO_MISSING") {
    return "BiliBili audio stream was not found for this quality.";
  }
  if (code === "BILIBILI_BROWSER_LOGIN_FAILED") {
    return error.message;
  }
  if (code === "BILIBILI_HD_UNAVAILABLE") {
    return "BiliBili login was read, but this video/account did not expose 1080p or higher.";
  }
  if (code === "INVALID_BROWSER_SOURCE") {
    return "Choose Edge, Chrome, or Firefox for video site login.";
  }
  if (code === "FFMPEG_UNAVAILABLE") {
    return "FFmpeg is required to finish this video download.";
  }
  if (code === "ECANCELLED") {
    return "Video download cancelled.";
  }
  if (code === "INVALID_URL") {
    return "Video URL was invalid.";
  }

  return error?.message || "Video request failed.";
}

function videoFailureLabel(video, fallbackIndex) {
  if (video.listIndex) {
    return `Item ${video.listIndex}`;
  }

  return `Item ${fallbackIndex}`;
}

function videoFailureDetails(video, error, fallbackIndex) {
  return {
    url: video.url,
    sourcePage: video.sourcePage || video.referer || null,
    referer: video.referer || null,
    poster: video.poster || null,
    filename: video.filename || null,
    listIndex: video.listIndex || fallbackIndex || null,
    displaySize: video.displaySize || null,
    bytes: video.bytes || null,
    contentType: video.contentType || null,
    kind: video.kind || null,
    pageLabel: videoFailureLabel(video, fallbackIndex),
    error: friendlyVideoErrorMessage(error),
    rawError: error.message,
    errorCode: videoErrorCode(error),
    outputIndex: fallbackIndex
  };
}

function videoDownloadSummary(outputDir, requested, files, failures) {
  return {
    outputDir,
    requested,
    downloaded: files.length,
    failed: failures.length,
    failedVideos: failures.map((failure) => ({
      pageLabel: failure.pageLabel,
      listIndex: failure.listIndex,
      filename: failure.filename,
      sourcePage: failure.sourcePage,
      url: failure.url,
      error: failure.error,
      errorCode: failure.errorCode
    }))
  };
}

async function appendVideoHistory(pageUrl, outputDir, requested, result) {
  const entry = {
    type: "video",
    id: makeHistoryId("video"),
    sourceUrl: pageUrl || null,
    outputDir,
    requested,
    downloaded: result.downloaded || 0,
    failed: result.failed || 0,
    bytes: (result.files || []).reduce((total, file) => total + (file.bytes || 0), 0),
    savedFiles: (result.files || []).slice(0, 80).map((file) => ({
      filename: file.filename,
      path: file.path,
      bytes: file.bytes,
      contentType: file.contentType
    })),
    failures: (result.failures || []).slice(0, 80).map((failure) => ({
      url: failure.url,
      sourcePage: failure.sourcePage,
      referer: failure.referer,
      poster: failure.poster,
      filename: failure.filename,
      listIndex: failure.listIndex,
      displaySize: failure.displaySize,
      bytes: failure.bytes,
      contentType: failure.contentType,
      kind: failure.kind,
      error: failure.error,
      errorCode: failure.errorCode
    }))
  };

  await appendHistoryEntry(entry).catch((error) => {
    warnDiagnostic(`Could not write video history: ${error.message}`);
  });
}

function voiceDataRootDir() {
  if (process.env.MAGIC_BOX_VOICE_DATA_ROOT) {
    return path.resolve(process.env.MAGIC_BOX_VOICE_DATA_ROOT);
  }
  return path.join(path.dirname(settingsFilePath()), "voice_clone");
}

function voiceDbPath() {
  return path.join(voiceDataRootDir(), "voice_clone.json");
}

function voiceEngineRootDir() {
  if (process.env.MAGIC_BOX_VOICE_ENGINE_ROOT) {
    return path.resolve(process.env.MAGIC_BOX_VOICE_ENGINE_ROOT);
  }
  return path.join(voiceDataRootDir(), "voice_engine");
}

function approvedQwenRuntime() {
  if (process.env.MAGIC_BOX_VOICE_ENGINE_FAKE === "1" || process.env.MAGIC_BOX_LIVE_VOICE_FAKE === "1" || process.env.VOICE_TTS_PROVIDER === "cosyvoice3-stream-local") return null;
  try {
    // AppData may be a junction to the portable data directory. Use one
    // canonical Python/module path so native compilation caches are reusable.
    const base = realpathSync(path.join(voiceEngineRootDir(), "qwen3-tts"));
    const approval = JSON.parse(readFileSync(path.join(base, "approved-runtime.json"), "utf8"));
    if (approval.schemaVersion !== 1 || approval.listeningAccepted !== true || approval.modelRevision !== "fd4b254389122332181a7c3db7f27e918eec64e3") return null;
    return {
      ttsProvider: "qwen3-tts-stream-local",
      qwenModelRevision: approval.modelRevision,
      qwenModelDir: path.join(base, "models", "1.7b-base"),
      qwenCacheDir: path.join(base, "runtime", "numba-cache"),
      python: path.join(base, "runtime", "python", "Scripts", "python.exe"),
      manifest: path.join(base, "models", "1.7b-base", "checksums.json")
    };
  } catch { return null; }
}

function voiceProfileForPlayback(db, profile) {
  if (!profile?.conversationModel || !approvedQwenRuntime()) return profile;
  const model = profile.conversationModel;
  const primary = model.manualPrimaryReferenceSegmentId || model.sourceSegmentIds?.[0];
  const segment = (db.samples || []).flatMap((sample) => sample.segments || []).find((item) => item.id === primary);
  if (!segment?.audioPath || !existsSync(segment.audioPath)) return profile;
  return { ...profile, conversationModel: { ...model, qualityReferenceAudioPath: segment.audioPath, qualityReferenceTranscript: segment.transcript } };
}

function voiceEngineModelVersion(engine = voiceNeuralEngineId) {
  if (engine === cosyVoiceStreamingEngineId) {
    return cosyVoiceStreamingModelVersion;
  }
  if (engine === whisperTurboStreamingEngineId) {
    return whisperTurboStreamingModelVersion;
  }
  if (engine === voicePreparationEngineId) {
    return voicePreparationModelVersion;
  }
  if (engine === seedVcEngineId) {
    return seedVcModelVersion;
  }
  return engine === gptSoVitsEngineId ? gptSoVitsModelVersion : voiceNeuralModelVersion;
}

function voiceEngineModelDir(engine = voiceNeuralEngineId) {
  if (engine === cosyVoiceStreamingEngineId) {
    return path.join(voiceEngineRootDir(), "conversation", "tts", "models", cosyVoiceStreamingModelVersion);
  }
  if (engine === whisperTurboStreamingEngineId) {
    return path.join(voiceEngineRootDir(), "conversation", "asr", "models", whisperTurboStreamingModelVersion);
  }
  if (engine === voicePreparationEngineId) {
    return path.join(voiceEngineRootDir(), "preparation", "models", voicePreparationModelVersion);
  }
  if (engine === seedVcEngineId) {
    return path.join(voiceEngineRootDir(), "seed-vc", "models", seedVcModelVersion);
  }
  if (engine === gptSoVitsEngineId) {
    return path.join(voiceEngineRootDir(), "gpt-sovits", "models", gptSoVitsModelVersion);
  }
  return path.join(voiceEngineRootDir(), "models", voiceNeuralModelVersion);
}

function voiceEngineRuntimeDir(engine = voiceNeuralEngineId) {
  if (engine === cosyVoiceStreamingEngineId || engine === whisperTurboStreamingEngineId) {
    return path.join(voiceEngineRootDir(), "conversation", "runtime");
  }
  if (engine === voicePreparationEngineId) {
    return path.join(voiceEngineRootDir(), "preparation", "runtime");
  }
  if (engine === seedVcEngineId) {
    return path.join(voiceEngineRootDir(), "seed-vc", "runtime");
  }
  if (engine === gptSoVitsEngineId) {
    return path.join(voiceEngineRootDir(), "gpt-sovits", "runtime");
  }
  return path.join(voiceEngineRootDir(), "runtime");
}

function voiceEngineModelCacheDir(engine = voiceNeuralEngineId) {
  return path.join(voiceEngineModelDir(engine), "cache");
}

function voiceEngineInstallStatePath(engine = voiceNeuralEngineId) {
  if (engine === cosyVoiceStreamingEngineId) {
    return path.join(voiceEngineRootDir(), "conversation", "tts", "install_state.json");
  }
  if (engine === whisperTurboStreamingEngineId) {
    return path.join(voiceEngineRootDir(), "conversation", "asr", "install_state.json");
  }
  if (engine === voicePreparationEngineId) {
    return path.join(voiceEngineRootDir(), "preparation", "install_state.json");
  }
  if (engine === seedVcEngineId) {
    return path.join(voiceEngineRootDir(), "seed-vc", "install_state.json");
  }
  if (engine === gptSoVitsEngineId) {
    return path.join(voiceEngineRootDir(), "gpt-sovits", "install_state.json");
  }
  return path.join(voiceEngineRootDir(), "install_state.json");
}

function defaultVoiceDb() {
  return {
    schemaVersion: 2,
    profiles: [],
    samples: [],
    outputs: [],
    artifacts: [],
    referencePacks: [],
    attempts: [],
    qualityReports: [],
    jobs: [],
    jobEvents: []
  };
}

function voiceModelVersionId(profile, voiceModel) {
  const existingId = sanitizeUnicodeText(voiceModel?.versionId || voiceModel?.modelVersionId || "");
  if (existingId) {
    return existingId;
  }
  const builtAt = String(voiceModel?.builtAt || profile?.updatedAt || profile?.createdAt || "legacy").replace(/\D/g, "").slice(0, 14) || "legacy";
  const mode = String(voiceModel?.qualityMode || profile?.qualityMode || "model").replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "model";
  return `voice-model-${profile?.id || "profile"}-${mode}-${builtAt}`;
}

function voiceModelVersionLabel(voiceModel) {
  const mode = String(voiceModel?.qualityMode || "").toLowerCase() === "fine" ? "Fine Training" : "Quick Preview";
  const builtAt = voiceModel?.builtAt ? new Date(voiceModel.builtAt) : null;
  const dateLabel = builtAt && !Number.isNaN(builtAt.valueOf())
    ? builtAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "Saved build";
  return `${mode} - ${dateLabel}`;
}

function createVoiceModelVersion(profile, voiceModel, versionId = "") {
  const id = sanitizeUnicodeText(versionId || voiceModelVersionId(profile, voiceModel));
  const model = sanitizeStructuredText({
    ...(voiceModel || {}),
    versionId: id
  });
  const datasetCount = Number(model.trainingStats?.datasetSampleCount)
    || (Array.isArray(model.datasetSamples) ? model.datasetSamples.length : 0);
  return sanitizeStructuredText({
    id,
    label: voiceModelVersionLabel(model),
    engine: normalizeVoiceEngine(model.engine || profile?.engine, { language: profile?.language }),
    modelVersion: model.modelVersion || voiceEngineModelVersion(model.engine || profile?.engine),
    qualityMode: model.qualityMode || profile?.qualityMode || "",
    builtAt: model.builtAt || profile?.updatedAt || profile?.createdAt || "",
    trainingClipCount: datasetCount,
    promptText: model.promptText || "",
    primarySampleId: model.primarySampleId || "",
    primarySegmentId: model.primarySegmentId || "",
    voiceModel: model
  });
}

function normalizeVoiceModelVersions(profile) {
  const versions = [];
  const seen = new Set();
  const rawVersions = Array.isArray(profile?.modelVersions) ? profile.modelVersions : [];
  for (const rawVersion of rawVersions) {
    const rawModel = rawVersion?.voiceModel || rawVersion?.model || null;
    if (!rawModel?.engine) {
      continue;
    }
    const id = sanitizeUnicodeText(rawVersion.id || voiceModelVersionId(profile, rawModel));
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const version = createVoiceModelVersion(profile, {
      ...rawModel,
      versionId: id,
      builtAt: rawModel.builtAt || rawVersion.builtAt || rawVersion.createdAt
    }, id);
    versions.push({
      ...version,
      label: rawVersion.label || version.label,
      builtAt: rawVersion.builtAt || version.builtAt,
      trainingClipCount: Number(rawVersion.trainingClipCount) || version.trainingClipCount
    });
  }

  if (profile?.voiceModel?.engine) {
    const activeId = sanitizeUnicodeText(profile.activeModelVersionId || profile.voiceModel.versionId || voiceModelVersionId(profile, profile.voiceModel));
    if (!seen.has(activeId)) {
      versions.unshift(createVoiceModelVersion(profile, profile.voiceModel, activeId));
    }
  }
  return versions;
}

function profileWithActiveVoiceModelVersion(profile) {
  const versions = normalizeVoiceModelVersions(profile);
  const activeModelVersionId = sanitizeUnicodeText(
    profile?.activeModelVersionId
    || profile?.voiceModel?.versionId
    || versions[0]?.id
    || ""
  );
  const activeVersion = versions.find((version) => version.id === activeModelVersionId) || versions[0] || null;
  const activeVersionId = activeVersion?.id || activeModelVersionId;
  const shouldRestoreActiveModel = Boolean(
    activeVersion?.voiceModel?.engine
    && activeVersion?.voiceModel?.modelPath
    && (
      !profile?.voiceModel?.engine
      || !profile?.voiceModel?.modelPath
      || profile?.status !== "ready"
      || (activeVersionId && profile?.voiceModel?.versionId && profile.voiceModel.versionId !== activeVersionId)
    )
  );
  const model = shouldRestoreActiveModel
    ? sanitizeStructuredText({
        ...activeVersion.voiceModel,
        versionId: activeVersionId
      })
    : profile?.voiceModel;
  return sanitizeStructuredText({
    ...profile,
    status: shouldRestoreActiveModel ? "ready" : profile?.status,
    engine: shouldRestoreActiveModel
      ? normalizeVoiceEngine(model.engine || activeVersion.engine || profile?.engine, { language: profile?.language })
      : profile?.engine,
    qualityMode: shouldRestoreActiveModel ? model.qualityMode || activeVersion.qualityMode || profile?.qualityMode || "" : profile?.qualityMode,
    voiceModel: model,
    modelVersion: shouldRestoreActiveModel
      ? model.modelVersion || activeVersion.modelVersion || voiceEngineModelVersion(model.engine || activeVersion.engine || profile?.engine)
      : profile?.modelVersion,
    activeModelVersionId: activeVersionId,
    modelVersions: versions.map((version) => ({
      ...version,
      active: version.id === activeVersionId
    }))
  });
}

function applyVoiceModelVersion(profile, version) {
  const model = sanitizeStructuredText({
    ...(version.voiceModel || {}),
    versionId: version.id
  });
  Object.assign(profile, {
    status: "ready",
    engine: normalizeVoiceEngine(model.engine || version.engine || profile.engine, { language: profile.language }),
    qualityMode: model.qualityMode || version.qualityMode || profile.qualityMode || "",
    voiceModel: model,
    modelVersion: model.modelVersion || version.modelVersion || voiceEngineModelVersion(model.engine || version.engine || profile.engine),
    activeModelVersionId: version.id,
    modelVersions: normalizeVoiceModelVersions({
      ...profile,
      voiceModel: model,
      activeModelVersionId: version.id
    }).map((item) => ({ ...item, active: item.id === version.id })),
    updatedAt: new Date().toISOString()
  });
}

function collectVoiceModelAbsolutePaths(value, output = []) {
  if (typeof value === "string") {
    if (path.isAbsolute(value)) {
      output.push(path.resolve(value));
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectVoiceModelAbsolutePaths(item, output);
    }
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectVoiceModelAbsolutePaths(item, output);
    }
  }
  return output;
}

function pathIsInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function normalizeVoicePreparationArtifactPath(candidateDir, value) {
  if (!value || !path.isAbsolute(value)) {
    return "";
  }
  try {
    // Python's Path.resolve() expands Windows junctions while Node's
    // path.resolve() does not. Compare the real locations for containment,
    // then return the path through candidateDir so the later atomic rename can
    // translate it into the committed revision directory.
    const [realCandidateDir, realValue] = await Promise.all([
      fs.realpath(candidateDir),
      fs.realpath(value)
    ]);
    if (!pathIsInside(realCandidateDir, realValue)) {
      return "";
    }
    return path.join(candidateDir, path.relative(realCandidateDir, realValue));
  } catch {
    return "";
  }
}

function voiceModelArtifactCandidates(profile, version) {
  const profileRoot = path.resolve(voiceProfileFolder(profile.id));
  const versionId = sanitizeUnicodeText(version?.id || "").toLowerCase();
  const model = version?.voiceModel || {};
  const candidates = new Map();
  const add = (value, kind) => {
    if (!value || !path.isAbsolute(value)) {
      return;
    }
    const resolved = path.resolve(value);
    if (resolved === profileRoot || !pathIsInside(profileRoot, resolved)) {
      return;
    }
    candidates.set(`${kind}:${resolved.toLowerCase()}`, { path: resolved, kind });
  };
  const addVersionDirectory = (value, { allowSpecificRun = false } = {}) => {
    if (!value || !path.isAbsolute(value)) {
      return;
    }
    const resolved = path.resolve(value);
    const includesVersionId = versionId && resolved.toLowerCase().includes(versionId);
    if (includesVersionId || allowSpecificRun) {
      add(resolved, "directory");
    }
  };

  for (const key of [
    "modelPath",
    "referenceAudioPath",
    "promptAudioPath",
    "datasetListPath",
    "speakerEmbeddingPath",
    "gptWeightsPath",
    "sovitsWeightsPath",
    "s1ConfigPath",
    "s2ConfigPath",
    "s2SemanticConfigPath"
  ]) {
    add(model[key], "file");
  }
  for (const value of model.auxiliaryReferenceAudioPaths || []) {
    add(value, "file");
  }

  addVersionDirectory(model.fineTuneRunDir, { allowSpecificRun: true });
  addVersionDirectory(model.trainingDir);
  addVersionDirectory(model.datasetDir);
  if (model.modelPath) {
    addVersionDirectory(path.dirname(model.modelPath));
  }
  if (model.referenceAudioPath) {
    addVersionDirectory(path.dirname(model.referenceAudioPath));
  }

  return [...candidates.values()].sort((left, right) => right.path.length - left.path.length);
}

function resolveVoiceProfileForV2v(profile, versionId = "") {
  const restoredProfile = profileWithActiveVoiceModelVersion(profile);
  const versions = normalizeVoiceModelVersions(restoredProfile);
  const requestedVersionId = sanitizeUnicodeText(versionId);
  const currentEngine = restoredProfile.voiceModel?.engine || restoredProfile.engine;
  const currentSupportsV2v = restoredProfile.status === "ready" && voiceEngineSupportsV2v(currentEngine) && restoredProfile.voiceModel?.modelPath;
  const v2vVersions = versions.filter((version) => (
    version.voiceModel?.modelPath
    && voiceEngineSupportsV2v(version.voiceModel?.engine || version.engine)
  ));
  const version = requestedVersionId
    ? v2vVersions.find((item) => item.id === requestedVersionId)
    : (currentSupportsV2v
        ? versions.find((item) => item.id === restoredProfile.activeModelVersionId) || null
        : v2vVersions[0] || null);
  if (requestedVersionId && !version) {
    throw new Error("Choose an OpenVoice V2 saved version for Voice to Voice.");
  }
  if (version?.voiceModel?.engine) {
    return {
      profile: sanitizeStructuredText({
        ...restoredProfile,
        status: "ready",
        engine: normalizeVoiceEngine(version.voiceModel.engine || version.engine, { language: restoredProfile.language }),
        qualityMode: version.voiceModel.qualityMode || version.qualityMode || restoredProfile.qualityMode || "",
        voiceModel: {
          ...version.voiceModel,
          versionId: version.id
        },
        modelVersion: version.voiceModel.modelVersion || version.modelVersion || restoredProfile.modelVersion || "",
        activeModelVersionId: restoredProfile.activeModelVersionId
      }),
      version
    };
  }
  if (currentSupportsV2v) {
    return {
      profile: restoredProfile,
      version: null
    };
  }
  throw new Error("Voice to Voice needs an OpenVoice V2 saved version for this profile. Build a V2V version before converting source audio.");
}

function voiceModelReferenceAudioPath(voiceModel) {
  return sanitizeUnicodeText(
    voiceModel?.referenceAudioPath
    || voiceModel?.refAudioPath
    || voiceModel?.promptAudioPath
    || ""
  );
}

function resolveVoiceProfileForSeedV2v(profile, versionId = "") {
  const restoredProfile = profileWithActiveVoiceModelVersion(profile);
  const versions = normalizeVoiceModelVersions(restoredProfile);
  const requestedVersionId = sanitizeUnicodeText(versionId);
  const referenceVersions = versions.filter((version) => voiceModelReferenceAudioPath(version.voiceModel));
  const currentReferencePath = voiceModelReferenceAudioPath(restoredProfile.voiceModel);
  const version = requestedVersionId
    ? referenceVersions.find((item) => item.id === requestedVersionId)
    : (referenceVersions.find((item) => item.id === restoredProfile.activeModelVersionId || item.active)
      || referenceVersions[0]
      || null);
  if (requestedVersionId && !version) {
    throw new Error("Choose a saved target voice version with reference audio for high-quality Voice to Voice.");
  }
  if (version?.voiceModel) {
    return {
      profile: sanitizeStructuredText({
        ...restoredProfile,
        status: "ready",
        voiceModel: {
          ...version.voiceModel,
          versionId: version.id
        },
        activeModelVersionId: restoredProfile.activeModelVersionId
      }),
      version,
      referenceAudioPath: voiceModelReferenceAudioPath(version.voiceModel)
    };
  }
  if (currentReferencePath) {
    return {
      profile: restoredProfile,
      version: null,
      referenceAudioPath: currentReferencePath
    };
  }
  throw new Error("High-quality Voice to Voice needs a saved target voice version with clean reference audio.");
}

function migrateVoiceDb(db) {
  const profiles = Array.isArray(db.profiles) ? db.profiles.map((profile) => {
    const engine = String(profile.engine || "");
    const voiceModelEngine = String(profile.voiceModel?.engine || "");
    if (profile.status === "ready" && (retiredVoiceEngines.has(engine) || retiredVoiceEngines.has(voiceModelEngine))) {
      return {
        ...profile,
        status: "needsRebuild",
        engine: voiceNeuralEngineId,
        legacyEngine: engine || voiceModelEngine,
        voiceModel: null,
        modelVersion: "",
        analysisWarnings: Array.from(new Set([
          ...(Array.isArray(profile.analysisWarnings) ? profile.analysisWarnings : []),
          "This profile was built with the retired DSP prototype and must be rebuilt with the OpenVoice V2 neural engine."
        ])),
        updatedAt: new Date().toISOString()
      };
    }
    const normalizedEngine = normalizeVoiceEngine(engine || voiceModelEngine, { language: profile.language });
    const nextProfile = {
      ...profile,
      engine: normalizedEngine,
      conversationModel: profile.conversationModel && typeof profile.conversationModel === "object"
        ? {
            ...profile.conversationModel,
            engine: cosyVoiceStreamingEngineId,
            modelVersion: profile.conversationModel.modelVersion || cosyVoiceStreamingModelVersion,
            promptSchemaVersion: Math.max(1, Number(profile.conversationModel.promptSchemaVersion) || 1),
            supportedLanguages: ["zh", "en", "ja", "ko", "de", "es", "fr", "it", "ru"]
          }
        : null,
      voiceModel: profile.voiceModel
        ? {
            ...profile.voiceModel,
            engine: normalizeVoiceEngine(profile.voiceModel.engine || normalizedEngine, { language: profile.language })
          }
        : profile.voiceModel
    };
    return profileWithActiveVoiceModelVersion(nextProfile);
  }) : [];
  const samples = Array.isArray(db.samples) ? db.samples : [];
  for (const sample of samples) {
    for (const segment of Array.isArray(sample?.segments) ? sample.segments : []) {
      if (segment?.manualTranscriptReviewedAt && normalizeVoiceTranscript(segment.transcript)) {
        reviewPreparedTrainingClipTranscript(segment);
      }
    }
  }
  const outputs = (Array.isArray(db.outputs) ? db.outputs : []).map((output) => {
    if (!output || typeof output !== "object" || !output.settings || typeof output.settings !== "object") {
      return output;
    }
    const { humanReview: _removed, vtvCandidates: _candidateArtifactsRemoved, ...settings } = output.settings;
    return { ...output, settings };
  });
  return {
    schemaVersion: Math.max(2, Number(db.schemaVersion) || 2),
    profiles,
    samples,
    outputs,
    artifacts: Array.isArray(db.artifacts) ? db.artifacts : [],
    referencePacks: Array.isArray(db.referencePacks) ? db.referencePacks : [],
    attempts: Array.isArray(db.attempts) ? db.attempts : [],
    qualityReports: Array.isArray(db.qualityReports) ? db.qualityReports : [],
    jobs: Array.isArray(db.jobs) ? db.jobs : [],
    jobEvents: Array.isArray(db.jobEvents) ? db.jobEvents : []
  };
}

function publicConversationModel(model) {
  if (!model || typeof model !== "object") return null;
  return {
    engine: model.engine || cosyVoiceStreamingEngineId,
    modelVersion: model.modelVersion || cosyVoiceStreamingModelVersion,
    state: model.state || "not-built",
    ready: model.state === "ready",
    sourceSampleIds: Array.isArray(model.sourceSampleIds) ? model.sourceSampleIds : [],
    sourceSegmentIds: Array.isArray(model.sourceSegmentIds) ? model.sourceSegmentIds : [],
    promptSchemaVersion: Math.max(1, Number(model.promptSchemaVersion) || 1),
    primaryReferenceSegmentId: sanitizeUnicodeText(model.primaryReferenceSegmentId || ""),
    manualPrimaryReferenceSegmentId: sanitizeUnicodeText(model.manualPrimaryReferenceSegmentId || ""),
    excludedReferenceSegmentIds: Array.isArray(model.excludedReferenceSegmentIds) ? model.excludedReferenceSegmentIds.map((value) => sanitizeUnicodeText(value)).filter(Boolean) : [],
    referenceDiagnostics: Array.isArray(model.referenceDiagnostics) ? model.referenceDiagnostics.slice(0, 8).map((item) => ({
      segmentId: sanitizeUnicodeText(item?.segmentId || ""),
      sampleId: sanitizeUnicodeText(item?.sampleId || ""),
      explicitPreference: item?.explicitPreference === true,
      speechConfidence: Math.max(0, Math.min(1, Number(item?.speechConfidence) || 0)),
      transcriptConfidence: Math.max(0, Math.min(1, Number(item?.transcriptConfidence) || 0)),
      signalToNoiseDb: Math.max(0, Math.min(100, Number(item?.signalToNoiseDb) || 0)),
      clippingRatio: Math.max(0, Math.min(1, Number(item?.clippingRatio) || 0)),
      silenceRatio: Math.max(0, Math.min(1, Number(item?.silenceRatio) || 0)),
      leadingSilenceMs: Math.max(0, Math.round(Number(item?.leadingSilenceMs) || 0)),
      trailingSilenceMs: Math.max(0, Math.round(Number(item?.trailingSilenceMs) || 0)),
      durationSeconds: Math.max(0, Number(item?.durationSeconds) || 0),
      embeddingDistanceFromMedoid: Math.max(0, Number(item?.embeddingDistanceFromMedoid) || 0),
      includedInCentroid: item?.includedInCentroid !== false,
      primary: item?.primary === true,
      exclusion: sanitizeUnicodeText(item?.exclusion || "")
    })) : [],
    referenceCount: Math.max(1, Number(model.referenceCount) || (Array.isArray(model.sourceSegmentIds) ? model.sourceSegmentIds.length : 1)),
    referenceTranscriptHash: model.referenceTranscriptHash || "",
    speakerPromptId: model.speakerPromptId || "",
    builtAt: model.builtAt || "",
    warmedAt: model.warmedAt || "",
    supportedLanguages: Array.isArray(model.supportedLanguages) ? model.supportedLanguages : ["zh", "en", "ja", "ko", "de", "es", "fr", "it", "ru"],
    automaticMultilingual: true,
    bestEffortOutsideSupportedLanguages: true,
    lastBenchmark: model.lastBenchmark || null,
    error: model.error || ""
  };
}

function parseLeadingJsonDocument(raw) {
  const input = String(raw || "");
  let start = 0;
  while (start < input.length && /\s/u.test(input[start])) start += 1;
  if (input[start] !== "{" && input[start] !== "[") throw new SyntaxError("Voice database does not start with JSON.");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const character = input[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
    if (depth === 0) {
      return JSON.parse(input.slice(start, index + 1));
    }
    if (depth < 0) break;
  }
  throw new SyntaxError("Voice database contains incomplete JSON.");
}

function normalizeVoiceDb(parsed) {
  return sanitizeStructuredText(migrateVoiceDb({
    schemaVersion: Math.max(1, Number(parsed?.schemaVersion) || 1),
    profiles: Array.isArray(parsed?.profiles) ? parsed.profiles : [],
    samples: Array.isArray(parsed?.samples) ? parsed.samples : [],
    outputs: Array.isArray(parsed?.outputs) ? parsed.outputs : [],
    artifacts: Array.isArray(parsed?.artifacts) ? parsed.artifacts : (Array.isArray(parsed?.voiceCloneArtifacts) ? parsed.voiceCloneArtifacts : []),
    referencePacks: Array.isArray(parsed?.referencePacks) ? parsed.referencePacks : [],
    attempts: Array.isArray(parsed?.attempts) ? parsed.attempts : [],
    qualityReports: Array.isArray(parsed?.qualityReports) ? parsed.qualityReports : [],
    jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [],
    jobEvents: Array.isArray(parsed?.jobEvents) ? parsed.jobEvents : []
  }));
}

async function readVoiceDb() {
  const normalizeAndPersist = async (parsed) => {
    const hasLegacyReview = Array.isArray(parsed?.outputs) && parsed.outputs.some((output) => output?.settings
      && typeof output.settings === "object"
      && Object.prototype.hasOwnProperty.call(output.settings, "humanReview"));
    const normalized = normalizeVoiceDb(parsed);
    if (hasLegacyReview) await writeVoiceDb(normalized);
    return normalized;
  };
  const filePath = voiceDbPath();
  if (voiceCloneSqliteEnabled()) {
    try {
      const sqlite = readVoiceCloneSqlite(voiceCloneSqlitePath(filePath));
      if (sqlite) return normalizeAndPersist(sqlite);
    } catch (error) {
      warnDiagnostic(`SQLite voice metadata read failed; falling back to JSON: ${error.message}`);
    }
  }
  try {
    const raw = await fs.readFile(filePath, "utf8");
    try {
      return normalizeAndPersist(JSON.parse(raw));
    } catch (error) {
      const recovered = await normalizeAndPersist(parseLeadingJsonDocument(raw));
      warnDiagnostic(`Recovered Voice profile metadata with trailing corruption: ${error.message}`);
      await writeVoiceDb(recovered);
      return recovered;
    }
  } catch {
    try {
      return normalizeAndPersist(JSON.parse(await fs.readFile(`${filePath}.backup`, "utf8")));
    } catch {
      return defaultVoiceDb();
    }
  }
}

function preserveProfilesMissingFromStaleVoiceDb(nextDb, currentDb, { deletedProfileIds = [] } = {}) {
  const deletedIds = new Set((Array.isArray(deletedProfileIds) ? deletedProfileIds : []).map(String));
  const nextProfileIds = new Set((nextDb.profiles || []).map((profile) => String(profile?.id || "")).filter(Boolean));
  const preservedProfiles = (currentDb?.profiles || []).filter((profile) => {
    const profileId = String(profile?.id || "");
    return profileId && !nextProfileIds.has(profileId) && !deletedIds.has(profileId);
  });
  if (!preservedProfiles.length) return nextDb;

  const preservedProfileIds = new Set(preservedProfiles.map((profile) => String(profile.id)));
  const nextSampleIds = new Set((nextDb.samples || []).map((sample) => String(sample?.id || "")).filter(Boolean));
  const preservedSamples = (currentDb?.samples || []).filter((sample) => (
    preservedProfileIds.has(String(sample?.profileId || ""))
    && !nextSampleIds.has(String(sample?.id || ""))
  ));
  return {
    ...nextDb,
    profiles: [...preservedProfiles, ...(nextDb.profiles || [])],
    samples: [...preservedSamples, ...(nextDb.samples || [])]
  };
}

function writeVoiceDb(db, { deletedProfileIds = [] } = {}) {
  const requestedDb = sanitizeStructuredText({
    schemaVersion: Math.max(2, Number(db?.schemaVersion) || 2),
    profiles: Array.isArray(db.profiles) ? db.profiles : [],
    samples: Array.isArray(db.samples) ? db.samples : [],
    outputs: Array.isArray(db.outputs) ? db.outputs : [],
    artifacts: Array.isArray(db.artifacts) ? db.artifacts : (Array.isArray(db.voiceCloneArtifacts) ? db.voiceCloneArtifacts : []),
    referencePacks: Array.isArray(db.referencePacks) ? db.referencePacks : [],
    attempts: Array.isArray(db.attempts) ? db.attempts : [],
    qualityReports: Array.isArray(db.qualityReports) ? db.qualityReports : [],
    jobs: Array.isArray(db.jobs) ? db.jobs : [],
    jobEvents: Array.isArray(db.jobEvents) ? db.jobEvents : []
  });
  const operation = async () => {
    const filePath = voiceDbPath();
    const directory = path.dirname(filePath);
    const tempPath = path.join(directory, `.voice_clone-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    let nextDb = requestedDb;
    await fs.mkdir(directory, { recursive: true });
    try {
      try {
        const currentRaw = await fs.readFile(filePath, "utf8");
        const currentDb = normalizeVoiceDb(JSON.parse(currentRaw));
        nextDb = preserveProfilesMissingFromStaleVoiceDb(requestedDb, currentDb, { deletedProfileIds });
      } catch {
        // A missing or recovering JSON store has no newer profiles to preserve.
      }
      await fs.writeFile(tempPath, JSON.stringify(nextDb, null, 2), "utf8");
      await fs.copyFile(tempPath, `${filePath}.backup`);
      await fs.rename(tempPath, filePath);
      if (voiceCloneSqliteEnabled()) {
        writeVoiceCloneSqlite(voiceCloneSqlitePath(filePath), nextDb);
      }
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
    return nextDb;
  };
  const queued = voiceDbWriteQueue.then(operation, operation);
  voiceDbWriteQueue = queued.catch(() => {});
  return queued;
}

function persistVoiceJobSnapshot(job, patch = null) {
  if (!voiceCloneSqliteEnabled() || !job?.id) return;
  const snapshot = sanitizeStructuredText({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    message: job.message,
    profileId: job.profileId || null,
    sampleId: job.sampleId || null,
    preparationRevision: Number(job.preparationRevision) || null,
    outputId: job.outputId || null,
    result: job.result || null,
    error: job.error || null,
    diagnostics: job.diagnostics || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt
  });
  const event = sanitizeStructuredText({
    id: makeVoiceId("voice-job-event"),
    jobId: job.id,
    patch: patch || {},
    status: job.status,
    createdAt: job.updatedAt
  });
  const operation = async () => {
    const db = await readVoiceDb();
    db.jobs = [snapshot, ...(Array.isArray(db.jobs) ? db.jobs : []).filter((item) => item.id !== job.id)].slice(0, 500);
    db.jobEvents = [event, ...(Array.isArray(db.jobEvents) ? db.jobEvents : [])].slice(0, 5000);
    await writeVoiceDb(db);
  };
  voiceJobPersistenceQueue = voiceJobPersistenceQueue.then(operation, operation).catch(() => {});
}

function flushVoiceJobPersistence() {
  return voiceJobPersistenceQueue;
}

function makeVoiceId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function sanitizeStructuredText(value) {
  if (typeof value === "string") {
    return sanitizeUnicodeText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStructuredText(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [sanitizeUnicodeText(key), sanitizeStructuredText(item)]));
  }
  return value;
}

function voiceProfileFolder(profileId) {
  return path.join(voiceDataRootDir(), "profiles", profileId);
}

function voicePreparationRevisionFolder(profileId, sampleId, revision) {
  const safeRevision = Math.max(1, Math.round(Number(revision) || 1));
  return path.join(voiceProfileFolder(profileId), "samples", "prepared", sampleId, `revision-${safeRevision}`);
}

function voicePreparationCandidateFolder(profileId, sampleId, revision, jobId) {
  const safeRevision = Math.max(1, Math.round(Number(revision) || 1));
  return path.join(voiceProfileFolder(profileId), "samples", "preparing", sampleId, `revision-${safeRevision}-${jobId}`);
}

async function withKeyedVoiceLock(locks, key, operation) {
  const previous = locks.get(key) || Promise.resolve();
  let releaseCurrent;
  const current = previous.then(() => new Promise((resolve) => {
    releaseCurrent = resolve;
  }));
  locks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  }
}

async function withVoicePreparationLock(profileId, sampleId, operation) {
  // Long-running Demucs/ASR work is serialized only for one source. Database
  // commits use the short global mutation lock below, so independent sources
  // may prepare concurrently without stale JSON snapshots winning at commit.
  const key = `${String(profileId || "")}::${String(sampleId || "")}`;
  return withKeyedVoiceLock(voicePreparationLocks, key, operation);
}

async function withVoiceProfileMutationLock(profileId, operation) {
  // voice_clone.json stores every profile, sample, and output in one document.
  // A per-profile key still permits two completed jobs to overwrite each
  // other's stale document snapshot, so all short read-modify-write commits
  // share one lock while long model/preparation work remains concurrent.
  return withKeyedVoiceLock(voiceProfileMutationLocks, "voice-db", operation);
}

function voiceTempFolder() {
  return path.join(voiceDataRootDir(), "temp");
}

function voiceIngressFolder() {
  return path.join(voiceTempFolder(), "ingress");
}

function voiceJobInputsFolder(jobId) {
  return path.join(voiceTempFolder(), "jobs", sanitizeFileName(String(jobId || "voice-job")));
}

function voiceDebugRetentionPolicy() {
  const value = String(process.env.MAGICBOX_VTV_DEBUG_RETENTION || "none").trim().toLowerCase();
  return ["none", "failed", "all"].includes(value) ? value : "none";
}

function retainVoiceJobTemp(job) {
  const policy = voiceDebugRetentionPolicy();
  return policy === "all" || (policy === "failed" && ["failed", "rejected", "needs-review"].includes(job?.status));
}

function voiceIngressError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function voiceIngressResponse(response, error) {
  const status = Number(error?.status) || 400;
  const code = String(error?.code || "voice_request_failed");
  response.status(status).json({ error: sanitizeUnicodeText(error?.message || "Voice request failed."), code });
}

function normalizeVoiceIngressLimits(overrides = {}) {
  const source = overrides && typeof overrides === "object" ? overrides : {};
  const number = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
  const group = (name, defaults) => ({
    fileBytes: number(source?.[name]?.fileBytes ?? source?.[`${name}FileBytes`], defaults.fileBytes),
    requestBytes: number(source?.[name]?.requestBytes ?? source?.[`${name}RequestBytes`], defaults.requestBytes)
  });
  return {
    profile: group("profile", { fileBytes: maxVoiceTrainingSourceBytes, requestBytes: maxVoiceTrainingRequestBytes }),
    tts: group("tts", { fileBytes: 1 * 1024 * 1024, requestBytes: 2 * 1024 * 1024 }),
    v2v: group("v2v", { fileBytes: maxVoiceSampleBytes, requestBytes: 128 * 1024 * 1024 }),
    song: group("song", { fileBytes: maxVoiceSampleBytes, requestBytes: 128 * 1024 * 1024 }),
    rvcModel: group("rvcModel", { fileBytes: 1024 * 1024 * 1024, requestBytes: 2300 * 1024 * 1024 })
  };
}

function toVoiceIngressError(error) {
  if (error?.code && error?.status) return error;
  const message = sanitizeUnicodeText(error?.message || "Malformed multipart request.");
  return voiceIngressError("malformed_multipart", message, 400);
}

async function parseVoiceMultipart(request, schema) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > schema.requestBytes) {
    throw voiceIngressError("batch_too_large", "The voice upload exceeds the request size limit.", 413);
  }
  if (!/^multipart\/form-data(?:;|$)/i.test(String(request.headers["content-type"] || ""))) {
    throw voiceIngressError("malformed_multipart", "Voice uploads must use multipart/form-data.", 400);
  }

  const ingressDir = path.join(voiceIngressFolder(), makeVoiceId("voice-ingress"));
  await fs.mkdir(ingressDir, { recursive: true });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await fs.rm(ingressDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const parsed = await new Promise((resolve, reject) => {
      const fields = {};
      const files = [];
      const writes = [];
      let rawBytes = 0;
      let settled = false;
      let fileSequence = 0;
      let parser;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        request.off("aborted", onAborted);
        callback(value);
      };
      const fail = (error) => {
        const normalized = toVoiceIngressError(error);
        if (settled) return;
        try { request.unpipe(rawMeter); } catch {}
        try { rawMeter.unpipe(parser); } catch {}
        try { parser?.destroy(); } catch {}
        request.resume();
        finish(reject, normalized);
      };
      const onAborted = () => fail(voiceIngressError("malformed_multipart", "The upload was interrupted before it completed.", 400));
      const rawMeter = new Transform({
        transform(chunk, _encoding, callback) {
          rawBytes += chunk.length;
          if (rawBytes > schema.requestBytes) {
            callback(voiceIngressError("batch_too_large", "The voice upload exceeds the request size limit.", 413));
            return;
          }
          callback(null, chunk);
        }
      });

      try {
        parser = Busboy({
          headers: request.headers,
          limits: {
            fieldNameSize: 128,
            fieldSize: Math.max(256 * 1024, schema.normalFieldBytes),
            fields: 12,
            fileSize: schema.fileBytes,
            files: schema.maxFiles,
            parts: 32,
            headerPairs: 200
          }
        });
      } catch (error) {
        fail(error);
        return;
      }

      request.once("aborted", onAborted);
      rawMeter.once("error", fail);
      parser.once("error", (error) => fail(voiceIngressError("malformed_multipart", error.message || "Malformed multipart request.", 400)));
      parser.once("fieldsLimit", () => fail(voiceIngressError("invalid_field", "Too many voice upload fields.", 400)));
      parser.once("filesLimit", () => fail(voiceIngressError("too_many_files", "Too many voice upload files.", 400)));
      parser.once("partsLimit", () => fail(voiceIngressError("invalid_field", "Too many voice upload parts.", 400)));
      parser.on("field", (name, value, info) => {
        if (settled) return;
        if (!schema.fields.has(name) || Object.prototype.hasOwnProperty.call(fields, name)) {
          fail(voiceIngressError("invalid_field", "The voice upload contained an unexpected or repeated field.", 400));
          return;
        }
        const fieldLimit = schema.metadataFields.has(name) ? 256 * 1024 : schema.normalFieldBytes;
        if (info?.nameTruncated || info?.valueTruncated || Buffer.byteLength(value, "utf8") > fieldLimit) {
          fail(voiceIngressError("invalid_field", "A voice upload field exceeded its allowed size.", 400));
          return;
        }
        fields[name] = value;
      });
      parser.on("file", (fieldname, stream, info) => {
        if (settled) {
          stream.resume();
          return;
        }
        if (!schema.fileFields.has(fieldname)) {
          stream.resume();
          fail(voiceIngressError("invalid_field", "The voice upload contained an unexpected file field.", 400));
          return;
        }
        if (files.length >= schema.maxFiles) {
          stream.resume();
          fail(voiceIngressError("too_many_files", "Too many voice upload files.", 400));
          return;
        }
        const tempPath = path.join(ingressDir, `${String(++fileSequence).padStart(2, "0")}-${makeVoiceId("upload")}.part`);
        const file = {
          fieldname,
          originalname: normalizeUploadedFileName(info?.filename || "upload"),
          mimetype: info?.mimeType || "application/octet-stream",
          encoding: info?.encoding || "binary",
          path: tempPath,
          size: 0
        };
        stream.on("data", (chunk) => { file.size += chunk.length; });
        const write = pipeline(stream, createWriteStream(tempPath, { flags: "wx" })).then(() => {
          if (stream.truncated || file.size > schema.fileBytes) {
            throw voiceIngressError("file_too_large", "A voice upload file exceeded its allowed size.", 413);
          }
          files.push(file);
        }).catch((error) => {
          throw toVoiceIngressError(error);
        });
        writes.push(write);
        write.catch((error) => fail(error));
      });
      parser.once("close", () => {
        Promise.all(writes).then(
          () => finish(resolve, { body: fields, files, rawBytes, cleanup, ingressDir }),
          fail
        );
      });
      request.pipe(rawMeter).pipe(parser);
    });
    return parsed;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function sweepVoiceIngressArtifacts() {
  await fs.rm(voiceIngressFolder(), { recursive: true, force: true });
  await sweepVtvTempArtifacts({
    rootDir: voiceTempFolder(),
    orphanRoots: ["jobs"],
    removeAllOrphans: true,
    ttlMs: Math.max(60 * 60 * 1000, Number(process.env.MAGIC_BOX_VTV_TEMP_TTL_MS) || 24 * 60 * 60 * 1000)
  });
}

async function sweepLocalQualityReviewArtifacts() {
  const db = await readVoiceDb();
  const outputs = Array.isArray(db.outputs) ? db.outputs : [];
  const candidateRoot = path.join(voiceDataRootDir(), "vtv-candidates");
  for (const output of outputs) {
    if (!output?.metadataPath) continue;
    let metadata;
    try {
      metadata = JSON.parse(await fs.readFile(output.metadataPath, "utf8"));
    } catch {
      continue;
    }
    if (!metadata || typeof metadata !== "object") {
      continue;
    }
    let changed = false;
    for (const key of ["human_review", "candidates"]) {
      if (Object.prototype.hasOwnProperty.call(metadata, key)) {
        delete metadata[key];
        changed = true;
      }
    }
    if (!changed) continue;
    await fs.writeFile(output.metadataPath, JSON.stringify(metadata, null, 2), "utf8").catch(() => {});
  }
  await fs.rm(candidateRoot, { recursive: true, force: true }).catch(() => {});
  if (outputs.some((output) => output?.settings && typeof output.settings === "object"
    && (Object.prototype.hasOwnProperty.call(output.settings, "humanReview")
      || Object.prototype.hasOwnProperty.call(output.settings, "vtvCandidates")))) {
    await writeVoiceDb(db);
  }
}

function voiceDatasetSnapshotHash(profile, samples, engine = "") {
  return computeDatasetSnapshotHash({
    profileId: profile?.id,
    profileLanguage: profile?.language,
    samples,
    trainingEngine: engine || profile?.voiceModel?.engine || profile?.engine || "",
    trainingParameters: profile?.voiceModel?.trainingParameters || {}
  });
}

function voiceCloneLineage(profile, samples) {
  const model = profile?.voiceModel;
  if (!model?.engine) {
    return {
      modelState: "not-built",
      retrainRequired: false,
      currentSnapshotHash: voiceDatasetSnapshotHash(profile, samples),
      modelSnapshotHash: "",
      staleReasons: []
    };
  }
  const currentSnapshotHash = voiceDatasetSnapshotHash(profile, samples, model.engine);
  const modelSnapshotHash = sanitizeUnicodeText(model.datasetSnapshotHash || "");
  if (!modelSnapshotHash) {
    const isFine = String(profile?.qualityMode || model.qualityMode || "").toLowerCase() === "fine";
    return {
      modelState: isFine ? "untracked" : "active_legacy",
      retrainRequired: isFine,
      currentSnapshotHash,
      modelSnapshotHash: "",
      staleReasons: isFine ? ["dataset_snapshot_missing"] : []
    };
  }
  return {
    modelState: modelSnapshotHash === currentSnapshotHash ? "active" : "stale",
    retrainRequired: modelSnapshotHash !== currentSnapshotHash,
    currentSnapshotHash,
    modelSnapshotHash,
    staleReasons: modelSnapshotHash === currentSnapshotHash ? [] : ["dataset_snapshot_changed"]
  };
}

async function validateVoiceGenerationLineage(profile, samples, settings = {}) {
  const flags = voiceCloneFeatureFlags(process.env);
  const requestedQualityMode = settings.qualityMode || settings.generationQualityMode;
  const qualityMode = requestedQualityMode ? normalizeVoiceQualityMode(requestedQualityMode) : "balanced";
  const isFine = String(profile?.qualityMode || profile?.voiceModel?.qualityMode || "").toLowerCase() === "fine";
  const lineage = voiceCloneLineage(profile, samples);
  const warnings = [];
  if (flags.datasetSnapshot && isFine && lineage.modelState !== "active") {
    if (qualityMode === "strict") {
      const error = new Error("The active Fine model is stale or missing a dataset snapshot. Rebuild it before Strict generation.");
      error.code = voiceCloneErrorCodes.datasetSnapshotStale;
      error.details = lineage;
      throw error;
    }
    warnings.push(`Generation used a ${lineage.modelState} Fine model; output is not eligible for model promotion.`);
  }

  const referencePacks = profile?.voiceModel?.referencePacks && typeof profile.voiceModel.referencePacks === "object"
    ? profile.voiceModel.referencePacks
    : { gptPrompt: profile?.voiceModel?.referencePack };
  const pack = referencePacks.gptPrompt;
  const packCheck = validateReferencePackManifest(pack, {
    expectedProfileId: profile?.id,
    expectedModelVersionId: profile?.voiceModel?.versionId,
    expectedDatasetSnapshotHash: lineage.modelSnapshotHash || undefined,
    minimumArtifacts: 1
  });
  const requireReferencePack = flags.referenceStrict && flags.pipelineV2 && isFine;
  if (requireReferencePack && !packCheck.valid) {
    if (qualityMode === "strict") {
      const error = new Error(`Voice reference pack is incomplete (${packCheck.errors.join(", ")}).`);
      error.code = voiceCloneErrorCodes.referencePackIncomplete;
      error.details = packCheck;
      throw error;
    }
    warnings.push("The expected reference pack was unavailable; this output is degraded and is not eligible for model promotion.");
  } else if (pack?.artifacts?.length) {
    for (const artifact of pack.artifacts) {
      let artifactPath;
      try {
        artifactPath = resolveManagedArtifactPath(voiceDataRootDir(), artifact.relativePath);
      } catch (error) {
        if (qualityMode === "strict") throw error;
        warnings.push("A reference artifact path escaped the managed voice root; this output is degraded and is not eligible for model promotion.");
        continue;
      }
      if (!(await pathExists(artifactPath))) {
        if (qualityMode === "strict") {
          const error = new Error(`Voice reference artifact is missing: ${artifact.relativePath}`);
          error.code = voiceCloneErrorCodes.artifactNotFound;
          throw error;
        }
        warnings.push("A reference artifact is missing; this output is degraded and is not eligible for model promotion.");
        continue;
      }
      if (artifact.sha256 && (await sha256File(artifactPath)) !== String(artifact.sha256).toLowerCase()) {
        if (qualityMode === "strict") {
          const error = new Error(`Voice reference artifact hash mismatch: ${artifact.relativePath}`);
          error.code = voiceCloneErrorCodes.artifactHashMismatch;
          throw error;
        }
        warnings.push("A reference artifact changed since the model was built; this output is degraded and is not eligible for model promotion.");
      }
    }
  }
  if (requireReferencePack) {
    for (const purpose of ["seedInference", "identityEvaluation"]) {
      const requiredPack = referencePacks[purpose];
      const requiredCheck = validateReferencePackManifest(requiredPack, {
        expectedProfileId: profile?.id,
        expectedModelVersionId: profile?.voiceModel?.versionId,
        expectedDatasetSnapshotHash: lineage.modelSnapshotHash || undefined,
        minimumArtifacts: 1
      });
      if (!requiredCheck.valid) {
        if (qualityMode === "strict") {
          const error = new Error(`Voice ${purpose} reference pack is incomplete (${requiredCheck.errors.join(", ")}).`);
          error.code = voiceCloneErrorCodes.referencePackIncomplete;
          error.details = requiredCheck;
          throw error;
        }
        warnings.push(`The ${purpose} reference pack was unavailable; this output is degraded and is not eligible for model promotion.`);
        continue;
      }
      for (const artifact of requiredPack.artifacts || []) {
        let artifactPath;
        try {
          artifactPath = resolveManagedArtifactPath(voiceDataRootDir(), artifact.relativePath);
        } catch (error) {
          if (qualityMode === "strict") throw error;
          warnings.push(`The ${purpose} reference pack contains an unsafe artifact path; this output is degraded and is not eligible for model promotion.`);
          continue;
        }
        if (!(await pathExists(artifactPath))) {
          if (qualityMode === "strict") {
            const error = new Error(`Voice ${purpose} reference artifact is missing: ${artifact.relativePath}`);
            error.code = voiceCloneErrorCodes.artifactNotFound;
            throw error;
          }
          warnings.push(`A ${purpose} reference artifact is missing; this output is degraded and is not eligible for model promotion.`);
          continue;
        }
        if (artifact.sha256 && (await sha256File(artifactPath)) !== String(artifact.sha256).toLowerCase()) {
          if (qualityMode === "strict") {
            const error = new Error(`Voice ${purpose} reference artifact hash mismatch: ${artifact.relativePath}`);
            error.code = voiceCloneErrorCodes.artifactHashMismatch;
            throw error;
          }
          warnings.push(`A ${purpose} reference artifact changed since the model was built; this output is degraded and is not eligible for model promotion.`);
        }
      }
    }
  }
  return { flags, qualityMode, lineage, warnings, eligibleForPromotion: warnings.length === 0 };
}

function publicVoiceProfile(profile, samples = []) {
  const displayProfile = profileWithActiveVoiceModelVersion(profile);
  const profileSamples = samples
    .filter((sample) => sample.profileId === displayProfile.id)
    .map((sample) => publicVoiceSample(sample, displayProfile.language));
  const readyPromptCount = profileSamples.reduce((total, sample) => {
    const segmentCount = Array.isArray(sample.segments)
      ? sample.segments.filter((segment) => segment.gptSoVitsPromptReady).length
      : 0;
    return total + segmentCount + (sample.gptSoVitsPromptReady && !segmentCount ? 1 : 0);
  }, 0);
  const preparedSourceCount = samples
    .filter((sample) => sample.profileId === displayProfile.id && voiceSamplePreparationReady(sample))
    .length;
  const eligibleTrainingClipCount = profileSamples.reduce((total, sample) => total + (Array.isArray(sample.segments)
    ? sample.segments.filter((segment) => segment.qualityVerdict === "eligible" && segment.includedInFineTraining).length
    : 0), 0);
  const modelVersions = normalizeVoiceModelVersions(displayProfile);
  const activeModelVersionId = sanitizeUnicodeText(
    displayProfile.activeModelVersionId
    || displayProfile.voiceModel?.versionId
    || modelVersions[0]?.id
    || ""
  );
  return {
    ...displayProfile,
    conversationModel: publicConversationModel(displayProfile.conversationModel),
    sampleCount: profileSamples.length,
    preparedSourceCount,
    eligibleTrainingClipCount,
    gptSoVitsReadySampleCount: readyPromptCount,
    samples: profileSamples,
    activeModelVersionId,
    modelVersions: modelVersions.map((version) => ({
      ...version,
      active: version.id === activeModelVersionId
    })),
    voiceCloneLineage: voiceCloneLineage(displayProfile, samples.filter((sample) => sample.profileId === displayProfile.id)),
    localFolderPath: displayProfile.localFolderPath || voiceProfileFolder(displayProfile.id)
  };
}

async function selectConversationVoiceReferences(profile, samples, maximum = 5) {
  const rawCandidates = samples
    .filter((sample) => sample.profileId === profile.id)
    .flatMap((sample) => (Array.isArray(sample.segments) ? sample.segments : []).map((segment) => ({ sample, segment })))
    .filter(({ segment }) => {
      const duration = Number(segment.durationSeconds) || 0;
      return Boolean(
        segment.audioPath
        && normalizeVoiceTranscript(segment.transcript)
        && duration >= 3
        && duration <= 10
        && segment.qualityVerdict === "eligible"
        && segment.boundary === "complete"
      );
    });
  const candidates = await Promise.all(rawCandidates.map(async (candidate) => {
    let signal = {};
    try { signal = parseWavInfo(await fs.readFile(candidate.segment.audioPath)); } catch {}
    const speechConfidence = Math.max(0, Math.min(1, Number(candidate.segment.speechConfidence) || 0));
    const transcriptConfidence = Math.max(0, Math.min(1, Number(candidate.segment.transcriptConfidence) || 0));
    const durationSeconds = Number(candidate.segment.durationSeconds) || Number(signal.durationSeconds) || 0;
    const signalToNoiseDb = Math.max(0, Number(signal.signalToNoiseDb) || Number(candidate.segment.signalToNoiseDb) || 0);
    const clippingRatio = Math.max(0, Number(signal.clippingRatio) || 0);
    const silenceRatio = Math.max(0, Number(signal.silenceRatio) || 0);
    const leadingSilenceMs = Math.max(0, Number(signal.leadingSilenceMs) || 0);
    const trailingSilenceMs = Math.max(0, Number(signal.trailingSilenceMs) || 0);
    const explicitPreference = profile.conversationPrimaryReferenceSegmentId === candidate.segment.id ? 2 : candidate.segment.preferredPrompt ? 1 : 0;
    const durationScore = Math.max(0, 1 - Math.abs(durationSeconds - 6) / 4);
    const boundaryScore = Math.max(0, 1 - Math.min(1, (leadingSilenceMs + trailingSilenceMs) / 800));
    const rankScore = explicitPreference * 100
      + speechConfidence * 0.32
      + transcriptConfidence * 0.25
      + Math.min(1, signalToNoiseDb / 40) * 0.15
      + Math.max(0, 1 - silenceRatio) * 0.08
      + boundaryScore * 0.08
      + durationScore * 0.12
      - Math.min(1, clippingRatio * 100) * 0.5;
    return {
      ...candidate,
      diagnostic: {
        segmentId: candidate.segment.id,
        sampleId: candidate.sample.id,
        explicitPreference: Boolean(explicitPreference),
        speechConfidence: Number(speechConfidence.toFixed(3)),
        transcriptConfidence: Number(transcriptConfidence.toFixed(3)),
        signalToNoiseDb: Number(signalToNoiseDb.toFixed(2)),
        clippingRatio: Number(clippingRatio.toFixed(6)),
        silenceRatio: Number(silenceRatio.toFixed(3)),
        leadingSilenceMs: Math.round(leadingSilenceMs),
        trailingSilenceMs: Math.round(trailingSilenceMs),
        durationSeconds: Number(durationSeconds.toFixed(3)),
        rankScore: Number(rankScore.toFixed(6))
      }
    };
  }));
  candidates.sort((left, right) => right.diagnostic.rankScore - left.diagnostic.rankScore || String(left.segment.id).localeCompare(String(right.segment.id)));
  if (!candidates.length) return [];
  const selected = [];
  const selectedIds = new Set();
  // Prefer variety across uploaded recordings before filling remaining slots
  // with other high-quality segments from the same source.
  for (const candidate of candidates) {
    if (selected.some((item) => item.sample.id === candidate.sample.id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.segment.id);
    if (selected.length >= maximum) return selected;
  }
  for (const candidate of candidates) {
    if (selectedIds.has(candidate.segment.id)) continue;
    selected.push(candidate);
    if (selected.length >= maximum) break;
  }
  return selected;
}

async function buildConversationVoiceForProfile(job, profileId) {
  const health = await streamingVoiceOfflineHealth({ force: true });
  if (!health.available) {
    throw new Error(health.tts.error || health.asr.error || "Install or repair the multilingual streaming voice models first.");
  }
  const ffmpeg = await resolveMediaTool("ffmpeg");
  if (!ffmpeg) throw new Error("Bundled FFmpeg is required to prepare a conversation voice reference.");
  await withVoiceProfileMutationLock(profileId, async () => {
    const db = await readVoiceDb();
    const profile = getVoiceProfile(db, profileId);
    if (!profile) throw new Error("Voice profile was not found.");
    const selectedReferences = await selectConversationVoiceReferences(profile, db.samples);
    const selected = selectedReferences[0];
    if (!selected) {
      throw new Error("No clean 3–10 second transcript-ready recording passed the conversation voice quality gate. Review an existing clip or record a new one.");
    }
    throwIfVoiceJobCancelled(job);
    const modelDir = path.join(voiceProfileFolder(profileId), "conversation", cosyVoiceStreamingModelVersion);
    const referenceAudioPaths = [];
    const referenceTranscripts = [];
    await fs.mkdir(modelDir, { recursive: true });
    for (let index = 0; index < selectedReferences.length; index += 1) {
      const reference = selectedReferences[index];
      const referenceAudioPath = path.join(modelDir, index === 0 ? "reference-16k-mono.wav" : `reference-${String(index + 1).padStart(2, "0")}-16k-mono.wav`);
      const temporaryAudioPath = path.join(modelDir, `reference-${job.id}-${index}.tmp.wav`);
      await execFileAsync(ffmpeg.command, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", reference.segment.audioPath,
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", temporaryAudioPath
      ], { windowsHide: true, timeout: 120000, signal: job.abortController?.signal });
      await fs.rm(referenceAudioPath, { force: true });
      await fs.rename(temporaryAudioPath, referenceAudioPath);
      referenceAudioPaths.push(referenceAudioPath);
      referenceTranscripts.push(normalizeVoiceTranscript(reference.segment.transcript));
    }
    const referenceAudioPath = referenceAudioPaths[0];
    const transcript = normalizeVoiceTranscript(selected.segment.transcript);
    const transcriptHash = createHash("sha256").update(transcript, "utf8").digest("hex");
    const sourceSegmentIds = selectedReferences.map((reference) => reference.segment.id);
    const sourceSampleIds = [...new Set(selectedReferences.map((reference) => reference.sample.id))];
    const speakerPromptId = conversationPromptId(profileId, transcript, sourceSegmentIds.join("|"));
    const builtAt = new Date().toISOString();
    const promptArtifactPath = path.join(modelDir, "speaker-prompt.json");
    const speakerFeaturePath = path.join(modelDir, "speaker-features.pt");
    await fs.writeFile(promptArtifactPath, JSON.stringify({
      schemaVersion: 2,
      promptSchemaVersion: 2,
      profileId,
      speakerPromptId,
      sourceSampleId: selected.sample.id,
      sourceSegmentId: selected.segment.id,
      sourceSampleIds,
      sourceSegmentIds,
      referenceCount: referenceAudioPaths.length,
      primaryReferenceSegmentId: selected.segment.id,
      manualPrimaryReferenceSegmentId: profile.conversationPrimaryReferenceSegmentId || "",
      referenceDiagnostics: selectedReferences.map((reference) => reference.diagnostic),
      referenceTranscriptHash: transcriptHash,
      builtAt
    }, null, 2), "utf8");
    profile.conversationModel = {
      engine: cosyVoiceStreamingEngineId,
      modelVersion: cosyVoiceStreamingModelVersion,
      state: "ready",
      referenceAudioPath,
      referenceAudioPaths,
      referenceTranscripts,
      referenceTranscript: transcript,
      referenceTranscriptHash: transcriptHash,
      promptArtifactPath,
      speakerFeaturePath,
      speakerPromptId,
      sourceSampleIds,
      sourceSegmentIds,
      promptSchemaVersion: 2,
      primaryReferenceSegmentId: selected.segment.id,
      manualPrimaryReferenceSegmentId: profile.conversationPrimaryReferenceSegmentId || "",
      referenceDiagnostics: selectedReferences.map((reference) => reference.diagnostic),
      excludedReferenceSegmentIds: [],
      referenceCount: referenceAudioPaths.length,
      supportedLanguages: ["zh", "en", "ja", "ko", "de", "es", "fr", "it", "ru"],
      builtAt,
      warmedAt: "",
      lastBenchmark: null
    };
    profile.updatedAt = builtAt;
    await writeVoiceDb(db);
    job.result = { profile: publicVoiceProfile(profile, db.samples) };
  });
}

async function ensureConversationPromptV2(profileId) {
  const currentDb = await readVoiceDb();
  const currentProfile = getVoiceProfile(currentDb, profileId);
  if (!currentProfile?.conversationModel || currentProfile.conversationModel.state !== "ready" || Number(currentProfile.conversationModel.promptSchemaVersion) >= 2) return currentProfile;
  const migrationJob = { id: makeVoiceId("conversation-v2-migration"), status: "running", result: null, abortController: new AbortController() };
  await buildConversationVoiceForProfile(migrationJob, profileId);
  const migratedDb = await readVoiceDb();
  return getVoiceProfile(migratedDb, profileId);
}

function publicVoiceSynthesisAttempt(attempt) {
  return {
    clauseIndex: Math.max(0, Math.round(Number(attempt?.clauseIndex) || 0)),
    clauseTextHash: sanitizeUnicodeText(attempt?.clauseTextHash || "").slice(0, 64),
    attempt: Math.max(1, Math.round(Number(attempt?.attempt) || 1)),
    accepted: attempt?.accepted === true,
    coverage: Math.max(0, Number(attempt?.coverage) || 0),
    reason: sanitizeUnicodeText(attempt?.reason || "").slice(0, 120),
    reasons: Array.isArray(attempt?.reasons)
      ? attempt.reasons.map((reason) => sanitizeUnicodeText(reason)).filter(Boolean).slice(0, 8)
      : [],
    waveformHealth: attempt?.waveformHealth && typeof attempt.waveformHealth === "object"
      ? sanitizeStructuredText(attempt.waveformHealth)
      : {},
    advisoryAmplitude: attempt?.advisoryAmplitude === true,
    advisoryCoverage: attempt?.advisoryCoverage === true,
    selectedAsAdvisory: attempt?.selectedAsAdvisory === true,
    preset: {
      speed: Number.isFinite(Number(attempt?.preset?.speed)) ? Number(attempt.preset.speed) : null,
      seed: Number.isFinite(Number(attempt?.preset?.seed)) ? Number(attempt.preset.seed) : null,
      style: sanitizeUnicodeText(attempt?.preset?.style || "neutral").slice(0, 24),
      styleStrength: Number.isFinite(Number(attempt?.preset?.styleStrength)) ? Number(attempt.preset.styleStrength) : null,
      pitchSemitones: Number.isFinite(Number(attempt?.preset?.pitchSemitones)) ? Number(attempt.preset.pitchSemitones) : null,
      recoverySplit: sanitizeUnicodeText(attempt?.preset?.recoverySplit || "sentence").slice(0, 32),
      remediation: Array.isArray(attempt?.preset?.remediation)
        ? attempt.preset.remediation.map((item) => sanitizeUnicodeText(item)).filter(Boolean).slice(0, 6)
        : []
    }
  };
}

function publicVoiceOutputSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const safe = {};
  const scalarKeys = [
    "speed",
    "pitch",
    "styleStrength",
    "similarityStrength",
    "qualityMode",
    "refinementMode",
    "copyStyle",
    "pipeline",
    "generationPath",
    "eligibleForPromotion",
    "datasetSnapshotHash",
    "modelState",
    "modelVersion",
    "modelVersionId",
    "requestedLanguage",
    "effectiveLanguage",
    "conversionEngine",
    "engineId",
    "comparisonGroupId",
    "engineRunId",
    "executionStatus",
    "qualityStatus",
    "requestedEngine",
    "actualEngine",
    "fallbackReason",
    "conversionStrategy",
    "conversionDevice",
    "separationStrategy",
    "separationDevice",
    "mixStrategy",
    "diffusionSteps",
    "inferenceCfgRate",
    "chunkCrossfadeMs",
    "chunkOverlapFrames",
    "targetBlendRatio",
    "conversionAttemptCount",
    "conversionCoverage",
    "conversionStrictValidationAccepted",
    "conversionNeedsReview",
    "vtvPipelineVersion",
    "vtvCandidateSeed",
    "vtvModelCheckpointSha256",
    "vtvModelConfigSha256",
    "nativeSampleRate",
    "conversionAdvisoryAmplitudeWarning",
    "sourceTranscriptTokenCount",
    "separationOverlap",
    "separationShifts",
    "sourceDurationSeconds",
    "sourceNativeSampleRate",
    "sourceNativeChannels",
    "convertedDurationSeconds",
    "conversionOnsetLagMs",
    "sourceChannels",
    "parserWarningCount",
    "synthesisWarningCount"
  ];
  for (const key of scalarKeys) {
    const value = source[key];
    if (typeof value === "string") {
      safe[key] = sanitizeUnicodeText(value).slice(0, 160);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      safe[key] = value;
    } else if (typeof value === "boolean") {
      safe[key] = value;
    }
  }
  if (source.lineage && typeof source.lineage === "object") {
    safe.lineage = {
      datasetSnapshotHash: sanitizeUnicodeText(source.lineage.datasetSnapshotHash || "").slice(0, 128),
      modelVersionId: sanitizeUnicodeText(source.lineage.modelVersionId || "").slice(0, 160),
      checkpointHash: sanitizeUnicodeText(source.lineage.checkpointHash || "").slice(0, 128),
      referencePackId: sanitizeUnicodeText(source.lineage.referencePackId || "").slice(0, 160),
      referencePackHash: sanitizeUnicodeText(source.lineage.referencePackHash || "").slice(0, 128),
      qualityPolicyVersion: sanitizeUnicodeText(source.lineage.qualityPolicyVersion || voiceQualityPolicyVersion).slice(0, 80),
      modelState: sanitizeUnicodeText(source.lineage.modelState || "").slice(0, 32),
      referenceState: sanitizeUnicodeText(source.lineage.referenceState || "").slice(0, 48)
    };
  }
  if (source.vtvLineage && typeof source.vtvLineage === "object") {
    safe.vtvLineage = sanitizeStructuredText(source.vtvLineage);
  }
  if (source.vtvReferencePack && typeof source.vtvReferencePack === "object") {
    safe.vtvReferencePack = sanitizeStructuredText(source.vtvReferencePack);
  }
  if (source.vtvQuality && typeof source.vtvQuality === "object") {
    safe.vtvQuality = sanitizeStructuredText(source.vtvQuality);
  }
  if (source.finalMixGate && typeof source.finalMixGate === "object") {
    safe.finalMixGate = {
      passed: source.finalMixGate.passed === true,
      sampleRate: Number.isFinite(Number(source.finalMixGate.sampleRate)) ? Number(source.finalMixGate.sampleRate) : null,
      channels: Number.isFinite(Number(source.finalMixGate.channels)) ? Number(source.finalMixGate.channels) : null,
      bitsPerSample: Number.isFinite(Number(source.finalMixGate.bitsPerSample)) ? Number(source.finalMixGate.bitsPerSample) : null,
      durationSeconds: Number.isFinite(Number(source.finalMixGate.durationSeconds)) ? Number(source.finalMixGate.durationSeconds) : null,
      reasons: Array.isArray(source.finalMixGate.reasons) ? source.finalMixGate.reasons.map((reason) => sanitizeUnicodeText(reason)).slice(0, 8) : []
    };
  }
  if (source.stemGate && typeof source.stemGate === "object") {
    safe.stemGate = sanitizeStructuredText(source.stemGate);
  }
  if (source.sharedArtifactHashes && typeof source.sharedArtifactHashes === "object") {
    safe.sharedArtifactHashes = {
      sourceHash: sanitizeUnicodeText(source.sharedArtifactHashes.sourceHash || "").slice(0, 128),
      stemHash: sanitizeUnicodeText(source.sharedArtifactHashes.stemHash || "").slice(0, 128),
      accompanimentHash: sanitizeUnicodeText(source.sharedArtifactHashes.accompanimentHash || "").slice(0, 128)
    };
  }
  if (source.targetArtifact && typeof source.targetArtifact === "object") {
    safe.targetArtifact = {
      artifactId: sanitizeUnicodeText(source.targetArtifact.artifactId || source.targetArtifact.modelId || "").slice(0, 160),
      sha256: sanitizeUnicodeText(source.targetArtifact.sha256 || source.targetArtifact.weights?.sha256 || "").slice(0, 128),
      type: sanitizeUnicodeText(source.targetArtifact.type || "").slice(0, 64)
    };
  }
  if (source.runtimeLineage && typeof source.runtimeLineage === "object") {
    safe.runtimeLineage = {
      engineId: sanitizeUnicodeText(source.runtimeLineage.engineId || "").slice(0, 96),
      runtimeVersion: sanitizeUnicodeText(source.runtimeLineage.runtimeVersion || "").slice(0, 160),
      sourceRevision: sanitizeUnicodeText(source.runtimeLineage.sourceRevision || "").slice(0, 160),
      runtimeManifestSha256: sanitizeUnicodeText(source.runtimeLineage.runtimeManifestSha256 || "").slice(0, 128)
    };
  }
  if (source.qualityReport && typeof source.qualityReport === "object") {
    const report = source.qualityReport;
    const safeSection = (section) => ({
      status: sanitizeUnicodeText(section?.status || "").slice(0, 32),
      passed: section?.passed === true,
      reasons: Array.isArray(section?.reasons)
        ? section.reasons.map((reason) => sanitizeUnicodeText(reason).slice(0, 120)).filter(Boolean).slice(0, 12)
        : []
    });
    safe.qualityReport = {
      qualityReportId: sanitizeUnicodeText(report.qualityReportId || "").slice(0, 96),
      policyVersion: sanitizeUnicodeText(report.policyVersion || voiceQualityPolicyVersion).slice(0, 80),
      qualityMode: normalizeVoiceQualityMode(report.qualityMode, "balanced"),
      content: {
        ...safeSection(report.content),
        orderedCoverage: Number.isFinite(Number(report.content?.orderedCoverage)) ? Number(report.content.orderedCoverage) : null,
        forcedAlignmentPass: report.content?.forcedAlignmentPass === true,
        repeatedTokenCase: report.content?.repeatedTokenCase === true,
        secondaryAsr: report.content?.secondaryAsr && typeof report.content.secondaryAsr === "object"
          ? {
              available: report.content.secondaryAsr.available === true,
              coverage: Number.isFinite(Number(report.content.secondaryAsr.coverage)) ? Number(report.content.secondaryAsr.coverage) : null,
              model: sanitizeUnicodeText(report.content.secondaryAsr.model || "").slice(0, 120),
              error: sanitizeUnicodeText(report.content.secondaryAsr.error || "").slice(0, 240)
            }
          : null
      },
      identity: {
        ...safeSection(report.identity),
        disagreement: Number.isFinite(Number(report.identity?.disagreement)) ? Number(report.identity.disagreement) : null,
        encoderA: { score: Number.isFinite(Number(report.identity?.encoderA?.score)) ? Number(report.identity.encoderA.score) : null, passed: report.identity?.encoderA?.passed === true },
        encoderB: { score: Number.isFinite(Number(report.identity?.encoderB?.score)) ? Number(report.identity.encoderB.score) : null, passed: report.identity?.encoderB?.passed === true }
      },
      perceptual: {
        ...safeSection(report.perceptual),
        available: report.perceptual?.available === true,
        utmos: Number.isFinite(Number(report.perceptual?.utmos)) ? Number(report.perceptual.utmos) : null,
        dnsMos: report.perceptual?.dnsMos && typeof report.perceptual.dnsMos === "object" ? sanitizeStructuredText(report.perceptual.dnsMos) : null,
        nisqa: report.perceptual?.nisqa && typeof report.perceptual.nisqa === "object" ? sanitizeStructuredText(report.perceptual.nisqa) : null
      },
      artifacts: {
        ...safeSection(report.artifacts),
        criticalArtifactDetected: report.artifacts?.criticalArtifactDetected === true,
        clipping: report.artifacts?.clipping === true,
        clickPop: report.artifacts?.clickPop === true,
        lineHum: report.artifacts?.lineHum === true,
        boundaryDiscontinuity: report.artifacts?.boundaryDiscontinuity === true
      },
      decision: {
        accepted: report.decision?.accepted === true,
        reasons: Array.isArray(report.decision?.reasons)
          ? report.decision.reasons.map((reason) => sanitizeUnicodeText(reason).slice(0, 120)).filter(Boolean).slice(0, 16)
          : []
      }
    };
  }
  if (Array.isArray(source.attempts)) {
    safe.attempts = source.attempts.map((attempt) => sanitizeStructuredText(attempt)).slice(0, 120);
  }
  if (source.synthesisIntegrity && typeof source.synthesisIntegrity === "object") {
    const integrity = source.synthesisIntegrity;
    safe.synthesisIntegrity = {
      coverage: Math.max(0, Number(integrity.coverage) || 0),
      waveformHealth: integrity.waveformHealth && typeof integrity.waveformHealth === "object"
        ? sanitizeStructuredText(integrity.waveformHealth)
        : {},
      attempts: Array.isArray(integrity.attempts)
        ? integrity.attempts.map(publicVoiceSynthesisAttempt).slice(0, 120)
        : [],
      clauses: Array.isArray(integrity.clauses)
        ? integrity.clauses.map((clause) => ({
          index: Math.max(0, Math.round(Number(clause?.index) || 0)),
          textHash: sanitizeUnicodeText(clause?.textHash || "").slice(0, 64),
          selectedAttempt: Number.isFinite(Number(clause?.selectedAttempt))
            ? Math.max(1, Math.round(Number(clause.selectedAttempt)))
            : null,
          advisoryAmplitudeWarning: clause?.advisoryAmplitudeWarning === true,
          advisoryCoverageWarning: clause?.advisoryCoverageWarning === true,
          attempts: Array.isArray(clause?.attempts)
            ? clause.attempts.map(publicVoiceSynthesisAttempt).slice(0, 3)
            : []
        })).slice(0, 80)
        : [],
      final: {
        accepted: integrity.final?.accepted === true,
        strictValidationAccepted: integrity.final?.strictValidationAccepted === true,
        advisoryAmplitudeWarning: integrity.final?.advisoryAmplitudeWarning === true,
        advisoryCoverageWarning: integrity.final?.advisoryCoverageWarning === true,
        coverage: Math.max(0, Number(integrity.final?.coverage) || 0),
        reason: sanitizeUnicodeText(integrity.final?.reason || "").slice(0, 120),
        reasons: Array.isArray(integrity.final?.reasons)
          ? integrity.final.reasons.map((reason) => sanitizeUnicodeText(reason)).filter(Boolean).slice(0, 8)
          : []
      }
    };
  }
  if (source.songIntegrity && typeof source.songIntegrity === "object") {
    const integrity = source.songIntegrity;
    const safeMetrics = (metrics) => {
      const sourceMetrics = metrics && typeof metrics === "object" ? metrics : {};
      const keys = [
        "sourceDurationSeconds",
        "convertedDurationSeconds",
        "durationDeltaPercent",
        "onsetLagMs",
        "sourceVoicedFrames",
        "pairedVoicedFrames",
        "voicedDropoutPercent",
        "medianPitchErrorCents",
        "pitchOver100CentsPercent",
        "abruptPitchJumpCount",
        "abruptPitchJumpsPerMinute",
        "sourceTargetSimilarity",
        "targetSimilarity",
        "targetSimilarityFloor",
        "targetReferenceCount"
      ];
      return Object.fromEntries(keys.flatMap((key) => (
        Number.isFinite(Number(sourceMetrics[key])) ? [[key, Number(sourceMetrics[key])]] : []
      )));
    };
    const safeAttempt = (attempt) => ({
      phase: sanitizeUnicodeText(attempt?.phase || "").slice(0, 40),
      attempt: Math.max(1, Math.round(Number(attempt?.attempt) || 1)),
      accepted: attempt?.accepted === true,
      selectedForFinalVerification: attempt?.selectedForFinalVerification === true,
      score: Number.isFinite(Number(attempt?.score)) ? Number(attempt.score) : 0,
      reasons: Array.isArray(attempt?.reasons)
        ? attempt.reasons.map((reason) => sanitizeUnicodeText(reason).slice(0, 80)).filter(Boolean).slice(0, 8)
        : [],
      metrics: safeMetrics(attempt?.metrics),
      repairedPhraseCount: Math.max(0, Math.round(Number(attempt?.repairedPhraseCount) || 0))
    });
    safe.songIntegrity = {
      accepted: integrity.accepted === true,
      strictValidationAccepted: integrity.strictValidationAccepted === true,
      advisoryAccepted: integrity.advisoryAccepted === true,
      advisoryReasons: Array.isArray(integrity.advisoryReasons)
        ? integrity.advisoryReasons.map((reason) => sanitizeUnicodeText(reason).slice(0, 80)).filter(Boolean).slice(0, 8)
        : [],
      fullAttemptCount: Math.max(1, Math.min(2, Math.round(Number(integrity.fullAttemptCount) || 1))),
      repairedPhraseCount: Math.max(0, Math.min(8, Math.round(Number(integrity.repairedPhraseCount) || 0))),
      phraseConversionBudget: Math.max(0, Math.min(24, Math.round(Number(integrity.phraseConversionBudget) || 0))),
      phraseConversionAttempts: Math.max(0, Math.min(24, Math.round(Number(integrity.phraseConversionAttempts) || 0))),
      phraseConversionBudgetExhausted: integrity.phraseConversionBudgetExhausted === true,
      targetReferenceStrategy: sanitizeUnicodeText(integrity.targetReferenceStrategy || "").slice(0, 80),
      targetReferenceClipCount: Math.max(1, Math.min(16, Math.round(Number(integrity.targetReferenceClipCount) || 1))),
      targetReferenceDurationSeconds: Math.max(0, Number(integrity.targetReferenceDurationSeconds) || 0),
      attempts: Array.isArray(integrity.attempts) ? integrity.attempts.map(safeAttempt).slice(0, 24) : [],
      final: {
        accepted: integrity.final?.accepted === true,
        score: Number.isFinite(Number(integrity.final?.score)) ? Number(integrity.final.score) : 0,
        reasons: Array.isArray(integrity.final?.reasons)
          ? integrity.final.reasons.map((reason) => sanitizeUnicodeText(reason).slice(0, 80)).filter(Boolean).slice(0, 8)
          : [],
        metrics: safeMetrics(integrity.final?.metrics)
      },
      finalMixGate: integrity.finalMixGate && typeof integrity.finalMixGate === "object"
        ? sanitizeStructuredText(integrity.finalMixGate)
        : null
    };
  }
  if (source.gptSoVitsRequest && typeof source.gptSoVitsRequest === "object") {
    safe.gptSoVitsRequest = {
      textLang: normalizeVoiceLanguage(source.gptSoVitsRequest.textLang, { allowAuto: false }),
      promptLang: normalizeVoiceLanguage(source.gptSoVitsRequest.promptLang, { allowAuto: false }),
      sentenceCount: Math.max(0, Math.round(Number(source.gptSoVitsRequest.sentenceCount) || 0)),
      retryCount: Math.max(0, Math.round(Number(source.gptSoVitsRequest.retryCount) || 0)),
      candidateCount: Math.max(1, Math.min(3, Math.round(Number(source.gptSoVitsRequest.candidateCount) || 1))),
      selectedCandidateId: sanitizeUnicodeText(source.gptSoVitsRequest.selectedCandidateId || "").slice(0, 64),
      selectedCandidateSeed: Number.isFinite(Number(source.gptSoVitsRequest.selectedCandidateSeed))
        ? Math.max(0, Math.round(Number(source.gptSoVitsRequest.selectedCandidateSeed)))
        : null,
      candidates: Array.isArray(source.gptSoVitsRequest.candidates)
        ? source.gptSoVitsRequest.candidates.slice(0, 3).map((candidate) => ({
          id: sanitizeUnicodeText(candidate?.id || "").slice(0, 64),
          seed: Number.isFinite(Number(candidate?.seed)) ? Math.max(0, Math.round(Number(candidate.seed))) : null,
          selected: candidate?.selected === true,
          strictValidationAccepted: candidate?.strictValidationAccepted === true,
          coverage: Math.max(0, Math.min(1, Number(candidate?.coverage) || 0)),
          retryCount: Math.max(0, Math.min(12, Math.round(Number(candidate?.retryCount) || 0))),
          ...(candidate?.code ? { code: sanitizeUnicodeText(candidate.code).slice(0, 80) } : {}),
          ...(candidate?.message ? { message: sanitizeUnicodeText(candidate.message).slice(0, 600) } : {})
        }))
        : [],
      ...(source.gptSoVitsRequest.refinement && typeof source.gptSoVitsRequest.refinement === "object" ? {
        refinement: {
          applied: source.gptSoVitsRequest.refinement.applied === true,
          engine: sanitizeUnicodeText(source.gptSoVitsRequest.refinement.engine || "").slice(0, 80),
          resultType: sanitizeUnicodeText(source.gptSoVitsRequest.refinement.resultType || "").slice(0, 80),
          strategy: sanitizeUnicodeText(source.gptSoVitsRequest.refinement.strategy || "").slice(0, 120),
          similarityStrength: Math.max(0, Math.min(1, Number(source.gptSoVitsRequest.refinement.similarityStrength) || 0)),
          attemptCount: Math.max(0, Math.min(2, Math.round(Number(source.gptSoVitsRequest.refinement.attemptCount) || 0))),
          targetBlendRatio: Math.max(0, Math.min(1, Number(source.gptSoVitsRequest.refinement.targetBlendRatio) || 0)),
          coverage: Math.max(0, Math.min(1, Number(source.gptSoVitsRequest.refinement.coverage) || 0)),
          identityValidationAccepted: source.gptSoVitsRequest.refinement.identityValidationAccepted === true,
          sourceTargetSimilarity: Number.isFinite(Number(source.gptSoVitsRequest.refinement.sourceTargetSimilarity))
            ? Number(source.gptSoVitsRequest.refinement.sourceTargetSimilarity)
            : 0,
          targetSimilarity: Number.isFinite(Number(source.gptSoVitsRequest.refinement.targetSimilarity))
            ? Number(source.gptSoVitsRequest.refinement.targetSimilarity)
            : 0,
          targetSimilarityFloor: Number.isFinite(Number(source.gptSoVitsRequest.refinement.targetSimilarityFloor))
            ? Number(source.gptSoVitsRequest.refinement.targetSimilarityFloor)
            : 0,
          identityGain: Number.isFinite(Number(source.gptSoVitsRequest.refinement.identityGain))
            ? Number(source.gptSoVitsRequest.refinement.identityGain)
            : 0,
          targetReferenceStrategy: sanitizeUnicodeText(source.gptSoVitsRequest.refinement.targetReferenceStrategy || "").slice(0, 80),
          targetReferenceClipCount: Math.max(0, Math.min(16, Math.round(Number(source.gptSoVitsRequest.refinement.targetReferenceClipCount) || 0))),
          targetReferenceDurationSeconds: Math.max(0, Number(source.gptSoVitsRequest.refinement.targetReferenceDurationSeconds) || 0),
          strictValidationAccepted: source.gptSoVitsRequest.refinement.strictValidationAccepted === true,
          advisoryAmplitudeWarning: source.gptSoVitsRequest.refinement.advisoryAmplitudeWarning === true,
          advisoryCoverageWarning: source.gptSoVitsRequest.refinement.advisoryCoverageWarning === true,
          waveformHealth: source.gptSoVitsRequest.refinement.waveformHealth
            && typeof source.gptSoVitsRequest.refinement.waveformHealth === "object"
            ? sanitizeStructuredText(source.gptSoVitsRequest.refinement.waveformHealth)
            : {},
          reason: sanitizeUnicodeText(source.gptSoVitsRequest.refinement.reason || "").slice(0, 160),
          attempts: Array.isArray(source.gptSoVitsRequest.refinement.attempts)
            ? source.gptSoVitsRequest.refinement.attempts.map((attempt) => ({
              attempt: Math.max(1, Math.min(2, Math.round(Number(attempt?.attempt) || 1))),
              accepted: attempt?.accepted === true,
              stage: sanitizeUnicodeText(attempt?.stage || "").slice(0, 80),
              code: sanitizeUnicodeText(attempt?.code || "").slice(0, 80),
              message: sanitizeUnicodeText(attempt?.message || "").slice(0, 600),
              durationMs: Math.max(0, Math.round(Number(attempt?.durationMs) || 0)),
              diffusionSteps: Math.max(0, Math.round(Number(attempt?.diffusionSteps) || 0)),
              inferenceCfgRate: Number.isFinite(Number(attempt?.inferenceCfgRate)) ? Number(attempt.inferenceCfgRate) : 0,
              chunkCrossfadeMs: Math.max(0, Math.round(Number(attempt?.chunkCrossfadeMs) || 0)),
              targetBlendRatio: Math.max(0, Math.min(1, Number(attempt?.targetBlendRatio) || 0)),
              coverage: Math.max(0, Math.min(1, Number(attempt?.coverage) || 0)),
              targetSimilarity: Number.isFinite(Number(attempt?.targetSimilarity)) ? Number(attempt.targetSimilarity) : 0,
              identityGain: Number.isFinite(Number(attempt?.identityGain)) ? Number(attempt.identityGain) : 0
            })).slice(0, 2)
            : [],
          resourceCoordination: source.gptSoVitsRequest.refinement.resourceCoordination
            && typeof source.gptSoVitsRequest.refinement.resourceCoordination === "object"
            ? sanitizeStructuredText(source.gptSoVitsRequest.refinement.resourceCoordination)
            : {}
        }
      } : {})
    };
  }
  return safe;
}

function publicVoiceOutput(output) {
  return {
    id: output.id,
    mode: output.mode,
    profileId: output.profileId,
    profileName: output.profileName,
    language: output.language,
    outputPath: output.outputPath,
    outputFileName: output.outputFileName,
    metadataPath: output.metadataPath,
    durationSeconds: output.durationSeconds,
    engine: output.engine,
    textPreview: output.textPreview,
    sourceAudioName: output.sourceAudioName,
    aiGenerated: output.aiGenerated === true,
    status: output.status || (output.settings?.qualityStatus === "rejected" ? "rejected" : output.settings?.qualityStatus === "needs-review" || output.settings?.conversionNeedsReview === true ? "needs-review" : "completed"),
    settings: publicVoiceOutputSettings(output.settings),
    createdAt: output.createdAt,
    audioUrl: `/api/voice-clone/outputs/${encodeURIComponent(output.id)}/audio`
  };
}

function voiceAudioContentType(format) {
  switch (String(format || "").toLowerCase()) {
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "flac":
      return "audio/flac";
    case "ogg":
      return "audio/ogg";
    case "wav":
    default:
      return "audio/wav";
  }
}

function getVoiceProfile(db, profileId) {
  return db.profiles.find((profile) => profile.id === profileId);
}

function normalizeVoiceProfileName(value) {
  const name = sanitizeUnicodeText(value).replace(/\s+/g, " ").trim();
  if (!name) {
    throw new Error("Enter a voice profile name.");
  }
  return name.slice(0, 80);
}

function normalizeVoiceTranscript(value) {
  return sanitizeUnicodeText(value).replace(/\s+/g, " ").trim().slice(0, 2000);
}

function normalizeTranscriptLanguage(value, fallback = "zh") {
  return normalizeVoiceLanguage(value || fallback, { allowAuto: false });
}

function normalizedVoicePreparation(sample) {
  const preparation = sample?.preparation || {};
  const status = ["queued", "preparing", "ready", "needs-attention", "failed", "cancelled"].includes(preparation.status)
    ? preparation.status
    : "needs-attention";
  return {
    revision: Math.max(0, Math.round(Number(preparation.revision) || 0)),
    status,
    vocalPath: sanitizeUnicodeText(preparation.vocalPath || ""),
    accompanimentPath: sanitizeUnicodeText(preparation.accompanimentPath || ""),
    runtime: preparation.runtime && typeof preparation.runtime === "object" ? preparation.runtime : null,
    warnings: Array.isArray(preparation.warnings) ? preparation.warnings.map((warning) => sanitizeUnicodeText(warning)).slice(0, 20) : [],
    failureMessage: sanitizeUnicodeText(preparation.failureMessage || "").slice(0, 600),
    failureDismissedAt: sanitizeUnicodeText(preparation.failureDismissedAt || ""),
    completedAt: sanitizeUnicodeText(preparation.completedAt || "")
  };
}

function invalidateVoicePreparationForManualEdit(sample, message) {
  const preparation = normalizedVoicePreparation(sample);
  // A queued job has already captured the source revision, and a preparing job
  // may be about to commit derived clips.  Do not let either job replace a
  // manual edit to the source or one of its currently visible clips.
  if (!['queued', 'preparing'].includes(preparation.status)) {
    return false;
  }
  sample.preparation = {
    ...preparation,
    revision: Math.max(1, preparation.revision + 1),
    status: 'needs-attention',
    warnings: Array.from(new Set([
      ...(preparation.warnings || []),
      sanitizeUnicodeText(message || 'A source edit superseded queued Voice Preparation. Reprocess the source when ready.')
    ])).slice(0, 20)
  };
  return true;
}

function voiceSamplePreparationReady(sample) {
  const preparation = normalizedVoicePreparation(sample);
  const superseded = (preparation.warnings || []).some((warning) => /superseded queued Voice Preparation/i.test(warning));
  return Boolean(
    preparation.vocalPath
    && !["not-started", "queued", "preparing", "failed", "cancelled"].includes(preparation.status)
    && !preparation.failureMessage
    && !superseded
    && preparedVoiceAudioTrimState(sample, preparation) !== "mismatched-scoped"
  );
}

function voiceSampleTrimScope(sample) {
  const start = Number.isFinite(Number(sample?.trimStartSeconds)) && Number(sample.trimStartSeconds) >= 0
    ? Number(sample.trimStartSeconds)
    : 0;
  const end = Number.isFinite(Number(sample?.trimEndSeconds)) && Number(sample.trimEndSeconds) > start
    ? Number(sample.trimEndSeconds)
    : null;
  return {
    applied: Boolean(sample?.trimApplied || start > 0 || end !== null),
    start,
    end
  };
}

function preparedVoiceAudioTrimState(sample, preparation = normalizedVoicePreparation(sample)) {
  const trim = voiceSampleTrimScope(sample);
  const runtime = preparation.runtime && typeof preparation.runtime === "object" ? preparation.runtime : {};
  if (!runtime.sourceTrimApplied) {
    return trim.applied ? "full-source" : "exact";
  }
  const runtimeStart = Number(runtime.sourceTrimStartSeconds);
  const runtimeEnd = runtime.sourceTrimEndSeconds === null || runtime.sourceTrimEndSeconds === undefined
    ? null
    : Number(runtime.sourceTrimEndSeconds);
  const exact = Boolean(
    trim.applied
    && Number.isFinite(runtimeStart)
    && Math.abs(runtimeStart - trim.start) < 0.001
    && ((runtimeEnd === null && trim.end === null) || (Number.isFinite(runtimeEnd) && trim.end !== null && Math.abs(runtimeEnd - trim.end) < 0.001))
  );
  return exact ? "exact" : "mismatched-scoped";
}

function preparedVoiceAudioMatchesTrim(sample, preparation = normalizedVoicePreparation(sample)) {
  return preparedVoiceAudioTrimState(sample, preparation) === "exact";
}

function preparedVoiceAudioBuildTrim(sample) {
  const trimState = preparedVoiceAudioTrimState(sample);
  if (trimState === "exact") {
    return { start: null, end: null };
  }
  if (trimState === "mismatched-scoped") {
    throw new Error("The selected source range changed after vocal preparation. Reprocess the source before building this profile.");
  }
  const trim = voiceSampleTrimScope(sample);
  return { start: trim.start, end: trim.end };
}

function voicePreparedSegmentWithinSampleTrim(sample, segment) {
  const trimState = preparedVoiceAudioTrimState(sample);
  if (trimState === "exact") {
    return true;
  }
  if (trimState === "mismatched-scoped") {
    return false;
  }
  const trim = voiceSampleTrimScope(sample);
  if (!trim.applied) {
    return true;
  }
  const start = Number(segment?.startSeconds);
  const end = Number(segment?.endSeconds);
  return Boolean(
    Number.isFinite(start)
    && Number.isFinite(end)
    && start >= trim.start - 0.001
    && (trim.end === null || end <= trim.end + 0.001)
  );
}

function publicVoicePreparedSegmentTimes(sample, segment) {
  const trimState = preparedVoiceAudioTrimState(sample);
  if (trimState === "exact") {
    return {
      startSeconds: Number(segment?.startSeconds) || 0,
      endSeconds: Number(segment?.endSeconds) || 0
    };
  }
  const trim = voiceSampleTrimScope(sample);
  return {
    startSeconds: Math.max(0, (Number(segment?.startSeconds) || 0) - trim.start),
    endSeconds: Math.max(0, (Number(segment?.endSeconds) || 0) - trim.start)
  };
}

function voicePreparedSentenceEligible(segment) {
  return Boolean(
    segment?.audioPath
    && segment?.qualityVerdict === "eligible"
    && segment?.boundary === "complete"
  );
}

function voiceTrainingClipEligible(segment) {
  return Boolean(
    voicePreparedSentenceEligible(segment)
    && segment?.includeInTraining !== false
  );
}

const manualTranscriptReviewReasons = new Set([
  "speech_confidence_low",
  "transcript_confidence_low",
  "uncertain_sentence_start",
  "uncertain_sentence_boundary"
]);

function normalizedVoiceSegmentExclusionReasons(segment) {
  return Array.from(new Set(
    (Array.isArray(segment?.exclusionReasons) ? segment.exclusionReasons : [])
      .map((reason) => sanitizeUnicodeText(reason))
      .filter(Boolean)
  )).slice(0, 12);
}

function addVoiceSegmentExclusionReason(reasons, reason) {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function reviewPreparedTrainingClipTranscript(segment, { autoInclude = false } = {}) {
  const transcript = normalizeVoiceTranscript(segment?.transcript);
  const durationSeconds = Math.max(0, Number(segment?.durationSeconds) || 0);
  const speechConfidence = Math.max(0, Math.min(1, Number(segment?.speechConfidence) || 0));
  const manuallyReviewed = Boolean(transcript);
  const reasons = normalizedVoiceSegmentExclusionReasons(segment)
    .filter((reason) => !manuallyReviewed || !manualTranscriptReviewReasons.has(reason));

  // Clearing a manual transcript means that text is missing; it is not proof
  // that the audio is silent. Preserve a worker-originated no_speech_detected
  // reason from the existing list, but never manufacture one from an edit.
  if (durationSeconds < 2.5) {
    addVoiceSegmentExclusionReason(reasons, "clip_too_short");
  }
  if (durationSeconds > 10) {
    addVoiceSegmentExclusionReason(reasons, "sentence_too_long");
  }
  if (speechConfidence < 0.65 && !manuallyReviewed) {
    addVoiceSegmentExclusionReason(reasons, "speech_confidence_low");
  }

  if (manuallyReviewed) {
    segment.transcript = transcript;
    // A save is an explicit human confirmation after listening to the clip.
    // It can resolve soft ASR speech/text and boundary uncertainty, but not
    // missing audio or unsafe duration gates.
    segment.transcriptConfidence = 1;
    segment.boundary = "complete";
    segment.boundaryConfidence = 1;
    segment.manualTranscriptReviewedAt = segment.manualTranscriptReviewedAt || new Date().toISOString();
  } else {
    segment.manualTranscriptReviewedAt = "";
  }

  const eligible = Boolean(
    segment.audioPath
    && transcript
    && durationSeconds >= 2.5
    && durationSeconds <= 10
    && segment.boundary === "complete"
    && Number(segment.boundaryConfidence) >= 0.85
    && !reasons.length
  );
  const rejected = !segment.audioPath || reasons.includes("no_speech_detected");
  segment.exclusionReasons = reasons;
  segment.qualityVerdict = eligible ? "eligible" : rejected ? "rejected" : "needs-review";
  // Saving a transcript is an explicit review action, so an eligible clip is
  // included immediately. Background normalization keeps a prior manual
  // exclusion intact by leaving autoInclude disabled.
  segment.includeInTraining = eligible && (autoInclude || Boolean(segment.includeInTraining));
  segment.preferredPrompt = eligible && Boolean(segment.preferredPrompt);
  return eligible;
}

function gptSoVitsTranscriptReady(item, profileLanguage) {
  const transcript = normalizeVoiceTranscript(item?.transcript);
  const transcriptLanguage = normalizeTranscriptLanguage(item?.transcriptLanguage, profileLanguage);
  return Boolean(transcript && transcriptLanguage === normalizeVoiceLanguage(profileLanguage, { allowAuto: false }));
}

function gptSoVitsPromptDurationReady(item) {
  const duration = Number(item?.durationSeconds);
  return Number.isFinite(duration) && duration >= 3 && duration <= 10;
}

function gptSoVitsSegmentTranscriptReady(segment, profileLanguage) {
  return Boolean(voicePreparedSentenceEligible(segment) && gptSoVitsTranscriptReady(segment, profileLanguage));
}

function gptSoVitsSegmentPromptReady(segment, profileLanguage) {
  return Boolean(gptSoVitsSegmentTranscriptReady(segment, profileLanguage) && gptSoVitsPromptDurationReady(segment));
}

function gptSoVitsSegmentPromptStatus(segment, profileLanguage) {
  if (!gptSoVitsSegmentTranscriptReady(segment, profileLanguage)) {
    return "needs_transcript";
  }
  const duration = Number(segment?.durationSeconds);
  if (!Number.isFinite(duration)) {
    return "needs_duration";
  }
  if (duration < 3) {
    return "transcript_saved_too_short";
  }
  if (duration > 10) {
    return "transcript_saved_too_long";
  }
  return "prompt_ready";
}

function gptSoVitsSampleTranscriptReady(sample, profileLanguage) {
  return Boolean(voiceSamplePreparationReady(sample) && gptSoVitsTranscriptReady(sample, profileLanguage));
}

function gptSoVitsPromptReady(sample, profileLanguage) {
  return Boolean(
    voiceSamplePreparationReady(sample)
    && Array.isArray(sample?.segments)
    && sample.segments.some((segment) => (
      voicePreparedSegmentWithinSampleTrim(sample, segment)
      && gptSoVitsSegmentPromptReady(segment, profileLanguage)
    ))
  );
}

function publicVoiceSampleSegment(sample, segment, profileLanguage) {
  const transcriptLanguage = segment.transcriptLanguage || profileLanguage || "";
  const publicTimes = publicVoicePreparedSegmentTimes(sample, segment);
  return {
    ...segment,
    ...publicTimes,
    transcript: segment.transcript || "",
    transcriptLanguage,
    preferredPrompt: Boolean(segment.preferredPrompt),
    includedInFineTraining: voiceTrainingClipEligible(segment),
    qualityVerdict: ["eligible", "needs-review", "rejected"].includes(segment.qualityVerdict) ? segment.qualityVerdict : "needs-review",
    exclusionReasons: Array.isArray(segment.exclusionReasons) ? segment.exclusionReasons : ["legacy_source_requires_reprocess"],
    boundary: segment.boundary === "complete" ? "complete" : "uncertain",
    speechConfidence: Number(segment.speechConfidence) || 0,
    transcriptConfidence: Number(segment.transcriptConfidence) || 0,
    audioUrl: `/api/voice-clone/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}/audio`,
    gptSoVitsTranscriptReady: gptSoVitsSegmentTranscriptReady(segment, profileLanguage),
    gptSoVitsPromptDurationReady: gptSoVitsPromptDurationReady(segment),
    gptSoVitsPromptReady: gptSoVitsSegmentPromptReady(segment, profileLanguage),
    gptSoVitsPromptStatus: gptSoVitsSegmentPromptStatus(segment, profileLanguage)
  };
}

function publicVoiceSample(sample, profileLanguage) {
  const segments = Array.isArray(sample.segments)
    ? sample.segments
      .filter((segment) => voicePreparedSegmentWithinSampleTrim(sample, segment))
      .map((segment) => publicVoiceSampleSegment(sample, segment, profileLanguage))
    : [];
  const preparation = normalizedVoicePreparation(sample);
  const trimMismatch = Boolean(preparation.vocalPath && preparedVoiceAudioTrimState(sample, preparation) === "mismatched-scoped");
  const publicPreparation = voiceSamplePreparationReady(sample)
    ? { ...preparation, status: "ready" }
    : trimMismatch
      ? {
        ...preparation,
        status: "needs-attention",
        warnings: Array.from(new Set([
          ...(preparation.warnings || []),
          "The selected source range changed after vocal preparation. Reprocess this source before training."
        ]))
      }
      : preparation;
  return {
    ...sample,
    preparation: {
      ...publicPreparation,
      vocalAudioUrl: publicPreparation.vocalPath ? `/api/voice-clone/samples/${encodeURIComponent(sample.id)}/prepared-audio/vocal` : "",
      accompanimentAudioUrl: publicPreparation.accompanimentPath ? `/api/voice-clone/samples/${encodeURIComponent(sample.id)}/prepared-audio/accompaniment` : ""
    },
    transcript: sample.transcript || "",
    transcriptLanguage: sample.transcriptLanguage || profileLanguage || "",
    segments,
    segmentCount: segments.length,
    readySegmentCount: segments.filter((segment) => segment.gptSoVitsPromptReady).length,
    transcriptReadySegmentCount: segments.filter((segment) => segment.gptSoVitsTranscriptReady).length,
    gptSoVitsPromptReady: gptSoVitsPromptReady(sample, profileLanguage)
  };
}

function requireOptional(specifier) {
  try {
    return require(specifier);
  } catch {
    return null;
  }
}

function mediaToolExecutableName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function bundledMediaToolPath(name) {
  return path.join(rootDir, "vendor", "ffmpeg", "bin", mediaToolExecutableName(name));
}

function staticMediaToolPath(name) {
  if (name === "ffmpeg") {
    const ffmpegPath = requireOptional("ffmpeg-static");
    return typeof ffmpegPath === "string" ? ffmpegPath : "";
  }
  if (name === "ffprobe") {
    const ffprobe = requireOptional("ffprobe-static");
    return typeof ffprobe?.path === "string" ? ffprobe.path : "";
  }
  return "";
}

function voiceWorkerFfmpegPath() {
  const configured = process.env.MAGIC_BOX_FFMPEG_PATH;
  if (configured && existsSync(configured)) return configured;
  const bundled = bundledMediaToolPath("ffmpeg");
  if (existsSync(bundled)) return bundled;
  const packaged = staticMediaToolPath("ffmpeg");
  if (packaged && existsSync(packaged)) return packaged;
  return configured || bundled;
}

function mediaToolCandidates(name) {
  const envName = name === "ffmpeg" ? "MAGIC_BOX_FFMPEG_PATH" : "MAGIC_BOX_FFPROBE_PATH";
  return [
    { command: process.env[envName], source: "env" },
    { command: bundledMediaToolPath(name), source: "bundled" },
    { command: staticMediaToolPath(name), source: "package" },
    { command: name, source: "path" }
  ].filter((candidate) => candidate.command);
}

async function resolveMediaTool(name) {
  for (const candidate of mediaToolCandidates(name)) {
    try {
      await execFileAsync(candidate.command, ["-version"], { windowsHide: true, timeout: 3000 });
      return candidate;
    } catch {
    }
  }
  return null;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFileIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  await once(stream, "end");
  return hash.digest("hex");
}

async function seedVcRuntimeManifestHash() {
  const manifestPath = voiceEngineInstallStatePath(seedVcEngineId);
  if (!(await pathExists(manifestPath))) return "";
  try {
    return await sha256File(manifestPath);
  } catch {
    return "";
  }
}

async function resolveVtvInferenceArtifacts(settings = {}) {
  const rawCheckpointPath = sanitizeUnicodeText(settings.checkpointPath || settings.checkpoint_path || "").trim();
  const rawConfigPath = sanitizeUnicodeText(settings.configPath || settings.config_path || "").trim();
  const allowedRoots = [
    rootDir,
    voiceDataRootDir(),
    voiceEngineRootDir(),
    process.env.MAGIC_BOX_SEED_VC_REPO || ""
  ].filter(Boolean).map((value) => path.resolve(value));
  const resolveArtifact = async (rawPath, label) => {
    if (!rawPath) return { path: "", sha256: "" };
    const resolved = path.resolve(rootDir, rawPath);
    if (!allowedRoots.some((allowedRoot) => pathIsInside(allowedRoot, resolved))) {
      throw new Error(`VTV ${label} must stay inside a managed runtime or project artifact root.`);
    }
    if (!(await pathExists(resolved))) {
      throw new Error(`VTV ${label} was not found: ${rawPath}`);
    }
    return { path: resolved, sha256: await sha256File(resolved) };
  };
  const checkpoint = await resolveArtifact(rawCheckpointPath, "checkpoint");
  const config = await resolveArtifact(rawConfigPath, "config");
  return {
    checkpointPath: checkpoint.path,
    checkpointSha256: checkpoint.sha256,
    configPath: config.path,
    configSha256: config.sha256,
    settings: {
      ...(checkpoint.path ? { checkpointPath: checkpoint.path } : {}),
      ...(config.path ? { configPath: config.path } : {})
    }
  };
}

async function verifyOfflineChecksumManifest(rootPath, manifestPath) {
  const manifest = await readJsonFileIfExists(manifestPath);
  if (!Array.isArray(manifest?.files) || !manifest.files.length) {
    return { ok: false, error: "The installed model checksum manifest is missing." };
  }
  const root = path.resolve(rootPath);
  for (const item of manifest.files) {
    const filePath = path.resolve(root, String(item.path || ""));
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      return { ok: false, error: "The installed model checksum manifest contains an unsafe path." };
    }
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats?.isFile() || stats.size !== Number(item.bytes) || await sha256File(filePath) !== String(item.sha256 || "").toLowerCase()) {
      return { ok: false, error: `The installed model checksum is invalid for ${item.path}. Repair it before use.` };
    }
  }
  return { ok: true, fileCount: manifest.files.length };
}

let streamingVoiceHealthCache = null;
async function liveVoiceV4Eligibility() {
  const evidence = await readJsonFileIfExists(path.join(rootDir, "artifacts", "live-voice-benchmark.json"));
  const eligibleV2 = Boolean(
    evidence?.schemaVersion === 2
    && evidence?.pass === true
    && evidence?.combinedChatActive === true
    && evidence?.browserPlaybackSimulationActive === true
  );
  const eligibleV3 = Boolean(
    evidence?.schemaVersion === 3
    && evidence?.protocolVersion >= 5
    && evidence?.persistentTtsSession === true
    && evidence?.pass === true
    && evidence?.combinedChatActive === true
    && evidence?.browserPlaybackSimulationActive === true
  );
  const persistent = process.env.VOICE_PERSISTENT_TTS_SESSION === "1";
  return {
    schemaVersion: persistent ? 3 : 2,
    protocolVersion: persistent ? 5 : 4,
    schedulerMode: persistent ? "persistent-stream" : "bounded-segments",
    speechRendering: "naturalized-full",
    resourceProfile: "balanced-local",
    v4Eligible: eligibleV2 || eligibleV3,
    v5Eligible: eligibleV3,
    fallback: eligibleV2 || eligibleV3 ? "" : "windows-system-voice",
    benchmarkMeasuredAt: evidence?.measuredAt || ""
  };
}

async function streamingVoiceOfflineHealth({ force = false } = {}) {
  await synchronizeLiveVoiceWorker();
  if (process.env.MAGIC_BOX_VOICE_ENGINE_FAKE === "1" || process.env.MAGIC_BOX_LIVE_VOICE_FAKE === "1") {
    return {
      available: true,
      pipeline: { ...(await liveVoiceV4Eligibility()), v4Eligible: true },
      tts: { status: "ready", installed: true, runtimeReady: true, warm: true, engine: cosyVoiceStreamingEngineId },
      asr: { status: "ready", installed: true, runtimeReady: true, warm: true, engine: whisperTurboStreamingEngineId, activeModel: "large-v3-turbo" }
    };
  }
  if (!force && streamingVoiceHealthCache?.expiresAt > Date.now()) return streamingVoiceHealthCache.value;
  const qwen = approvedQwenRuntime();
  if (qwen) {
    const checks = await verifyOfflineChecksumManifest(qwen.qwenModelDir, qwen.manifest);
    const runtimeReady = await pathExists(qwen.python);
    const asrReady = await pathExists(path.join(voiceEngineRootDir(), "conversation", "asr", "models", "whisper-small-536b066", "model.bin"));
    const value = {
      available: Boolean(checks.ok && runtimeReady && asrReady),
      pipeline: { ...(await liveVoiceV4Eligibility()), v4Eligible: true },
      tts: { status: checks.ok && runtimeReady ? "ready" : "unavailable", engine: "qwen3-tts-stream-local", modelVersion: qwen.qwenModelRevision, installed: checks.ok, runtimeReady, checksumVerified: checks.ok, accelerator: "CUDA graphs", error: checks.error || (!runtimeReady ? "Qwen local runtime is missing." : "") },
      asr: { status: asrReady ? "ready" : "unavailable", engine: whisperTurboStreamingEngineId, activeModel: "small-cpu-int8", installed: asrReady, runtimeReady, error: asrReady ? "" : "The local multilingual recognition model is missing." }
    };
    streamingVoiceHealthCache = { value, expiresAt: Date.now() + 10 * 60_000 };
    return value;
  }
  const [ttsState, asrState, ttsInstalled, asrInstalled, ttsRuntimeReady, asrRuntimeReady] = await Promise.all([
    readJsonFileIfExists(voiceEngineInstallStatePath(cosyVoiceStreamingEngineId)),
    readJsonFileIfExists(voiceEngineInstallStatePath(whisperTurboStreamingEngineId)),
    voiceEngineInstalled(cosyVoiceStreamingEngineId),
    voiceEngineInstalled(whisperTurboStreamingEngineId),
    voiceEngineRuntimeReady(cosyVoiceStreamingEngineId),
    voiceEngineRuntimeReady(whisperTurboStreamingEngineId)
  ]);
  const ttsChecks = ttsInstalled && ttsState?.checksumManifest
    ? await verifyOfflineChecksumManifest(voiceEngineModelDir(cosyVoiceStreamingEngineId), ttsState.checksumManifest)
    : { ok: false, error: "Fun-CosyVoice 3 is not installed." };
  const asrChecks = asrInstalled && asrState?.checksumManifest
    ? await verifyOfflineChecksumManifest(voiceEngineModelDir(whisperTurboStreamingEngineId), asrState.checksumManifest)
    : { ok: false, error: "Whisper large-v3-turbo is not installed." };
  const ttsModelDir = voiceEngineModelDir(cosyVoiceStreamingEngineId);
  const ttsAccelerationReady = ttsState?.accelerator === "TensorRT"
    && ttsState?.acceleratorVersion === "10.13.3.9"
    && await pathExists(path.join(ttsModelDir, "flow.decoder.estimator.fp32.onnx"))
    && await pathExists(path.join(ttsModelDir, "flow.decoder.estimator.fp16.mygpu.plan"))
    && await pathExists(path.join(ttsModelDir, "flow.decoder.estimator.fp16.mygpu.json"));
  const ttsError = ttsChecks.error || (!ttsAccelerationReady ? "The validated TensorRT streaming estimator is missing. Repair it before use." : "");
  const value = {
    available: Boolean(ttsChecks.ok && ttsAccelerationReady && asrChecks.ok && ttsRuntimeReady && asrRuntimeReady),
    pipeline: await liveVoiceV4Eligibility(),
    tts: {
      status: ttsChecks.ok && ttsAccelerationReady && ttsRuntimeReady ? "ready" : ttsError.includes("checksum") || ttsError.includes("Repair") ? "unhealthy" : "unavailable",
      engine: cosyVoiceStreamingEngineId,
      modelVersion: cosyVoiceStreamingModelVersion,
      installed: ttsInstalled,
      runtimeReady: ttsRuntimeReady,
      checksumVerified: Boolean(ttsChecks.ok && ttsAccelerationReady),
      accelerator: ttsAccelerationReady ? "TensorRT" : "",
      error: ttsError
    },
    asr: {
      status: asrChecks.ok && asrRuntimeReady ? "ready" : asrChecks.error?.includes("checksum") ? "unhealthy" : "unavailable",
      engine: whisperTurboStreamingEngineId,
      modelVersion: whisperTurboStreamingModelVersion,
      installed: asrInstalled,
      runtimeReady: asrRuntimeReady,
      checksumVerified: Boolean(asrChecks.ok),
      activeModel: "large-v3-turbo",
      fallbackAvailable: Boolean(asrState?.fallbackModelDir && await pathExists(asrState.fallbackModelDir)),
      error: asrChecks.error || ""
    }
  };
  streamingVoiceHealthCache = { value, expiresAt: Date.now() + 10 * 60_000 };
  return value;
}

async function gpuAvailable() {
  if (process.env.MAGIC_BOX_VOICE_ENGINE_FAKE === "1") {
    return process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_GPU === "1";
  }
  try {
    await execFileAsync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 256 * 1024
    });
    return true;
  } catch {
    return false;
  }
}

function voiceEnginePythonPath(engine = voiceNeuralEngineId) {
  if (process.env.MAGIC_BOX_VOICE_ENGINE_PYTHON) {
    return process.env.MAGIC_BOX_VOICE_ENGINE_PYTHON;
  }
  const executable = process.platform === "win32" ? "python.exe" : "python";
  return path.join(voiceEngineRuntimeDir(engine), "python", executable);
}

function voicePreparationWorkerSourcePath() {
  return path.join(rootDir, "server", "voice_engine_worker_preparation.py");
}

function voicePreparationManagedWorkerPath() {
  return path.join(voiceEngineRuntimeDir(voicePreparationEngineId), "voice_preparation_worker.py");
}

async function synchronizeManagedVoiceFile(sourcePath, targetPath) {
  const source = await fs.readFile(sourcePath);
  const target = await fs.readFile(targetPath).catch(() => null);
  if (target && Buffer.compare(source, target) === 0) return false;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, source);
  await fs.rename(temporaryPath, targetPath);
  return true;
}

async function synchronizeVoicePreparationWorker() {
  if (
    process.env.MAGIC_BOX_VOICE_ENGINE_FAKE === "1"
    || process.env.MAGIC_BOX_VOICE_ENGINE_WORKER
    || process.env.MAGIC_BOX_VOICE_PREPARATION_WORKER
  ) {
    return false;
  }
  const sourcePath = voicePreparationWorkerSourcePath();
  const targetPath = voicePreparationManagedWorkerPath();
  try {
    return await synchronizeManagedVoiceFile(sourcePath, targetPath);
  } catch {
    // A missing managed runtime is handled by the normal setup path. Do not
    // prevent the health endpoint from explaining that setup is required.
    return false;
  }
}

async function synchronizeSeedVcWorker() {
  if (
    process.env.MAGIC_BOX_VOICE_ENGINE_FAKE === "1"
    || process.env.MAGIC_BOX_VOICE_ENGINE_WORKER
    || process.env.MAGIC_BOX_SEED_VC_WORKER
  ) {
    return false;
  }
  const runtimeDir = voiceEngineRuntimeDir(seedVcEngineId);
  try {
    const results = await Promise.all([
      synchronizeManagedVoiceFile(
        path.join(rootDir, "server", "voice_engine_worker_seed_vc.py"),
        path.join(runtimeDir, "seed_vc_worker.py")
      ),
      synchronizeManagedVoiceFile(
        path.join(rootDir, "server", "seed_vc_inference_wrapper.py"),
        path.join(runtimeDir, "seed_vc_inference_wrapper.py")
      )
    ]);
    return results.some(Boolean);
  } catch {
    // The setup and health paths report missing runtimes. Synchronization must
    // not hide the actionable installation state.
    return false;
  }
}

async function synchronizeGptSoVitsWorker() {
  if (
    process.env.MAGIC_BOX_VOICE_ENGINE_FAKE === "1"
    || process.env.MAGIC_BOX_VOICE_ENGINE_WORKER
    || process.env.MAGIC_BOX_GPT_SOVITS_WORKER
  ) {
    return false;
  }
  try {
    return await synchronizeManagedVoiceFile(
      path.join(rootDir, "server", "voice_engine_worker_gpt_sovits.py"),
      path.join(voiceEngineRuntimeDir(gptSoVitsEngineId), "gpt_sovits_worker.py")
    );
  } catch {
    // The normal runtime readiness path reports a missing managed worker. Do
    // not make health or startup fail only because synchronization is not yet
    // possible; the setup path remains the source of truth.
    return false;
  }
}

async function synchronizeLiveVoiceWorker() {
  if (process.env.MAGIC_BOX_VOICE_ENGINE_FAKE === "1" || process.env.MAGIC_BOX_LIVE_VOICE_FAKE === "1" || process.env.MAGIC_BOX_VOICE_ENGINE_WORKER) return false;
  const pythonPath = voiceEnginePythonPath(cosyVoiceStreamingEngineId);
  if (!await pathExists(pythonPath)) return false;
  const sourcePath = path.join(rootDir, "server", "live_voice_worker.py");
  const targetPath = path.join(voiceEngineRuntimeDir(cosyVoiceStreamingEngineId), "live_voice_worker.py");
  try {
    const source = await fs.readFile(sourcePath);
    const target = await fs.readFile(targetPath).catch(() => null);
    if (target && Buffer.compare(source, target) === 0) return false;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, source);
    await fs.rename(temporaryPath, targetPath);
    return true;
  } catch {
    return false;
  }
}

function voiceEngineWorkerCommand(engine = voiceNeuralEngineId) {
  if (process.env.MAGIC_BOX_VOICE_ENGINE_FAKE === "1") {
    return {
      command: process.execPath,
      args: [path.join(rootDir, "server", "voice_engine_worker_fake.mjs")],
      source: "fake"
    };
  }
  if (process.env.MAGIC_BOX_VOICE_ENGINE_WORKER) {
    const workerPath = process.env.MAGIC_BOX_VOICE_ENGINE_WORKER;
    if (path.extname(workerPath).toLowerCase() === ".py") {
      return {
        command: voiceEnginePythonPath(engine),
        args: [workerPath],
        source: "env"
      };
    }
    return {
      command: workerPath,
      args: [],
      source: "env"
    };
  }
  if (engine === cosyVoiceStreamingEngineId || engine === whisperTurboStreamingEngineId) {
    const qwen = approvedQwenRuntime();
    if (qwen) return { command: qwen.python, args: [path.join(rootDir, "server", "live_voice_worker.py")], source: "managed-qwen3" };
    return {
      command: voiceEnginePythonPath(engine),
      args: [path.join(voiceEngineRuntimeDir(engine), "live_voice_worker.py")],
      source: "managed"
    };
  }
  if (engine === voicePreparationEngineId) {
    if (process.env.MAGIC_BOX_VOICE_PREPARATION_WORKER) {
      const workerPath = process.env.MAGIC_BOX_VOICE_PREPARATION_WORKER;
      if (path.extname(workerPath).toLowerCase() === ".py") {
        return {
          command: voiceEnginePythonPath(engine),
          args: [workerPath],
          source: "env"
        };
      }
      return {
        command: workerPath,
        args: [],
        source: "env"
      };
    }
    return {
      command: voiceEnginePythonPath(engine),
      args: [path.join(voiceEngineRuntimeDir(engine), "voice_preparation_worker.py")],
      source: "managed"
    };
  }
  if (engine === seedVcEngineId) {
    if (process.env.MAGIC_BOX_SEED_VC_WORKER) {
      const workerPath = process.env.MAGIC_BOX_SEED_VC_WORKER;
      if (path.extname(workerPath).toLowerCase() === ".py") {
        return {
          command: voiceEnginePythonPath(engine),
          args: [workerPath],
          source: "env"
        };
      }
      return {
        command: workerPath,
        args: [],
        source: "env"
      };
    }
    return {
      command: voiceEnginePythonPath(engine),
      args: [path.join(voiceEngineRuntimeDir(engine), "seed_vc_worker.py")],
      source: "managed"
    };
  }
  if (engine === gptSoVitsEngineId) {
    if (process.env.MAGIC_BOX_GPT_SOVITS_WORKER) {
      const workerPath = process.env.MAGIC_BOX_GPT_SOVITS_WORKER;
      if (path.extname(workerPath).toLowerCase() === ".py") {
        return {
          command: voiceEnginePythonPath(engine),
          args: [workerPath],
          source: "env"
        };
      }
      return {
        command: workerPath,
        args: [],
        source: "env"
      };
    }
    return {
      command: voiceEnginePythonPath(engine),
      args: [path.join(voiceEngineRuntimeDir(engine), "gpt_sovits_worker.py")],
      source: "managed"
    };
  }
  return {
    command: voiceEnginePythonPath(),
    args: [path.join(voiceEngineRuntimeDir(), "openvoice_worker.py")],
    source: "managed"
  };
}

async function voiceEngineRuntimeReady(engine = voiceNeuralEngineId) {
  const worker = voiceEngineWorkerCommand(engine);
  if (worker.source === "fake") {
    return true;
  }
  const commandReady = await pathExists(worker.command);
  const scriptReady = worker.args.length ? await pathExists(worker.args[0]) : true;
  return commandReady && scriptReady;
}

async function voiceEngineInstalled(engine = voiceNeuralEngineId) {
  if (process.env.MAGIC_BOX_VOICE_ENGINE_FAKE === "1") {
    return true;
  }
  const modelVersion = voiceEngineModelVersion(engine);
  const state = await readJsonFileIfExists(voiceEngineInstallStatePath(engine));
  if (state?.engine === engine && state?.modelVersion === modelVersion && state?.installed === true) {
    return true;
  }
  const readyState = await readJsonFileIfExists(path.join(voiceEngineModelDir(engine), ".ready.json"));
  return readyState?.engine === engine
    && readyState?.modelVersion === modelVersion
    && readyState?.installed === true;
}

function appendLimitedText(current, value, limit = 500000) {
  const next = `${current || ""}${value || ""}`;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function terminateVoiceWorker(child) {
  if (!child?.pid) {
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    const directKillFallback = setTimeout(() => {
      child.kill();
    }, 750);
    directKillFallback.unref();
    killer.once("close", () => {
      clearTimeout(directKillFallback);
      child.kill();
    });
    killer.unref();
    return;
  }
  child.kill("SIGTERM");
}

async function callVoiceEngineWorker(request, {
  engine = voiceNeuralEngineId,
  timeoutMs = voiceEngineRequestTimeoutMs,
  idleTimeoutMs = 0,
  onProgress = null,
  signal = null
} = {}) {
  const jobWorkers = currentVoiceJobWorkers();
  const reusableSeedAnalysis = engine === seedVcEngineId && ["analyze-song-conversion", "analyze-speaker-identity-batch", "evaluate-quality-batch", "analyze-waveform-artifacts", "calibrate-speaker-identity"].includes(request.action);
  if (jobWorkers && engine === seedVcEngineId) {
    // GPT must release its GPU weights before conversion/evaluation loads Seed.
    await jobWorkers.close(gptSoVitsEngineId);
    if (!reusableSeedAnalysis) await jobWorkers.close(seedVcEngineId);
  }
  if (engine === gptSoVitsEngineId) {
    await synchronizeGptSoVitsWorker();
  }
  if (engine === seedVcEngineId) {
    await synchronizeSeedVcWorker();
  }
  if (jobWorkers && (
    reusableSeedAnalysis || (engine === gptSoVitsEngineId && request.action === "tts-batch")
    || (engine === voicePreparationEngineId && ["validate-synthesis", "validate-synthesis-batch", "validate-synthesis-waveform-batch", "validate-conversion-batch", "trim-synthesis-clause-batch"].includes(request.action))
  )) {
    if (engine === voicePreparationEngineId) await synchronizeVoicePreparationWorker();
    return jobWorkers.request(engine, request, { timeoutMs, onProgress, signal });
  }
  const worker = voiceEngineWorkerCommand(engine);
  const payload = sanitizeStructuredText({
    id: makeVoiceId("voice-worker-request"),
    engine,
    modelVersion: voiceEngineModelVersion(engine),
    modelDir: voiceEngineModelDir(engine),
    ...request
  });
  return new Promise((resolve, reject) => {
    const child = spawn(worker.command, worker.args, {
      cwd: rootDir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
        MAGIC_BOX_VOICE_ENGINE_MODEL_DIR: voiceEngineModelDir(engine),
        MAGIC_BOX_SEED_VC_REPO: process.env.MAGIC_BOX_SEED_VC_REPO || path.join(voiceEngineRuntimeDir(seedVcEngineId), "seed-vc"),
        MAGIC_BOX_FFMPEG_PATH: voiceWorkerFfmpegPath(),
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      HF_HOME: process.env.HF_HOME || path.join(voiceEngineModelCacheDir(engine), "huggingface"),
      HF_HUB_CACHE: process.env.HF_HUB_CACHE || path.join(voiceEngineModelCacheDir(engine), "huggingface", "hub"),
      TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE || path.join(voiceEngineModelCacheDir(engine), "huggingface", "transformers"),
      TORCH_HOME: process.env.TORCH_HOME || path.join(voiceEngineModelCacheDir(engine), "torch"),
      NUMBA_CACHE_DIR: process.env.NUMBA_CACHE_DIR || path.join(voiceEngineModelCacheDir(engine), "numba"),
      // The packaged preparation worker combines CTranslate2 with ONNX
      // Runtime on Windows. Force the worker-safe compatibility value even
      // when the parent process inherited a conflicting setting.
      ...(engine === voicePreparationEngineId ? { KMP_DUPLICATE_LIB_OK: "TRUE" } : {})
    }
  });
    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let settled = false;
    let timer = null;
    let idleTimer = null;
    const workerTimeoutMs = Math.max(1000, Number(timeoutMs) || voiceEngineRequestTimeoutMs);
    const workerIdleTimeoutMs = Math.max(0, Number(idleTimeoutMs) || 0);
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      signal?.removeEventListener("abort", handleAbort);
    };
    const rejectForTimeout = (message, code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      terminateVoiceWorker(child);
      const error = new Error(message);
      error.code = code;
      reject(error);
    };
    const resetIdleTimer = () => {
      if (!workerIdleTimeoutMs || settled) {
        return;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        rejectForTimeout(
          `${engine} worker stopped reporting progress for ${Math.round(workerIdleTimeoutMs / 1000)}s.`,
          "VOICE_ENGINE_IDLE_TIMEOUT"
        );
      }, workerIdleTimeoutMs);
    };
    const handleAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      terminateVoiceWorker(child);
      const error = new Error("Voice job cancelled.");
      error.code = "VOICE_JOB_CANCELLED";
      reject(error);
    };
    const handleProgressLine = (line) => {
      if (settled || signal?.aborted) {
        return;
      }
      const cleanLine = String(line || "").trim();
      if (!cleanLine.startsWith("{")) {
        return;
      }
      try {
        const event = JSON.parse(cleanLine);
        if (event?.event === "progress" && !settled && !signal?.aborted) {
          resetIdleTimer();
          onProgress?.(sanitizeStructuredText(event));
        }
      } catch {
        // Worker stdout may contain non-JSON logging from upstream scripts.
      }
    };
    timer = setTimeout(() => {
      rejectForTimeout(`${engine} worker timed out after ${Math.round(workerTimeoutMs / 1000)}s.`, "VOICE_ENGINE_TIMEOUT");
    }, workerTimeoutMs);
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener("abort", handleAbort, { once: true });
    resetIdleTimer();

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout = appendLimitedText(stdout, text);
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() || "";
      for (const line of lines) {
        handleProgressLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimitedText(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!line) {
        reject(new Error(stderr.trim() || `${engine} worker exited with code ${code}.`));
        return;
      }
      try {
        const response = JSON.parse(line);
        if (response.event === "progress") {
          reject(new Error(`${engine} worker exited before returning a final result.`));
          return;
        }
        if (!response.ok) {
          reject(new Error(sanitizeUnicodeText(response.error || stderr.trim() || `${engine} worker failed.`)));
          return;
        }
        resolve(sanitizeStructuredText(response.result || {}));
      } catch (error) {
        reject(new Error(`${engine} worker returned invalid JSON: ${sanitizeUnicodeText(error.message)}`));
      }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function createVoiceEngineWorkerSession({
  engine = voiceNeuralEngineId,
  timeoutMs = voiceEngineRequestTimeoutMs,
  signal = null
} = {}) {
  const worker = voiceEngineWorkerCommand(engine);
  const child = spawn(worker.command, worker.args, {
    cwd: rootDir,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MAGIC_BOX_VOICE_ENGINE_MODEL_DIR: voiceEngineModelDir(engine),
      MAGIC_BOX_SEED_VC_REPO: process.env.MAGIC_BOX_SEED_VC_REPO || path.join(voiceEngineRuntimeDir(seedVcEngineId), "seed-vc"),
      MAGIC_BOX_FFMPEG_PATH: voiceWorkerFfmpegPath(),
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      HF_HOME: process.env.HF_HOME || path.join(voiceEngineModelCacheDir(engine), "huggingface"),
      HF_HUB_CACHE: process.env.HF_HUB_CACHE || path.join(voiceEngineModelCacheDir(engine), "huggingface", "hub"),
      TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE || path.join(voiceEngineModelCacheDir(engine), "huggingface", "transformers"),
      TORCH_HOME: process.env.TORCH_HOME || path.join(voiceEngineModelCacheDir(engine), "torch"),
      NUMBA_CACHE_DIR: process.env.NUMBA_CACHE_DIR || path.join(voiceEngineModelCacheDir(engine), "numba"),
      MAGIC_BOX_VOICE_QUALITY_EVALUATOR_DIR: process.env.MAGIC_BOX_VOICE_QUALITY_EVALUATOR_DIR
        || path.join(voiceEngineRootDir(), "quality-evaluators"),
      ...(engine === voicePreparationEngineId ? { KMP_DUPLICATE_LIB_OK: "TRUE" } : {})
    }
  });
  let active = null;
  let stdoutLineBuffer = "";
  let stderr = "";
  let closed = false;
  const closedPromise = new Promise((resolve) => child.once("close", resolve));
  const finishActive = (method, value) => {
    if (!active) return;
    clearTimeout(active.timer);
    const current = active;
    active = null;
    current.requestSignal?.removeEventListener("abort", current.handleRequestAbort);
    current[method](value);
  };
  const failSession = (error) => {
    closed = true;
    finishActive("reject", error);
  };
  const handleAbort = () => {
    const error = new Error("Voice job cancelled.");
    error.code = "VOICE_JOB_CANCELLED";
    terminateVoiceWorker(child);
    failSession(error);
  };
  signal?.addEventListener("abort", handleAbort, { once: true });
  child.stdout.on("data", (chunk) => {
    stdoutLineBuffer += chunk.toString("utf8");
    const lines = stdoutLineBuffer.split(/\r?\n/);
    stdoutLineBuffer = lines.pop() || "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("{") || !active) continue;
      try {
        const response = JSON.parse(line);
        if (response.id !== active.id) continue;
        if (response.event === "progress") {
          active.onProgress?.(sanitizeStructuredText(response));
          continue;
        }
        if (!response.ok) {
          const error = new Error(sanitizeUnicodeText(response.error || `${engine} worker failed.`));
          error.code = "VOICE_ENGINE_REQUEST_FAILED";
          finishActive("reject", error);
          continue;
        }
        finishActive("resolve", sanitizeStructuredText(response.result || {}));
      } catch {
        // Upstream model logging may share stdout; only valid response JSON is actionable.
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendLimitedText(stderr, chunk.toString("utf8"));
  });
  child.once("error", failSession);
  child.once("close", (code) => {
    const details = stderr.trim();
    failSession(new Error(details || `${engine} worker session exited with code ${code}.`));
  });

  return {
    async request(request, { onProgress = null, signal: requestSignal = null } = {}) {
      if (signal?.aborted || requestSignal?.aborted) {
        const error = new Error("Voice job cancelled.");
        error.code = "VOICE_JOB_CANCELLED";
        throw error;
      }
      if (closed) throw new Error(`${engine} worker session is closed.`);
      if (active) throw new Error(`${engine} worker session already has an active request.`);
      const id = makeVoiceId("voice-worker-session-request");
      const payload = sanitizeStructuredText({
        engine,
        modelVersion: voiceEngineModelVersion(engine),
        modelDir: voiceEngineModelDir(engine),
        ...request,
        id
      });
      return new Promise((resolve, reject) => {
        const handleRequestAbort = () => {
          const error = new Error("Voice job cancelled.");
          error.code = "VOICE_JOB_CANCELLED";
          terminateVoiceWorker(child);
          failSession(error);
        };
        const timer = setTimeout(() => {
          const error = new Error(`${engine} worker session timed out after ${Math.round(timeoutMs / 1000)}s.`);
          error.code = "VOICE_ENGINE_TIMEOUT";
          terminateVoiceWorker(child);
          failSession(error);
        }, Math.max(1000, Number(timeoutMs) || voiceEngineRequestTimeoutMs));
        active = { id, onProgress, resolve, reject, timer, requestSignal, handleRequestAbort };
        requestSignal?.addEventListener("abort", handleRequestAbort, { once: true });
        child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
          if (error) failSession(error);
        });
      });
    },
    async close() {
      signal?.removeEventListener("abort", handleAbort);
      if (!closed) {
        closed = true;
        child.stdin.end();
      }
      const closedNormally = await Promise.race([
        closedPromise.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000))
      ]);
      if (!closedNormally) terminateVoiceWorker(child);
    }
  };
}

const liveVoiceWorkerSessions = new Map();

async function closeLiveVoiceWorkerSessions() {
  const records = Array.from(liveVoiceWorkerSessions.values());
  liveVoiceWorkerSessions.clear();
  await Promise.all(records.map(async (record) => {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    await record.session.close().catch(() => {});
  }));
}

async function callLiveVoiceEngineWorker(request, {
  engine = gptSoVitsEngineId,
  timeoutMs = voiceEngineRequestTimeoutMs,
  onProgress = null,
  signal = null
} = {}) {
  if (engine === gptSoVitsEngineId) {
    await synchronizeGptSoVitsWorker();
  }
  let record = liveVoiceWorkerSessions.get(engine);
  if (!record) {
    record = {
      session: createVoiceEngineWorkerSession({ engine, timeoutMs }),
      tail: Promise.resolve(),
      idleTimer: null
    };
    liveVoiceWorkerSessions.set(engine, record);
  }
  if (record.idleTimer) clearTimeout(record.idleTimer);
  const run = record.tail.catch(() => {}).then(async () => {
    if (signal?.aborted) {
      const error = new Error("Voice job cancelled.");
      error.code = "VOICE_JOB_CANCELLED";
      throw error;
    }
    return record.session.request(request, { onProgress, signal });
  });
  record.tail = run.catch(() => {});
  try {
    return await run;
  } catch (error) {
    if (error.code !== "VOICE_ENGINE_REQUEST_FAILED") {
      if (liveVoiceWorkerSessions.get(engine) === record) liveVoiceWorkerSessions.delete(engine);
      await record.session.close().catch(() => {});
    }
    throw error;
  } finally {
    if (liveVoiceWorkerSessions.get(engine) === record) {
      record.idleTimer = setTimeout(() => {
        if (liveVoiceWorkerSessions.get(engine) !== record) return;
        liveVoiceWorkerSessions.delete(engine);
        void record.session.close().catch(() => {});
      }, 5 * 60 * 1000);
      record.idleTimer.unref?.();
    }
  }
}

async function voiceEngineHealth() {
  await Promise.all([
    synchronizeVoicePreparationWorker(),
    synchronizeSeedVcWorker()
  ]);
  const [
    ffmpegTool,
    ffprobeTool,
    openVoiceInstalled,
    openVoiceRuntimeReady,
    gptSoVitsInstalled,
    gptSoVitsRuntimeReady,
    seedVcInstalled,
    seedVcRuntimeReady,
    voicePreparationInstalled,
    voicePreparationRuntimeReady,
    gpuReady,
    openVoiceInstallState,
    gptSoVitsInstallState,
    seedVcInstallState,
    voicePreparationInstallState
  ] = await Promise.all([
    resolveMediaTool("ffmpeg"),
    resolveMediaTool("ffprobe"),
    voiceEngineInstalled(voiceNeuralEngineId),
    voiceEngineRuntimeReady(voiceNeuralEngineId),
    voiceEngineInstalled(gptSoVitsEngineId),
    voiceEngineRuntimeReady(gptSoVitsEngineId),
    voiceEngineInstalled(seedVcEngineId),
    voiceEngineRuntimeReady(seedVcEngineId),
    voiceEngineInstalled(voicePreparationEngineId),
    voiceEngineRuntimeReady(voicePreparationEngineId),
    gpuAvailable(),
    readJsonFileIfExists(voiceEngineInstallStatePath(voiceNeuralEngineId)),
    readJsonFileIfExists(voiceEngineInstallStatePath(gptSoVitsEngineId)),
    readJsonFileIfExists(voiceEngineInstallStatePath(seedVcEngineId)),
    readJsonFileIfExists(voiceEngineInstallStatePath(voicePreparationEngineId))
  ]);
  let openVoiceWorker = null;
  if (openVoiceInstalled && openVoiceRuntimeReady) {
    try {
      openVoiceWorker = await callVoiceEngineWorker({ action: "health" }, { engine: voiceNeuralEngineId, timeoutMs: 15000 });
    } catch (error) {
      openVoiceWorker = { error: error.message };
    }
  }
  let gptSoVitsWorker = null;
  if (gptSoVitsInstalled && gptSoVitsRuntimeReady) {
    try {
      gptSoVitsWorker = await callVoiceEngineWorker({ action: "health" }, { engine: gptSoVitsEngineId, timeoutMs: 15000 });
    } catch (error) {
      gptSoVitsWorker = { error: error.message };
    }
  }
  const openVoiceUsable = Boolean(openVoiceInstalled && openVoiceRuntimeReady && openVoiceWorker && !openVoiceWorker.error);
  const gptSoVitsWorkerReady = Boolean(
    gptSoVitsInstalled &&
    gptSoVitsRuntimeReady &&
    gptSoVitsWorker &&
    !gptSoVitsWorker.error &&
    gptSoVitsWorker.runtimeReady !== false &&
    gptSoVitsWorker.installed !== false
  );
  const gptSoVitsUsable = gptSoVitsWorkerReady;
  let seedVcWorker = null;
  if (seedVcInstalled && seedVcRuntimeReady) {
    try {
      seedVcWorker = await callVoiceEngineWorker({ action: "health" }, { engine: seedVcEngineId, timeoutMs: 30000 });
    } catch (error) {
      seedVcWorker = { error: error.message };
    }
  }
  const seedVcUsable = Boolean(
    seedVcInstalled
    && seedVcRuntimeReady
    && seedVcWorker
    && !seedVcWorker.error
    && seedVcWorker.runtimeReady !== false
    && seedVcWorker.conversionReady !== false
    && seedVcWorker.separationReady !== false
  );
  let voicePreparationWorker = null;
  if (voicePreparationInstalled && voicePreparationRuntimeReady) {
    try {
      voicePreparationWorker = await callVoiceEngineWorker({ action: "health" }, { engine: voicePreparationEngineId, timeoutMs: 30000 });
    } catch (error) {
      voicePreparationWorker = { error: error.message };
    }
  }
  const voicePreparationUsable = Boolean(
    voicePreparationInstalled
    && voicePreparationRuntimeReady
    && voicePreparationWorker
    && !voicePreparationWorker.error
    && voicePreparationWorker.runtimeReady !== false
    && voicePreparationWorker.separationReady !== false
    && voicePreparationWorker.asrReady !== false
    && voicePreparationWorker.modelsReady !== false
  );
  const modernVtvRuntimeState = async (engineId) => {
    const modernEngineRoot = path.join(voiceDataRootDir(), "engines");
    const activePath = path.join(modernEngineRoot, engineId, "active.json");
    const active = await readJsonFileIfExists(activePath);
    const version = String(active?.activeVersion || "");
    const manifest = version
      ? await readJsonFileIfExists(path.join(modernEngineRoot, engineId, "versions", version, "runtime-manifest.json"))
      : null;
    return {
      enabled: true,
      available: Boolean(manifest?.smokeTest?.passed === true),
      installed: Boolean(manifest),
      runtimeReady: Boolean(manifest?.pythonExecutable && manifest?.workerEntry),
      workerReady: Boolean(manifest?.smokeTest?.passed === true),
      runtimeVersion: manifest?.runtimeVersion || version || "",
      manifest,
      setupRequired: !Boolean(manifest?.smokeTest?.passed === true),
      message: manifest?.smokeTest?.passed === true ? "Pinned runtime is smoke-tested." : "Install and verify the pinned runtime before use."
    };
  };
  const modernVtvRvcState = await modernVtvRuntimeState(vtvRvcEngineId);
  const modernVtvYingState = await modernVtvRuntimeState(vtvYingMusicEngineId);
  return {
    ok: true,
    engineAvailable: openVoiceUsable || gptSoVitsUsable,
    activeEngine: gptSoVitsUsable ? gptSoVitsEngineId : voiceNeuralEngineId,
    modelVersion: gptSoVitsUsable ? gptSoVitsModelVersion : voiceNeuralModelVersion,
    installed: openVoiceInstalled || gptSoVitsInstalled,
    runtimeReady: openVoiceRuntimeReady || gptSoVitsRuntimeReady,
    workerReady: openVoiceUsable || gptSoVitsUsable,
    vtvAvailable: seedVcUsable || openVoiceUsable,
    preferredV2vEngine: seedVcUsable ? seedVcEngineId : voiceNeuralEngineId,
    workerSource: gptSoVitsUsable ? voiceEngineWorkerCommand(gptSoVitsEngineId).source : voiceEngineWorkerCommand(voiceNeuralEngineId).source,
    gpuAvailable: gpuReady,
    ffmpegAvailable: Boolean(ffmpegTool),
    ffprobeAvailable: Boolean(ffprobeTool),
    ffmpegSource: ffmpegTool?.source || "",
    ffprobeSource: ffprobeTool?.source || "",
    vtvEngines: {
      [vtvSeedEngineId]: {
        enabled: true,
        available: seedVcUsable,
        installed: seedVcInstalled,
        runtimeReady: Boolean(seedVcRuntimeReady && seedVcWorker?.runtimeReady !== false),
        workerReady: seedVcUsable,
        runtimeVersion: seedVcModelVersion,
        targetType: "song-reference-pack"
      },
      [vtvRvcEngineId]: { ...modernVtvRvcState, targetType: "rvc-pth-index" },
      [vtvYingMusicEngineId]: { ...modernVtvYingState, targetType: "yingmusic-reference-artifact" }
    },
    installState: gptSoVitsInstallState || openVoiceInstallState || null,
    modelSetup: {
      engine: voiceNeuralEngineId,
      modelVersion: voiceNeuralModelVersion,
      installed: openVoiceInstalled,
      runtimeReady: openVoiceRuntimeReady,
      workerReady: openVoiceUsable,
      modelDir: voiceEngineModelDir(voiceNeuralEngineId),
      runtimeDir: voiceEngineRuntimeDir(voiceNeuralEngineId),
      manifest: voiceModelInstallManifest,
      setupRequired: !openVoiceUsable,
      message: openVoiceUsable
        ? "OpenVoice V2 local neural engine is ready."
        : "Install the OpenVoice V2 local model package and managed Python worker before building or generating cloned voices."
    },
    engines: {
      openVoiceV2Local: {
        enabled: true,
        available: openVoiceUsable,
        installed: openVoiceInstalled,
        runtimeReady: openVoiceRuntimeReady,
        workerReady: openVoiceUsable,
        modelVersion: voiceNeuralModelVersion,
        license: "MIT"
      },
      gptSoVitsLocal: {
        enabled: true,
        available: gptSoVitsUsable,
        installed: gptSoVitsInstalled,
        runtimeReady: Boolean(gptSoVitsRuntimeReady && gptSoVitsWorker?.runtimeReady !== false),
        workerReady: gptSoVitsUsable,
        modelVersion: gptSoVitsModelVersion,
        runtimeDir: voiceEngineRuntimeDir(gptSoVitsEngineId),
        modelDir: voiceEngineModelDir(gptSoVitsEngineId),
        manifest: gptSoVitsInstallManifest,
        setupRequired: !gptSoVitsUsable,
        workerError: gptSoVitsWorker?.error || "",
        missingModelPaths: gptSoVitsWorker?.missingModelPaths || [],
        gpuAvailable: Boolean(gptSoVitsWorker?.cudaAvailable),
        device: gptSoVitsWorker?.device || "",
        gpuName: gptSoVitsWorker?.gpuName || "",
        gpuMemoryGB: Number(gptSoVitsWorker?.gpuMemoryGB) || 0,
        torchVersion: gptSoVitsWorker?.torchVersion || "",
        message: gptSoVitsWorker?.message || "",
        license: "MIT"
      },
      seedVcSingingLocal: {
        enabled: true,
        available: seedVcUsable,
        installed: seedVcInstalled,
        runtimeReady: Boolean(seedVcRuntimeReady && seedVcWorker?.runtimeReady !== false),
        workerReady: seedVcUsable,
        conversionReady: Boolean(seedVcWorker?.conversionReady),
        separationReady: Boolean(seedVcWorker?.separationReady),
        fcpeReady: Boolean(seedVcWorker?.fcpeReady || seedVcInstallState?.fcpeReady),
        roformerReady: Boolean(seedVcWorker?.roformerReady),
        modelsReady: Boolean(seedVcWorker?.modelsReady || seedVcInstallState?.modelsReady),
        gpuAvailable: Boolean(seedVcWorker?.gpuAvailable),
        device: seedVcWorker?.device || seedVcInstallState?.device || "",
        gpuName: seedVcWorker?.gpuName || "",
        torchVersion: seedVcWorker?.torchVersion || "",
        seedVcCommit: seedVcInstallState?.seedVcCommit || "",
        seedVcCommitPinned: seedVcInstallState?.seedVcCommitPinned === true,
        modelVersion: seedVcModelVersion,
        runtimeDir: voiceEngineRuntimeDir(seedVcEngineId),
        modelDir: voiceEngineModelDir(seedVcEngineId),
        manifest: seedVcInstallManifest,
        setupRequired: !seedVcUsable,
        workerError: seedVcWorker?.error || "",
        message: seedVcUsable
          ? "Demucs separation and Seed-VC singing conversion are ready."
          : "Install the high-quality VTV runtime for neural vocal separation and F0-conditioned conversion.",
        license: "GPL-3.0",
        separationLicense: "MIT"
      },
      voicePreparationLocal: {
        enabled: true,
        available: voicePreparationUsable,
        installed: voicePreparationInstalled,
        runtimeReady: Boolean(voicePreparationRuntimeReady && voicePreparationWorker?.runtimeReady !== false),
        workerReady: voicePreparationUsable,
        separationReady: Boolean(voicePreparationWorker?.separationReady),
        asrReady: Boolean(voicePreparationWorker?.asrReady),
        modelsReady: Boolean(voicePreparationWorker?.modelsReady || voicePreparationInstallState?.modelsReady),
        gpuAvailable: Boolean(voicePreparationWorker?.gpuAvailable),
        device: voicePreparationWorker?.device || voicePreparationInstallState?.device || "",
        gpuName: voicePreparationWorker?.gpuName || voicePreparationInstallState?.gpuName || "",
        torchVersion: voicePreparationWorker?.torchVersion || voicePreparationInstallState?.torchVersion || "",
        modelVersion: voicePreparationModelVersion,
        runtimeDir: voiceEngineRuntimeDir(voicePreparationEngineId),
        modelDir: voiceEngineModelDir(voicePreparationEngineId),
        manifest: voicePreparationInstallManifest,
        setupRequired: !voicePreparationUsable,
        workerError: voicePreparationWorker?.error || "",
        message: voicePreparationUsable
          ? "Local BGM separation and timestamped speech review are ready."
          : "Install Voice Preparation before new profile sources can become training-ready.",
        license: "MIT"
      },
      openVoice: { enabled: false, available: false },
      rvc: { enabled: false, available: false }
    }
  };
}

async function assertVoiceNeuralEngineReady(engine = voiceNeuralEngineId) {
  const health = await voiceEngineHealth();
  if (!health.ffmpegAvailable) {
    throw new Error("Bundled FFmpeg is required for neural voice preprocessing.");
  }
  const engineState = engine === gptSoVitsEngineId ? health.engines.gptSoVitsLocal : health.engines.openVoiceV2Local;
  if (!engineState?.installed) {
    throw new Error(`${engine === gptSoVitsEngineId ? "GPT-SoVITS" : "OpenVoice V2"} local models are not installed. Use Model Setup before building a voice profile.`);
  }
  if (!engineState.runtimeReady || !engineState.workerReady) {
    throw new Error(`${engine === gptSoVitsEngineId ? "GPT-SoVITS" : "OpenVoice V2"} local worker runtime is not ready. Install or repair the managed Python voice runtime.`);
  }
  return health;
}

async function assertVoicePreparationReady() {
  const health = await voiceEngineHealth();
  if (!health.ffmpegAvailable) {
    throw new Error("Bundled FFmpeg is required for local Voice Preparation.");
  }
  const state = health.engines?.voicePreparationLocal;
  if (!state?.installed) {
    throw new Error("Install Voice Preparation before new profile sources can be used for training.");
  }
  if (!state.runtimeReady || !state.workerReady || !state.separationReady || !state.asrReady || !state.modelsReady) {
    throw new Error("Voice Preparation is not ready. Repair the local BGM separation and speech-review runtime, then reprocess the source.");
  }
  return health;
}

async function assertSeedVcEngineReady() {
  const health = await voiceEngineHealth();
  const state = health.engines?.seedVcSingingLocal;
  if (!state?.installed) {
    throw new Error("Install the high-quality VTV runtime before using Demucs + Seed-VC conversion.");
  }
  if (!state.runtimeReady || !state.workerReady || !state.conversionReady || !state.separationReady) {
    throw new Error("The high-quality VTV worker is not ready. Repair the Seed-VC model setup and try again.");
  }
  return health;
}

async function writeVoiceEngineInstallState(state, engine = voiceNeuralEngineId) {
  const nextState = {
    engine,
    modelVersion: voiceEngineModelVersion(engine),
    installed: false,
    runtimeReady: false,
    updatedAt: new Date().toISOString(),
    ...state
  };
  await fs.mkdir(path.dirname(voiceEngineInstallStatePath(engine)), { recursive: true });
  await fs.writeFile(voiceEngineInstallStatePath(engine), JSON.stringify(nextState, null, 2), "utf8");
  return nextState;
}

function downloadVoiceArtifact(artifact, targetPath, { onProgress, redirectCount = 0 } = {}) {
  const artifactUrl = new URL(artifact.url);
  const client = artifactUrl.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(artifactUrl, {
      headers: {
        "User-Agent": browserUserAgent,
        Accept: "application/zip,application/octet-stream,*/*"
      }
    }, (response) => {
      const statusCode = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        response.resume();
        if (redirectCount >= 5) {
          reject(new Error(`Too many redirects while downloading ${artifact.id}.`));
          return;
        }
        const redirected = {
          ...artifact,
          url: new URL(response.headers.location, artifactUrl).toString()
        };
        downloadVoiceArtifact(redirected, targetPath, { onProgress, redirectCount: redirectCount + 1 })
          .then(resolve, reject);
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Download failed for ${artifact.id}: HTTP ${statusCode}.`));
        return;
      }

      const totalBytes = Number(response.headers["content-length"]) || 0;
      let receivedBytes = 0;
      response.on("data", (chunk) => {
        receivedBytes += chunk.length;
        onProgress?.({ receivedBytes, totalBytes });
      });
      pipeline(response, createWriteStream(targetPath)).then(resolve, reject);
    });
    request.setTimeout(30 * 60 * 1000, () => {
      request.destroy(new Error(`Download timed out for ${artifact.id}.`));
    });
    request.on("error", reject);
  });
}

async function expandVoiceArtifactIfNeeded(artifact, archivePath, modelDir) {
  if (path.extname(artifact.fileName || archivePath).toLowerCase() !== ".zip") {
    return null;
  }
  const extractDir = path.join(modelDir, artifact.id);
  await fs.mkdir(extractDir, { recursive: true });
  try {
    if (process.platform === "win32") {
      const powerShell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        : "powershell.exe";
      await execFileAsync(powerShell, [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        archivePath,
        extractDir
      ], { windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024 });
    } else {
      await execFileAsync("unzip", ["-o", archivePath, "-d", extractDir], {
        windowsHide: true,
        timeout: 30 * 60 * 1000,
        maxBuffer: 1024 * 1024
      });
    }
    return extractDir;
  } catch (error) {
    throw new Error(`Downloaded ${artifact.id}, but extraction failed: ${error.message}`);
  }
}

function normalizeUploadedFileName(value) {
  const raw = String(value || "");
  if (!raw) {
    return "";
  }

  try {
    const repaired = Buffer.from(raw, "latin1").toString("utf8");
    const looksRepaired = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(repaired);
    const looksMojibake = /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßåæçèé]/u.test(raw);
    if (repaired && !repaired.includes("\uFFFD") && (looksRepaired || looksMojibake)) {
      return repaired;
    }
  } catch {
  }

  return raw;
}

function validateVoiceConsent(value) {
  if (value !== true) {
    throw new Error("Confirm that you own this voice or have permission to clone it.");
  }
}

function validateVoiceExtension(filename, label = "audio file") {
  const extension = path.extname(String(filename || "")).toLowerCase();
  if (!voiceAudioExtensions.has(extension)) {
    throw voiceIngressError("invalid_media", `Unsupported ${label} type. Use WAV, MP3, M4A, FLAC, or OGG.`, 400);
  }
  return extension;
}

function normalizeTrimSeconds(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error("Trim range must use positive seconds.");
  }
  return Number(number.toFixed(3));
}

function parseVoiceTrimOptions(body = {}) {
  const start = normalizeTrimSeconds(body.trimStartSeconds ?? body.trim_start_seconds);
  const end = normalizeTrimSeconds(body.trimEndSeconds ?? body.trim_end_seconds);
  if (start !== null && end !== null && end <= start) {
    throw new Error("Trim end must be after trim start.");
  }
  return {
    start,
    end,
    applied: start !== null || end !== null
  };
}

function parseVoiceSampleMetadata(body = {}) {
  const raw = body.metadataJson ?? body.metadata_json ?? body.metadata;
  if (!raw) {
    return [];
  }
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw voiceIngressError("invalid_field", "Voice sample metadata was not valid JSON.", 400);
    }
  }
  return Array.isArray(parsed) ? parsed : [];
}

function voiceTrimOptionsFromMetadata(metadata = {}, fallback = {}) {
  const start = metadata.trimStartSeconds ?? metadata.trim_start_seconds ?? fallback.start;
  const end = metadata.trimEndSeconds ?? metadata.trim_end_seconds ?? fallback.end;
  return parseVoiceTrimOptions({
    trimStartSeconds: start,
    trimEndSeconds: end
  });
}

function roundVoiceSeconds(value) {
  return Number((Math.max(0, Number(value) || 0)).toFixed(3));
}

function applyVoiceTrimMetrics(metrics, trimOptions = {}, warnings = []) {
  if (!trimOptions.applied) {
    return {
      metrics,
      trim: {
        applied: false,
        start: null,
        end: null,
        duration: null
      }
    };
  }

  const start = Math.max(0, Number(trimOptions.start ?? 0) || 0);
  const hasEnd = trimOptions.end !== null && trimOptions.end !== undefined;
  let end = hasEnd ? Number(trimOptions.end) : null;

  if (Number(metrics.durationSeconds) > 0) {
    const sourceDuration = Number(metrics.durationSeconds);
    if (start >= sourceDuration) {
      throw new Error("Trim start is beyond the audio duration.");
    }
    end = end === null ? sourceDuration : Math.min(end, sourceDuration);
    if (end <= start) {
      throw new Error("Trim end must be after trim start.");
    }
    const duration = end - start;
    const speechRatio = sourceDuration > 0
      ? Math.max(0, Math.min(1, (Number(metrics.speechSeconds) || 0) / sourceDuration))
      : 0.9;
    return {
      metrics: {
        ...metrics,
        durationSeconds: duration,
        speechSeconds: duration * speechRatio
      },
      trim: {
        applied: true,
        start,
        end,
        duration
      }
    };
  }

  if (end === null) {
    warnings.push("Trim start was saved, but FFmpeg is needed to determine the end of this non-WAV file.");
    return {
      metrics,
      trim: {
        applied: true,
        start,
        end: null,
        duration: null
      }
    };
  }

  const duration = end - start;
  return {
    metrics: {
      ...metrics,
      durationSeconds: duration,
      speechSeconds: duration * 0.9
    },
    trim: {
      applied: true,
      start,
      end,
      duration
    }
  };
}

function wavHeaderValue(buffer, offset, method) {
  return offset + 4 <= buffer.length ? buffer[method](offset) : 0;
}

function parseWavInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error("WAV file is too small to analyze.");
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("File is not a RIFF/WAVE audio file.");
  }

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = wavHeaderValue(buffer, offset + 4, "readUInt32LE");
    const chunkStart = offset + 8;
    if (id === "fmt " && chunkStart + Math.min(size, 16) <= buffer.length) {
      const rawAudioFormat = buffer.readUInt16LE(chunkStart);
      const extensibleSubFormat = rawAudioFormat === 0xfffe && size >= 40 && chunkStart + 28 <= buffer.length
        ? buffer.readUInt32LE(chunkStart + 24)
        : 0;
      fmt = {
        audioFormat: rawAudioFormat === 0xfffe && [1, 3].includes(extensibleSubFormat) ? extensibleSubFormat : rawAudioFormat,
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14)
      };
    } else if (id === "data") {
      data = {
        offset: chunkStart,
        size: Math.min(size, Math.max(0, buffer.length - chunkStart))
      };
    }
    offset = chunkStart + size + (size % 2);
  }

  if (!fmt || !data) {
    throw new Error("WAV file is missing format or data chunks.");
  }
  if (fmt.audioFormat !== 1 && !(fmt.audioFormat === 3 && fmt.bitsPerSample === 32)) {
    throw new Error("Only PCM16 or IEEE-float32 WAV files can be analyzed without FFmpeg.");
  }

  const bytesPerFrame = Math.max(1, fmt.channels * (fmt.bitsPerSample / 8));
  const totalFrames = Math.floor(data.size / bytesPerFrame);
  const durationSeconds = fmt.sampleRate > 0 ? totalFrames / fmt.sampleRate : 0;
  let silenceRatio = 0;
  let clippingDetected = false;
  let clippingRatio = 0;
  let signalToNoiseDb = 0;
  let leadingSilenceMs = 0;
  let trailingSilenceMs = 0;
  let noiseScore = 0;
  let peakDbfs = -Infinity;
  let rmsDbfs = null;

  if (fmt.bitsPerSample === 16 && totalFrames > 0) {
    const totalSamples = totalFrames * fmt.channels;
    const step = Math.max(1, Math.floor(totalSamples / 50000));
    let checked = 0;
    let silent = 0;
    let clipped = 0;
    let loudSum = 0;
    let squareSum = 0;
    let firstVoiced = -1;
    let lastVoiced = -1;
    const amplitudes = [];
    for (let sampleIndex = 0; sampleIndex < totalSamples; sampleIndex += step) {
      const sampleOffset = data.offset + sampleIndex * 2;
      if (sampleOffset + 2 > buffer.length) {
        break;
      }
      const value = buffer.readInt16LE(sampleOffset);
      const normalized = Math.abs(value) / 32768;
      peakDbfs = Math.max(peakDbfs, 20 * Math.log10(Math.max(normalized, 1e-9)));
      if (normalized < 0.018) {
        silent += 1;
      }
      if (Math.abs(value) >= 32000) {
        clippingDetected = true;
        clipped += 1;
      }
      loudSum += normalized;
      squareSum += normalized * normalized;
      amplitudes.push(normalized);
      if (normalized >= 0.018) {
        if (firstVoiced < 0) firstVoiced = checked;
        lastVoiced = checked;
      }
      checked += 1;
    }
    silenceRatio = checked ? silent / checked : 0;
    noiseScore = checked ? Math.min(100, Math.round((loudSum / checked) * 180)) : 0;
    clippingRatio = checked ? clipped / checked : 0;
    if (checked) {
      const sortedAmplitudes = [...amplitudes].sort((left, right) => left - right);
      const quietCount = Math.max(1, Math.floor(sortedAmplitudes.length * 0.1));
      const noiseSquare = sortedAmplitudes.slice(0, quietCount).reduce((total, value) => total + value * value, 0) / quietCount;
      const signalRms = Math.sqrt(squareSum / checked);
      rmsDbfs = 20 * Math.log10(Math.max(1e-9, signalRms));
      const noiseRms = Math.max(1e-5, Math.sqrt(noiseSquare));
      signalToNoiseDb = Math.max(0, Math.min(60, 20 * Math.log10(Math.max(noiseRms, signalRms) / noiseRms)));
      leadingSilenceMs = firstVoiced < 0 ? durationSeconds * 1000 : firstVoiced / checked * durationSeconds * 1000;
      trailingSilenceMs = lastVoiced < 0 ? durationSeconds * 1000 : (checked - 1 - lastVoiced) / checked * durationSeconds * 1000;
    }
  }

  return {
    durationSeconds,
    audioFormat: fmt.audioFormat,
    speechSeconds: Math.max(0, durationSeconds * (1 - silenceRatio)),
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    silenceRatio,
    clippingDetected,
    clippingRatio,
    signalToNoiseDb,
    leadingSilenceMs,
    trailingSilenceMs,
    noiseScore,
    peakDbfs: Number.isFinite(peakDbfs) ? peakDbfs : null,
    rmsDbfs
  };
}

async function probeVoiceAudioFile(filePath, ffprobeCommand) {
  const { stdout } = await execFileAsync(ffprobeCommand, [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-of", "json",
    filePath
  ], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  const data = JSON.parse(stdout || "{}");
  const audioStream = Array.isArray(data.streams)
    ? data.streams.find((stream) => stream.codec_type === "audio") || data.streams[0]
    : null;
  const durationSeconds = Math.max(0, Number(audioStream?.duration || data.format?.duration || 0) || 0);
  const sampleRate = Math.max(0, Number(audioStream?.sample_rate || 0) || 0);
  const channels = Math.max(0, Number(audioStream?.channels || 0) || 0);
  const bitsPerSample = Math.max(0, Number(audioStream?.bits_per_sample || audioStream?.bits_per_raw_sample || 0) || 0);
  return {
    durationSeconds,
    speechSeconds: durationSeconds * 0.9,
    sampleRate,
    channels,
    bitsPerSample,
    silenceRatio: 0,
    clippingDetected: false,
    noiseScore: 24
  };
}

async function analyzeVoiceAudioBuffer(buffer, extension, profileLanguage, trimOptions = {}, filePath = "") {
  const warnings = [];
  let metrics = {
    durationSeconds: 0,
    speechSeconds: 0,
    sampleRate: 0,
    channels: 0,
    bitsPerSample: 0,
    silenceRatio: 0,
    clippingDetected: false,
    noiseScore: 0
  };

  if (extension === ".wav") {
    try {
      metrics = parseWavInfo(buffer);
    } catch (error) {
      warnings.push(error.message);
    }
  } else {
    const ffprobeTool = filePath ? await resolveMediaTool("ffprobe") : null;
    if (ffprobeTool) {
      try {
        metrics = await probeVoiceAudioFile(filePath, ffprobeTool.command);
      } catch (error) {
        warnings.push(`FFprobe could not analyze this file: ${error.message}`);
      }
    } else {
      warnings.push("Install FFmpeg to convert and deeply analyze this format.");
    }
  }

  let trim = {
    applied: false,
    start: null,
    end: null,
    duration: null
  };
  ({ metrics, trim } = applyVoiceTrimMetrics(metrics, trimOptions, warnings));
  if (trim.applied) {
    warnings.push("Using the selected trim range for this sample.");
    if (extension !== ".wav") {
      const ffmpegTool = await resolveMediaTool("ffmpeg");
      warnings.push(ffmpegTool
        ? "Selected trim is stored as metadata; real model preprocessing can physically trim this format with FFmpeg."
        : "FFmpeg is needed to physically trim this format before real model training.");
    }
  }

  if (metrics.durationSeconds > 0 && metrics.durationSeconds < 3) {
    warnings.push("Sample is too short.");
  }
  if (metrics.silenceRatio > 0.6) {
    warnings.push("Audio contains too much silence.");
  }
  if (metrics.clippingDetected) {
    warnings.push("Clipping or overload was detected.");
  }
  if (profileLanguage && profileLanguage !== "auto") {
    warnings.push("Automatic language detection is not available; confirm this sample matches the selected profile language.");
  }
  warnings.push("Single-speaker detection requires a real voice engine; use clean single-speaker audio.");

  let qualityScore = metrics.durationSeconds > 0 ? (extension === ".wav" ? 86 : 78) : 58;
  if (metrics.durationSeconds > 0 && metrics.durationSeconds < 3) {
    qualityScore -= 30;
  }
  if (metrics.silenceRatio > 0.6) {
    qualityScore -= 20;
  }
  if (metrics.clippingDetected) {
    qualityScore -= 18;
  }
  if (metrics.noiseScore > 60) {
    qualityScore -= 10;
  }

  return {
    ...metrics,
    trim,
    format: extension.slice(1) || "unknown",
    qualityScore: Math.max(0, Math.min(100, Math.round(qualityScore))),
    warnings: Array.from(new Set(warnings))
  };
}

async function saveVoiceSampleFromStagedFile(profile, file, trimOptions = {}, metadata = {}) {
  if (!file?.path || !file?.size) {
    throw voiceIngressError("invalid_media", "Choose at least one audio sample.", 400);
  }
  const extension = validateVoiceExtension(file.originalname, "sample");
  const sampleId = makeVoiceId("voice-sample");
  const originalDir = path.join(voiceProfileFolder(profile.id), "samples", "original");
  await fs.mkdir(originalDir, { recursive: true });
  const originalFileName = sanitizeFileName(normalizeUploadedFileName(file.originalname) || `sample${extension}`);
  const storedPath = path.join(originalDir, `${sampleId}-${originalFileName}`);
  await fs.rename(file.path, storedPath);
  let analysis;
  try {
    const buffer = extension === ".wav" ? await fs.readFile(storedPath) : Buffer.alloc(0);
    analysis = await analyzeVoiceAudioBuffer(buffer, extension, profile.language, trimOptions, storedPath);
  } catch (error) {
    await fs.rm(storedPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    id: sampleId,
    profileId: profile.id,
    originalFileName,
    storedPath,
    processedPath: null,
    normalizedReferenceAudioPath: null,
    durationSeconds: Number(analysis.durationSeconds.toFixed(3)),
    speechSeconds: Number(analysis.speechSeconds.toFixed(3)),
    sampleRate: analysis.sampleRate,
    channels: analysis.channels,
    format: analysis.format,
    noiseScore: analysis.noiseScore,
    clippingDetected: analysis.clippingDetected,
    silenceRatio: Number(analysis.silenceRatio.toFixed(3)),
    trimApplied: analysis.trim.applied,
    trimStartSeconds: analysis.trim.start,
    trimEndSeconds: analysis.trim.end,
    trimDurationSeconds: analysis.trim.duration === null ? null : Number(analysis.trim.duration.toFixed(3)),
    language: profile.language,
    transcript: normalizeVoiceTranscript(metadata.transcript),
    transcriptLanguage: normalizeTranscriptLanguage(metadata.transcriptLanguage, profile.language),
    preparation: {
      revision: 1,
      status: "queued",
      vocalPath: "",
      accompanimentPath: "",
      runtime: null,
      warnings: [],
      failureMessage: "",
      failureDismissedAt: "",
      completedAt: ""
    },
    segments: [],
    qualityScore: analysis.qualityScore,
    warnings: analysis.warnings,
    createdAt: new Date().toISOString()
  };
}

async function reanalyzeVoiceSample(profile, sample) {
  const extension = `.${String(sample.format || path.extname(sample.originalFileName || "")).replace(/^\./, "").toLowerCase()}`;
  const buffer = await fs.readFile(sample.storedPath);
  const trimOptions = {
    applied: Boolean(sample.trimApplied),
    start: sample.trimStartSeconds ?? null,
    end: sample.trimEndSeconds ?? null
  };
  const analysis = await analyzeVoiceAudioBuffer(buffer, extension, profile.language, trimOptions, sample.storedPath);
  Object.assign(sample, {
    durationSeconds: Number(analysis.durationSeconds.toFixed(3)),
    speechSeconds: Number(analysis.speechSeconds.toFixed(3)),
    sampleRate: analysis.sampleRate,
    channels: analysis.channels,
    format: analysis.format,
    noiseScore: analysis.noiseScore,
    clippingDetected: analysis.clippingDetected,
    silenceRatio: Number(analysis.silenceRatio.toFixed(3)),
    trimApplied: analysis.trim.applied,
    trimStartSeconds: analysis.trim.start,
    trimEndSeconds: analysis.trim.end,
    trimDurationSeconds: analysis.trim.duration === null ? null : Number(analysis.trim.duration.toFixed(3)),
    language: profile.language,
    transcript: normalizeVoiceTranscript(sample.transcript),
    transcriptLanguage: normalizeTranscriptLanguage(sample.transcriptLanguage, profile.language),
    segments: Array.isArray(sample.segments) ? sample.segments.map((segment) => ({
      ...segment,
      transcript: normalizeVoiceTranscript(segment.transcript),
      transcriptLanguage: normalizeTranscriptLanguage(segment.transcriptLanguage, profile.language)
    })) : [],
    qualityScore: analysis.qualityScore,
    warnings: analysis.warnings,
    updatedAt: new Date().toISOString()
  });
  return sample;
}

function aggregateVoiceSampleQuality(samples) {
  if (!samples.length) {
    return {
      totalSpeechSeconds: 0,
      qualityScore: 0,
      warnings: ["No samples uploaded."]
    };
  }

  const sourceSpeechSeconds = samples.reduce((total, sample) => total + (Number(sample.speechSeconds) || 0), 0);
  const eligibleSegments = samples.flatMap((sample) => voiceSamplePreparationReady(sample)
    ? (Array.isArray(sample.segments) ? sample.segments.filter((segment) => voicePreparedSegmentWithinSampleTrim(sample, segment) && voiceTrainingClipEligible(segment)) : [])
    : []);
  const totalSpeechSeconds = eligibleSegments.reduce((total, segment) => total + (Number(segment.durationSeconds) || 0), 0);
  const averageScore = samples.reduce((total, sample) => total + (Number(sample.qualityScore) || 0), 0) / samples.length;
  const warnings = Array.from(new Set(samples.flatMap((sample) => Array.isArray(sample.warnings) ? sample.warnings : [])));
  const pendingPreparationCount = samples.filter((sample) => !voiceSamplePreparationReady(sample)).length;
  if (pendingPreparationCount) {
    warnings.push(`${pendingPreparationCount} source${pendingPreparationCount === 1 ? " is" : "s are"} not ready for training. Reprocess or repair Voice Preparation; raw uploads are excluded.`);
  }
  if (!eligibleSegments.length && !pendingPreparationCount) {
    warnings.push("No prepared clip passed the training-quality gate. Review the visible rejection reasons before Fine Training.");
  }
  if (totalSpeechSeconds < 10) {
    warnings.push("Prepared training speech is short; add more clean spoken audio for a better clone.");
  }
  return {
    totalSpeechSeconds: Number(totalSpeechSeconds.toFixed(3)),
    sourceSpeechSeconds: Number(sourceSpeechSeconds.toFixed(3)),
    eligibleClipCount: eligibleSegments.length,
    qualityScore: Math.max(0, Math.min(100, Math.round(averageScore))),
    warnings
  };
}

function speechTextFromSegments(segments) {
  return segments
    .map((segment) => String(segment.text || "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function bestVoiceReferenceSample(samples) {
  return [...samples].sort((left, right) => {
    const leftInRange = Number(left.durationSeconds) >= 10 && Number(left.durationSeconds) <= 30 ? 1 : 0;
    const rightInRange = Number(right.durationSeconds) >= 10 && Number(right.durationSeconds) <= 30 ? 1 : 0;
    if (leftInRange !== rightInRange) {
      return rightInRange - leftInRange;
    }
    return (Number(right.qualityScore) || 0) - (Number(left.qualityScore) || 0);
  })[0] || null;
}

function voiceFfmpegTrimArgs(trim = {}) {
  const args = [];
  const start = Number(trim.start ?? 0) || 0;
  const end = trim.end === null || trim.end === undefined ? null : Number(trim.end);
  if (start > 0) {
    args.push("-ss", String(start));
  }
  if (end !== null && Number.isFinite(end) && end > start) {
    args.push("-t", String(end - start));
  }
  return args;
}

async function normalizeVoiceAudioFile({ inputPath, outputPath, trim = {}, sampleRate = 24000 }) {
  const ffmpegTool = await resolveMediaTool("ffmpeg");
  if (!ffmpegTool) {
    throw new Error("Bundled FFmpeg is required for neural voice preprocessing.");
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(ffmpegTool.command, [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    ...voiceFfmpegTrimArgs(trim),
    "-i", inputPath,
    "-vn",
    "-ac", "1",
    "-ar", String(sampleRate),
    "-af", "loudnorm=I=-20:TP=-1.5:LRA=11",
    "-c:a", "pcm_s16le",
    outputPath
  ], {
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024
  });
}

async function buildOpenVoiceReferenceBundle(profile, samples, modelBuildId = "", signal = null) {
  throwIfVoiceAbortSignalAborted(signal);
  const usableSamples = samples.filter((sample) => voiceSamplePreparationReady(sample));
  if (!usableSamples.length) {
    throw new Error("Prepare at least one source before building a neural voice profile. Raw uploads are intentionally excluded from training.");
  }
  const referenceSample = bestVoiceReferenceSample(usableSamples) || usableSamples[0];
  const buildId = sanitizeUnicodeText(modelBuildId || makeVoiceId("voice-model"));
  const referenceDir = path.join(voiceProfileFolder(profile.id), "openvoice-v2", "references", buildId);
  const referenceAudioPath = path.join(referenceDir, "reference.wav");
  await normalizeVoiceAudioFile({
    inputPath: normalizedVoicePreparation(referenceSample).vocalPath,
    outputPath: referenceAudioPath,
    trim: preparedVoiceAudioBuildTrim(referenceSample),
    sampleRate: 24000
  });
  throwIfVoiceAbortSignalAborted(signal);

  const auxiliaryReferenceAudioPaths = [];
  for (const [index, sample] of usableSamples.filter((item) => item.id !== referenceSample.id).slice(0, 2).entries()) {
    const auxiliaryPath = path.join(referenceDir, `aux-${index + 1}.wav`);
    await normalizeVoiceAudioFile({
      inputPath: normalizedVoicePreparation(sample).vocalPath,
      outputPath: auxiliaryPath,
      trim: preparedVoiceAudioBuildTrim(sample),
      sampleRate: 24000
    });
    throwIfVoiceAbortSignalAborted(signal);
    auxiliaryReferenceAudioPaths.push(auxiliaryPath);
  }
  return {
    referenceAudioPath,
    auxiliaryReferenceAudioPaths,
    referenceSample
  };
}

async function buildOpenVoiceProfileModel(profile, samples, qualityMode, { modelBuildId = "", signal = null } = {}) {
  if (qualityMode !== "quick") {
    throw new Error("Fine Clone is not implemented yet. Use Quick Clone with the OpenVoice V2 local neural engine.");
  }
  await assertVoiceNeuralEngineReady(voiceNeuralEngineId);
  throwIfVoiceAbortSignalAborted(signal);
  const aggregate = aggregateVoiceSampleQuality(samples);
  const buildId = sanitizeUnicodeText(modelBuildId || makeVoiceId("voice-model"));
  const bundle = await buildOpenVoiceReferenceBundle(profile, samples, buildId, signal);
  const modelDir = path.join(voiceProfileFolder(profile.id), "openvoice-v2", "models", buildId);
  const modelPath = path.join(modelDir, "openvoice-v2-profile.json");
  const speakerEmbeddingPath = path.join(modelDir, "speaker-embedding.json");
  const result = await callVoiceEngineWorker({
    action: "build-profile",
    profileId: profile.id,
    profileName: profile.name,
    language: profile.language,
    qualityMode,
    referenceAudioPath: bundle.referenceAudioPath,
    auxiliaryReferenceAudioPaths: bundle.auxiliaryReferenceAudioPaths,
    modelPath,
    speakerEmbeddingPath,
    settings: {
      targetSampleRate: 24000
    }
  }, { engine: voiceNeuralEngineId, signal });
  throwIfVoiceAbortSignalAborted(signal);
  const voiceModel = {
    engine: voiceNeuralEngineId,
    modelVersion: voiceNeuralModelVersion,
    versionId: buildId,
    profileId: profile.id,
    profileName: profile.name,
    language: profile.language,
    qualityMode,
    modelPath,
    speakerEmbeddingPath,
    referenceAudioPath: bundle.referenceAudioPath,
    auxiliaryReferenceAudioPaths: bundle.auxiliaryReferenceAudioPaths,
    primarySampleId: bundle.referenceSample.id,
    builtAt: new Date().toISOString(),
    ...(result.profileModel || {})
  };
  await fs.mkdir(modelDir, { recursive: true });
  await fs.writeFile(modelPath, JSON.stringify(voiceModel, null, 2), "utf8");
  throwIfVoiceAbortSignalAborted(signal);
  try {
    await fs.writeFile(speakerEmbeddingPath, JSON.stringify({
      engine: voiceNeuralEngineId,
      modelVersion: voiceNeuralModelVersion,
      profileId: profile.id,
      referenceAudioPath: bundle.referenceAudioPath,
      createdAt: voiceModel.builtAt
    }, null, 2), { flag: "wx" });
  } catch {
  }
  return {
    voiceModel,
    aggregate,
    warnings: [
      ...aggregate.warnings,
      ...(Array.isArray(result.warnings) ? result.warnings : [])
    ]
  };
}

function gptSoVitsPromptCandidates(profile, samples) {
  const candidates = [];
  for (const sample of samples) {
    if (!voiceSamplePreparationReady(sample)) {
      continue;
    }
    for (const segment of Array.isArray(sample.segments) ? sample.segments : []) {
      if (!voicePreparedSegmentWithinSampleTrim(sample, segment) || !voiceTrainingClipEligible(segment) || !gptSoVitsSegmentPromptReady(segment, profile.language)) {
        continue;
      }
      candidates.push({
        type: "segment",
        sample,
        segment,
        inputPath: segment.audioPath,
        durationSeconds: Number(segment.durationSeconds) || 0,
        transcript: normalizeVoiceTranscript(segment.transcript),
        transcriptLanguage: normalizeTranscriptLanguage(segment.transcriptLanguage, profile.language),
        qualityScore: Number(sample.qualityScore) || 0,
        preferredPrompt: Boolean(segment.preferredPrompt),
        trim: {
          start: null,
          end: null
        }
      });
    }
  }
  const candidateScore = (candidate) => {
    const duration = Number(candidate.durationSeconds) || 0;
    const transcript = normalizeVoiceTranscript(candidate.transcript);
    const compactLength = transcript.replace(/\s+/g, "").length;
    let score = Math.min(25, Math.max(0, Number(candidate.qualityScore) || 0) * 0.25);
    score += candidate.type === "segment" ? 20 : 0;
    score += Math.max(0, 36 - Math.abs(duration - 6.5) * 7);
    score += Math.max(0, 20 - Math.abs(compactLength - 22));
    if (/[.!?。！？]$/u.test(transcript)) {
      score += 18;
    } else if (/[,，、;；:：]$/u.test(transcript)) {
      score -= 16;
    }
    if (candidate.preferredPrompt) {
      score += 10000;
    }
    return score;
  };
  return candidates.sort((left, right) => {
    return candidateScore(right) - candidateScore(left);
  });
}

function gptSoVitsPromptTrim(sample) {
  const duration = Number(sample.durationSeconds);
  const trimStart = Number.isFinite(Number(sample.trimStartSeconds)) && Number(sample.trimStartSeconds) >= 0
    ? Number(sample.trimStartSeconds)
    : 0;
  const explicitEnd = Number.isFinite(Number(sample.trimEndSeconds)) && Number(sample.trimEndSeconds) > trimStart
    ? Number(sample.trimEndSeconds)
    : null;
  let trimEnd = explicitEnd;
  let autoTrimmed = false;
  if (Number.isFinite(duration) && duration < 3) {
    throw new Error("GPT-SoVITS prompt audio must be at least 3 seconds. Add a longer reference sample.");
  }
  if (!trimEnd && Number.isFinite(duration) && duration - trimStart > 10) {
    trimEnd = trimStart + 8;
    autoTrimmed = true;
  }
  if (trimEnd && trimEnd - trimStart > 10) {
    trimEnd = trimStart + 8;
    autoTrimmed = true;
  }
  return {
    trim: {
      start: trimStart,
      end: trimEnd
    },
    autoTrimmed
  };
}

function gptSoVitsDatasetEntries(profile, samples) {
  const entries = [];
  for (const sample of samples) {
    if (!voiceSamplePreparationReady(sample)) {
      continue;
    }
    const segments = Array.isArray(sample.segments) ? sample.segments : [];
    for (const segment of segments) {
      if (!voicePreparedSegmentWithinSampleTrim(sample, segment) || !gptSoVitsSegmentTranscriptReady(segment, profile.language) || !voiceTrainingClipEligible(segment)) {
        continue;
      }
      entries.push({
        id: segment.id,
        sample,
        segment,
        inputPath: segment.audioPath,
        trim: { start: null, end: null },
        transcript: normalizeVoiceTranscript(segment.transcript),
        transcriptLanguage: normalizeTranscriptLanguage(segment.transcriptLanguage, profile.language)
      });
    }
  }
  return entries;
}

function fineCheckpointEpoch(record) {
  const match = String(record?.source || "").match(/(?:^|-)e(?:poch)?(?:=|-)?(\d+)(?:-|$)/i);
  return Number(match?.[1]) || 0;
}

function publicFineCheckpointValidation(record, integrity = null) {
  const reasons = Array.isArray(integrity?.reasons)
    ? integrity.reasons.map((reason) => sanitizeUnicodeText(reason)).filter(Boolean)
    : [];
  return {
    source: sanitizeUnicodeText(record?.source || "candidate"),
    path: sanitizeUnicodeText(record?.path || ""),
    durationSeconds: Math.max(0, Number(record?.durationSeconds) || 0),
    targetDurationSeconds: Math.max(0, Number(record?.targetDurationSeconds) || 0),
    durationScore: Number.isFinite(Number(record?.score)) ? Number(record.score) : null,
    durationAccepted: Boolean(record?.healthy),
    coverage: integrity ? Math.max(0, Number(integrity.coverage) || 0) : 0,
    waveformHealth: integrity?.waveformHealth || {},
    accepted: Boolean(record?.healthy && integrity?.accepted),
    reason: sanitizeUnicodeText(integrity?.reason || record?.error || (record?.healthy ? "" : "checkpoint_duration_invalid")),
    reasons
  };
}

function fineCheckpointModulationScore(report) {
  const rawScore = report?.waveformHealth?.modulationScore;
  if (typeof rawScore !== "number") {
    return null;
  }
  const score = Number(rawScore);
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
}

function selectFineCheckpointCandidate(reports = []) {
  const strictCandidates = reports.filter((item) => item.accepted);
  if (strictCandidates.length) {
    const selected = strictCandidates.sort((left, right) => {
      const scoreDelta = (left.durationScore ?? Number.POSITIVE_INFINITY) - (right.durationScore ?? Number.POSITIVE_INFINITY);
      return scoreDelta || fineCheckpointEpoch(right) - fineCheckpointEpoch(left);
    })[0];
    return { selected, advisoryWaveformFallback: false };
  }
  // The 4-12 Hz envelope score overlaps normal syllable rhythm and is not
  // reliable enough to invalidate an otherwise complete trained model by
  // itself. Missing or malformed metrics fail closed; they cannot establish
  // which checkpoint is actually the least modulated.
  const advisoryCandidates = reports.filter((item) => (
    item.durationAccepted
    && item.coverage >= 0.92
    && item.reasons.length > 0
    && item.reasons.every((reason) => reason === "unstable_amplitude_detected")
    && fineCheckpointModulationScore(item) !== null
  ));
  if (!advisoryCandidates.length) {
    return { selected: null, advisoryWaveformFallback: false };
  }
  const selected = advisoryCandidates.sort((left, right) => {
    const modulationDelta = fineCheckpointModulationScore(left) - fineCheckpointModulationScore(right);
    const scoreDelta = (left.durationScore ?? Number.POSITIVE_INFINITY) - (right.durationScore ?? Number.POSITIVE_INFINITY);
    return modulationDelta || scoreDelta || fineCheckpointEpoch(right) - fineCheckpointEpoch(left);
  })[0];
  return { selected, advisoryWaveformFallback: true };
}

async function validateFineGptCheckpointPairs({ profile, modelDir, workerProfileModel, referenceAudioPath = "", signal = null }) {
  const trainingStats = workerProfileModel?.trainingStats && typeof workerProfileModel.trainingStats === "object"
    ? workerProfileModel.trainingStats
    : {};
  const rawCandidates = Array.isArray(trainingStats.gptCheckpointValidation)
    ? trainingStats.gptCheckpointValidation
    : Array.isArray(workerProfileModel?.gptCheckpointValidation)
      ? workerProfileModel.gptCheckpointValidation
      : [];
  const durationOnlySelectionPath = sanitizeUnicodeText(workerProfileModel?.gptWeightsPath || "");
  if (!rawCandidates.length) {
    throw new Error("Fine Clone did not return any checkpoint calibration candidates. The existing active profile was preserved.");
  }
  throwIfVoiceAbortSignalAborted(signal);
  await assertVoicePreparationReady();
  throwIfVoiceAbortSignalAborted(signal);
  const preparationCandidates = [];
  const reportsByIndex = new Map();
  const trainingRoot = path.join(voiceProfileFolder(profile.id), "gpt-sovits", "training");
  const probeRoot = path.join(modelDir, "checkpoint-validation");
  try {
    for (const [index, record] of rawCandidates.entries()) {
      const checkpointPath = sanitizeUnicodeText(record?.path || "");
      const probeAudioPath = sanitizeUnicodeText(record?.probeAudioPath || "");
      const candidateIsNew = String(record?.source || "").startsWith("new-");
      const checkpointInsideProfile = pathIsInside(trainingRoot, checkpointPath)
        || (workerProfileModel?.fakeWorker === true && pathIsInside(modelDir, checkpointPath));
      const probeInsideModel = pathIsInside(probeRoot, probeAudioPath);
      const usable = Boolean(
        record?.healthy === true
        && candidateIsNew
        && checkpointInsideProfile
        && probeInsideModel
        && await pathExists(checkpointPath)
        && await pathExists(probeAudioPath)
      );
      if (!usable) {
        reportsByIndex.set(index, publicFineCheckpointValidation(record));
        continue;
      }
      preparationCandidates.push({
        id: `checkpoint-${index}`,
        index,
        audioPath: probeAudioPath,
        expectedText: normalizeVoiceTranscript(record.calibrationText),
        record
      });
    }
    if (!preparationCandidates.length) {
      throw new Error("Fine Clone produced no new checkpoint with a valid calibration render. The existing active profile was preserved.");
    }
    const validated = await validateVoiceSynthesisCandidates({
      candidates: preparationCandidates,
      language: normalizeVoiceLanguage(profile.language, { allowAuto: false }),
      referenceAudioPath,
      baselineAudioPaths: voiceModelValidationBaselineAudioPaths(profile, workerProfileModel),
      settings: workerProfileModel?.fakeWorker === true
        ? { integrityFixture: sanitizeUnicodeText(workerProfileModel.checkpointIntegrityFixture || "") }
        : {},
      signal
    });
    for (const candidate of validated) {
      reportsByIndex.set(candidate.index, publicFineCheckpointValidation(candidate.record, candidate.validation));
    }
    const reports = rawCandidates.map((record, index) => reportsByIndex.get(index) || publicFineCheckpointValidation(record));
    const { selected, advisoryWaveformFallback } = selectFineCheckpointCandidate(reports);
    if (!selected) {
      const reasons = reports.map((item) => `${item.source}: ${item.reasons.length ? item.reasons.join(", ") : item.reason || "quality gate failed"}`).join("; ");
      throw new Error(`Fine Clone checkpoints did not pass local transcript coverage and waveform validation. The existing active profile was preserved. ${reasons}`);
    }
    workerProfileModel.gptWeightsPath = selected.path;
    const selection = {
      ...selected,
      activated: true,
      strictValidationAccepted: Boolean(selected.accepted),
      selectedBy: advisoryWaveformFallback ? "semantic-complete-least-modulated-fallback" : "duration-semantic-waveform-gate",
      advisoryWaveformWarning: advisoryWaveformFallback
    };
    workerProfileModel.trainingStats = {
      ...trainingStats,
      gptCheckpointSelection: selection,
      gptCheckpointValidation: reports
    };
    const warnings = [];
    if (advisoryWaveformFallback) {
      warnings.push("Fine Clone completed with the least-modulated text-complete checkpoint. The amplitude score was kept as an advisory warning because normal syllable rhythm can trigger it.");
    }
    if (durationOnlySelectionPath && durationOnlySelectionPath !== selected.path) {
      warnings.push("Fine Clone selected a different trained GPT checkpoint after local transcript and waveform validation.");
    }
    return {
      selected,
      reports,
      warning: warnings.join(" ")
    };
  } finally {
    await fs.rm(probeRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildGptSoVitsReferenceBundle(profile, samples, qualityMode, modelBuildId = "", signal = null) {
  throwIfVoiceAbortSignalAborted(signal);
  const promptCandidate = gptSoVitsPromptCandidates(profile, samples)[0] || null;
  if (!promptCandidate) {
    throw new Error("GPT-SoVITS needs at least one 3-10 second sentence clip with a matching transcript before building. Add or edit transcripts on the sample's sentence clips.");
  }
  const promptTrim = promptCandidate.type === "sample"
    ? gptSoVitsPromptTrim(promptCandidate.sample)
    : { trim: promptCandidate.trim, autoTrimmed: false };
  const buildId = sanitizeUnicodeText(modelBuildId || makeVoiceId("voice-model"));
  const referenceDir = path.join(voiceProfileFolder(profile.id), "gpt-sovits", "references", buildId);
  const referenceAudioPath = path.join(referenceDir, "prompt.wav");
  await normalizeVoiceAudioFile({
    inputPath: promptCandidate.inputPath,
    outputPath: referenceAudioPath,
    trim: promptTrim.trim,
    sampleRate: 32000
  });
  throwIfVoiceAbortSignalAborted(signal);
  promptCandidate.sample.normalizedReferenceAudioPath = referenceAudioPath;

  const datasetSamples = [];
  let datasetDir = "";
  let datasetListPath = "";
  if (qualityMode === "fine") {
    datasetDir = path.join(voiceProfileFolder(profile.id), "gpt-sovits", "dataset", buildId);
    const wavDir = path.join(datasetDir, "wavs");
    await fs.mkdir(wavDir, { recursive: true });
    const datasetEntries = gptSoVitsDatasetEntries(profile, samples);
    if (datasetEntries.length < 1) {
      throw new Error("Fine Clone needs at least one explicitly included eligible prepared sentence clip. Raw, pending, rejected, and uncertain clips are intentionally excluded.");
    }
    for (const entry of datasetEntries) {
      const wavPath = path.join(wavDir, `${entry.id}.wav`);
      await normalizeVoiceAudioFile({
        inputPath: entry.inputPath,
        outputPath: wavPath,
        trim: entry.trim,
        sampleRate: 32000
      });
      throwIfVoiceAbortSignalAborted(signal);
      datasetSamples.push({
        sampleId: entry.sample.id,
        ...(entry.segment ? { segmentId: entry.segment.id } : {}),
        audioPath: wavPath,
        transcript: entry.transcript,
        language: entry.transcriptLanguage
      });
    }
    datasetListPath = path.join(datasetDir, "train.list");
    const listSpeaker = String(profile.id || "magicbox").replace(/\|/g, " ");
    const lines = datasetSamples.map((sample) => {
      const audioPath = sanitizeUnicodeText(sample.audioPath).replace(/\|/g, " ");
      const transcript = normalizeVoiceTranscript(sample.transcript).replace(/\|/g, " ");
      const language = normalizeTranscriptLanguage(sample.language, profile.language);
      return `${audioPath}|${listSpeaker}|${language}|${transcript}`;
    });
    await fs.writeFile(datasetListPath, `${lines.join("\n")}\n`, "utf8");
  }

  return {
    promptSample: promptCandidate.sample,
    promptSegment: promptCandidate.segment || null,
    referenceAudioPath,
    promptText: promptCandidate.transcript,
    promptLanguage: promptCandidate.transcriptLanguage,
    datasetDir,
    datasetListPath,
    datasetSamples,
    warnings: promptTrim.autoTrimmed
      ? ["GPT-SoVITS prompt audio was trimmed to 8 seconds to satisfy the upstream 3-10 second prompt requirement. For best voice matching, keep the prompt transcript aligned to the trimmed speech."]
      : []
  };
}

async function buildGptSoVitsProfileModel(profile, samples, qualityMode, { modelBuildId = "", onProgress = null, signal = null } = {}) {
  await assertVoiceNeuralEngineReady(gptSoVitsEngineId);
  throwIfVoiceAbortSignalAborted(signal);
  const buildId = sanitizeUnicodeText(modelBuildId || makeVoiceId("voice-model"));
  const aggregate = aggregateVoiceSampleQuality(samples);
  const bundle = await buildGptSoVitsReferenceBundle(profile, samples, qualityMode, buildId, signal);
  const modelDir = path.join(voiceProfileFolder(profile.id), "gpt-sovits", "model", buildId);
  const modelPath = path.join(modelDir, "gpt-sovits-profile.json");
  const trainingDir = path.join(voiceProfileFolder(profile.id), "gpt-sovits", "training", buildId);
  await fs.mkdir(modelDir, { recursive: true });
  const result = await callVoiceEngineWorker({
    action: "build-profile",
    profileId: profile.id,
    profileName: profile.name,
    language: profile.language,
    qualityMode,
    referenceAudioPath: bundle.referenceAudioPath,
    promptText: bundle.promptText,
    promptLanguage: bundle.promptLanguage,
    modelPath,
    trainingDir,
    datasetDir: bundle.datasetDir,
    datasetListPath: bundle.datasetListPath,
    datasetSamples: bundle.datasetSamples,
    settings: {
      targetSampleRate: 32000
    }
  }, { engine: gptSoVitsEngineId, timeoutMs: qualityMode === "fine" ? voiceEngineFineTuneTimeoutMs : voiceEngineRequestTimeoutMs, onProgress, signal });
  throwIfVoiceAbortSignalAborted(signal);
  const workerProfileModel = sanitizeStructuredText(result.profileModel || {});
  const checkpointGate = qualityMode === "fine"
    ? await validateFineGptCheckpointPairs({ profile, modelDir, workerProfileModel, referenceAudioPath: bundle.referenceAudioPath, signal })
    : null;
  throwIfVoiceAbortSignalAborted(signal);
  const voiceModel = {
    ...workerProfileModel,
    engine: gptSoVitsEngineId,
    modelVersion: gptSoVitsModelVersion,
    versionId: buildId,
    profileId: profile.id,
    profileName: profile.name,
    language: profile.language,
    qualityMode,
    modelPath,
    referenceAudioPath: bundle.referenceAudioPath,
    promptText: bundle.promptText,
    promptLanguage: bundle.promptLanguage,
    primarySampleId: bundle.promptSample.id,
    ...(bundle.promptSegment ? { primarySegmentId: bundle.promptSegment.id } : {}),
    ...(bundle.datasetDir ? { datasetDir: bundle.datasetDir } : {}),
    ...(bundle.datasetListPath ? { datasetListPath: bundle.datasetListPath } : {}),
    datasetSamples: Array.isArray(workerProfileModel.datasetSamples)
      ? workerProfileModel.datasetSamples
      : bundle.datasetSamples,
    builtAt: new Date().toISOString()
  };
  const referenceStat = await fs.stat(bundle.referenceAudioPath);
  const makeReferenceArtifacts = async (entries, fallbackKind) => Promise.all((Array.isArray(entries) ? entries : []).map(async (entry, index) => {
    const audioPath = entry.audioPath || entry.path || entry;
    const stats = await fs.stat(audioPath);
    let durationMs = 0;
    try { durationMs = Math.round(parseWavInfo(await fs.readFile(audioPath)).durationSeconds * 1000); } catch {}
    return {
      artifactId: `${buildId}:${fallbackKind}:${entry.segmentId || index + 1}`,
      relativePath: path.relative(voiceDataRootDir(), audioPath).replaceAll("\\", "/"),
      sha256: await sha256File(audioPath),
      byteSize: stats.size,
      durationMs,
      nativeSampleRate: 32000,
      channels: 1
    };
  }));
  const promptPack = createReferencePackManifest({
    profileId: profile.id,
    modelVersionId: buildId,
    datasetSnapshotHash: voiceDatasetSnapshotHash(profile, samples, gptSoVitsEngineId),
    purpose: "gpt_prompt",
    language: bundle.promptLanguage,
    artifacts: [{
      artifactId: `${buildId}:prompt`,
      relativePath: path.relative(voiceDataRootDir(), bundle.referenceAudioPath).replaceAll("\\", "/"),
      sha256: await sha256File(bundle.referenceAudioPath),
      byteSize: referenceStat.size
    }]
  });
  const seedPack = createReferencePackManifest({
    profileId: profile.id,
    modelVersionId: buildId,
    datasetSnapshotHash: voiceDatasetSnapshotHash(profile, samples, gptSoVitsEngineId),
    purpose: "seed_inference",
    language: profile.language,
    artifacts: await makeReferenceArtifacts(bundle.datasetSamples?.slice(0, 8), "seed")
  });
  const identityPack = createReferencePackManifest({
    profileId: profile.id,
    modelVersionId: buildId,
    datasetSnapshotHash: voiceDatasetSnapshotHash(profile, samples, gptSoVitsEngineId),
    purpose: "identity_evaluation",
    language: profile.language,
    artifacts: await makeReferenceArtifacts(bundle.datasetSamples?.slice(0, 24), "identity")
  });
  const identityCalibrationPaths = (Array.isArray(bundle.datasetSamples) ? bundle.datasetSamples : [])
    .slice(0, 16)
    .map((sample) => sample?.audioPath)
    .filter(Boolean);
  let identityCalibration = {
    status: "unavailable",
    referencePackId: identityPack.referencePackId,
    evaluatorVersions: {}
  };
  let identityCalibrationWarning = "";
  try {
    const calibration = await calibrateVoiceProfileIdentity(identityCalibrationPaths, signal);
    identityCalibration = {
      status: "ready",
      referencePackId: identityPack.referencePackId,
      encoderA: identityReferenceCalibration(calibration.encoderA?.scores, {
        centroidFloor: 0.65,
        margin: 0.05
      }),
      encoderB: calibration.encoderB
        ? identityReferenceCalibration(calibration.encoderB.scores, {
          centroidFloor: 0.55,
          margin: 0.05
        })
        : null,
      evaluatorVersions: calibration.evaluatorVersions || {},
      targetReferenceCount: Number(calibration.targetReferenceCount) || identityCalibrationPaths.length,
      device: sanitizeUnicodeText(calibration.device || "")
    };
    if (!calibration.encoderB) {
      identityCalibrationWarning = "Profile identity calibration completed with CAMPPlus only because ERes2NetV2 was unavailable.";
    }
  } catch (error) {
    identityCalibrationWarning = `Profile identity calibration was unavailable: ${sanitizeUnicodeText(error.message || error)}`;
  }
  voiceModel.referencePack = promptPack;
  voiceModel.referencePacks = {
    gptPrompt: promptPack,
    seedInference: seedPack,
    identityEvaluation: identityPack
  };
  voiceModel.identityCalibration = identityCalibration;
  await fs.writeFile(modelPath, JSON.stringify(voiceModel, null, 2), "utf8");
  throwIfVoiceAbortSignalAborted(signal);
  return {
    voiceModel,
    aggregate,
    warnings: [
      ...aggregate.warnings,
      ...bundle.warnings,
      ...(identityCalibrationWarning ? [identityCalibrationWarning] : []),
      ...(checkpointGate?.warning ? [checkpointGate.warning] : []),
      ...(Array.isArray(result.warnings) ? result.warnings : [])
    ]
  };
}

async function buildVoiceProfileModel(profile, samples, { qualityMode, engine, modelBuildId = "", onProgress = null, signal = null }) {
  const selectedEngine = normalizeVoiceEngine(engine || profile.engine, { language: profile.language });
  if (selectedEngine === gptSoVitsEngineId) {
    return buildGptSoVitsProfileModel(profile, samples, qualityMode, { modelBuildId, onProgress, signal });
  }
  return buildOpenVoiceProfileModel(profile, samples, qualityMode, { modelBuildId, signal });
}

async function validateVoiceSynthesisCandidate({ audioPath, expectedText, language, referenceAudioPath = "", baselineAudioPaths = [], settings = {}, signal = null }) {
  throwIfVoiceAbortSignalAborted(signal);
  const evaluatorSettings = {
    ...settings,
    secondaryAsrEnabled: settings.secondaryAsrEnabled ?? voiceCloneFeatureFlags(process.env).secondaryAsr === true
  };
  const callWorker = settings.conversationMode || voiceCloneFeatureFlags(process.env).persistentWorkers
    ? callLiveVoiceEngineWorker
    : callVoiceEngineWorker;
  return callWorker({
    action: "validate-synthesis",
    audioPath,
    expectedText,
    language,
    referenceAudioPath,
    baselineAudioPaths,
    settings: evaluatorSettings,
    integrityFixture: settings.integrityFixture || ""
  }, { engine: voicePreparationEngineId, timeoutMs: voiceEngineRequestTimeoutMs, signal });
}

async function validateVoiceSynthesisWaveformCandidate({ audioPath, expectedText, language, referenceAudioPath = "", baselineAudioPaths = [], settings = {}, signal = null }) {
  throwIfVoiceAbortSignalAborted(signal);
  const result = await callVoiceEngineWorker({
    action: "validate-synthesis-waveform-batch",
    candidates: [{
      id: "final-joined-speech",
      audioPath,
      expectedText,
      language,
      referenceAudioPath,
      baselineAudioPaths,
      settings,
      integrityFixture: settings.integrityFixture || ""
    }]
  }, { engine: voicePreparationEngineId, timeoutMs: voiceEngineRequestTimeoutMs, signal });
  const validation = Array.isArray(result?.results) ? result.results[0] : null;
  if (!validation || typeof validation !== "object") {
    throw new Error("Voice waveform validation did not return a result for the joined speech.");
  }
  return validation;
}

function combineVoiceClauseIntegrity(acceptedClauses, waveformValidation) {
  const clauseValidations = acceptedClauses.map((item) => item?.validation).filter(Boolean);
  const secondaryAsr = aggregateClauseSecondaryAsr(clauseValidations);
  const coverageValues = [waveformValidation?.coverage, ...clauseValidations.map((item) => item?.coverage)]
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const reasons = Array.from(new Set([
    ...clauseValidations.flatMap((validation) => voiceSynthesisValidationReasons(validation)),
    ...voiceSynthesisValidationReasons(waveformValidation)
  ]));
  const expectedTokenCount = clauseValidations.reduce((total, validation) => total + (Number.isInteger(validation.expectedTokenCount) ? validation.expectedTokenCount : 0), 0);
  const observedTokenCount = clauseValidations.reduce((total, validation) => total + (Number.isInteger(validation.observedTokenCount) ? validation.observedTokenCount : 0), 0);
  return {
    ...waveformValidation,
    ...(secondaryAsr ? { secondaryAsr } : {}),
    accepted: waveformValidation?.accepted === true
      && clauseValidations.every((validation) => validation.accepted === true)
      && reasons.length === 0,
    coverage: coverageValues.length ? Math.min(...coverageValues) : 0,
    expectedTokenCount,
    observedTokenCount,
    reason: reasons[0] || "",
    reasons,
    clauseCoverageValidated: true
  };
}

function voiceModelValidationBaselineAudioPaths(profile, voiceModel = profile?.voiceModel) {
  const profileRoot = voiceProfileFolder(profile?.id);
  return Array.from(new Set(
    (Array.isArray(voiceModel?.datasetSamples) ? voiceModel.datasetSamples : [])
      .map((sample) => sanitizeUnicodeText(sample?.audioPath || ""))
      .filter((audioPath) => audioPath && pathIsInside(profileRoot, audioPath))
  )).slice(0, 64);
}

async function validateVoiceSynthesisCandidates({ candidates, language, referenceAudioPath = "", baselineAudioPaths = [], settings = {}, signal = null }) {
  throwIfVoiceAbortSignalAborted(signal);
  const evaluatorSettings = {
    ...settings,
    secondaryAsrEnabled: settings.secondaryAsrEnabled ?? voiceCloneFeatureFlags(process.env).secondaryAsr === true
  };
  const callWorker = settings.conversationMode || voiceCloneFeatureFlags(process.env).persistentWorkers
    ? callLiveVoiceEngineWorker
    : callVoiceEngineWorker;
  const result = await callWorker({
    action: settings.conversationMode ? "validate-synthesis-waveform-batch" : "validate-synthesis-batch",
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      audioPath: candidate.audioPath,
      expectedText: candidate.expectedText,
      language,
      referenceAudioPath,
      baselineAudioPaths,
      settings: evaluatorSettings,
      integrityFixture: settings.integrityFixture || ""
    }))
  }, { engine: voicePreparationEngineId, timeoutMs: voiceEngineRequestTimeoutMs, signal });
  const resultsById = new Map((Array.isArray(result?.results) ? result.results : []).map((item) => [String(item?.id || ""), item]));
  return candidates.map((candidate) => {
    const validation = resultsById.get(String(candidate.id));
    if (!validation || typeof validation !== "object") {
      throw new Error(`Voice integrity validation did not return a result for ${candidate.id}.`);
    }
    return {
      ...candidate,
      validation
    };
  });
}

async function validateVoiceConversionCandidates({ sourceAudioPath, candidates, language, referenceAudioPath = "", baselineAudioPaths = [], settings = {}, signal = null }) {
  throwIfVoiceAbortSignalAborted(signal);
  const result = await callVoiceEngineWorker({
    action: "validate-conversion-batch",
    sourceAudioPath,
    language,
    referenceAudioPath,
    baselineAudioPaths,
    settings,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      audioPath: candidate.audioPath,
      referenceAudioPath,
      baselineAudioPaths,
      settings,
      integrityFixture: settings.integrityFixture || ""
    }))
  }, { engine: voicePreparationEngineId, timeoutMs: voiceEngineRequestTimeoutMs, signal });
  if (!Number.isInteger(result?.sourceTranscriptTokenCount) || result.sourceTranscriptTokenCount <= 0 || result.sourceTranscriptTokenCount > 20000) {
    throw new Error("Voice conversion validation returned an invalid private source transcript token count.");
  }
  const resultItems = Array.isArray(result?.results) ? result.results : [];
  if (resultItems.length !== candidates.length) {
    throw new Error("Voice conversion validation returned an incomplete candidate set.");
  }
  const resultsById = new Map();
  for (const item of resultItems) {
    const id = String(item?.id || "");
    if (!id || resultsById.has(id)) {
      throw new Error("Voice conversion validation returned duplicate or missing candidate identifiers.");
    }
    resultsById.set(id, item);
  }
  return {
    sourceTranscriptTokenCount: result.sourceTranscriptTokenCount,
    candidates: candidates.map((candidate) => {
      const validation = resultsById.get(String(candidate.id));
      if (!validation || typeof validation !== "object") {
        throw new Error(`Voice conversion validation did not return a result for ${candidate.id}.`);
      }
      const expectedTokenCount = validation.expectedTokenCount;
      const observedTokenCount = validation.observedTokenCount;
      if (!Number.isInteger(expectedTokenCount)
        || expectedTokenCount !== result.sourceTranscriptTokenCount
        || !Number.isInteger(observedTokenCount)
        || observedTokenCount <= 0
        || observedTokenCount > Math.max(expectedTokenCount + 1, Math.ceil(expectedTokenCount * 1.35))) {
        throw new Error(`Voice conversion validation returned invalid transcript counts for ${candidate.id}.`);
      }
      return { ...candidate, validation };
    })
  };
}

function voiceSynthesisValidationReasons(validation) {
  const reasons = Array.isArray(validation?.reasons)
    ? validation.reasons.map((reason) => sanitizeUnicodeText(reason)).filter(Boolean)
    : [];
  const singularReason = sanitizeUnicodeText(validation?.reason || "");
  if (singularReason && !reasons.includes(singularReason)) {
    reasons.push(singularReason);
  }
  return reasons;
}

function voiceSynthesisModulationScore(validation) {
  const score = validation?.waveformHealth?.modulationScore;
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1
    ? score
    : null;
}

function voiceSynthesisTokenCountsValid(validation) {
  const expectedTokenCount = validation?.expectedTokenCount;
  const observedTokenCount = validation?.observedTokenCount;
  return Number.isInteger(expectedTokenCount)
    && expectedTokenCount > 0
    && Number.isInteger(observedTokenCount)
    && observedTokenCount > 0
    && observedTokenCount <= Math.max(expectedTokenCount + 1, Math.ceil(expectedTokenCount * 1.35));
}

function isVoiceSynthesisStrictlyAccepted(validation) {
  const coverage = validation?.coverage;
  const activity = validation?.waveformHealth?.activity;
  const lineHumRatio = validation?.waveformHealth?.lineHumRatio;
  return validation?.accepted === true
    && voiceSynthesisValidationReasons(validation).length === 0
    && typeof coverage === "number"
    && Number.isFinite(coverage)
    && coverage >= 0.92
    && coverage <= 1
    && typeof activity === "number"
    && Number.isFinite(activity)
    && activity >= 0.2
    && activity <= 1
    && typeof lineHumRatio === "number"
    && Number.isFinite(lineHumRatio)
    && lineHumRatio >= 0
    && lineHumRatio <= 0.25
    && voiceSynthesisTokenCountsValid(validation)
    && voiceSynthesisModulationScore(validation) !== null;
}

function isVoiceSynthesisAmplitudeAdvisory(validation) {
  const reasons = voiceSynthesisValidationReasons(validation);
  const coverage = validation?.coverage;
  const activity = validation?.waveformHealth?.activity;
  const lineHumRatio = validation?.waveformHealth?.lineHumRatio;
  return validation?.accepted !== true
    && typeof coverage === "number"
    && Number.isFinite(coverage)
    && coverage >= 0.92
    && coverage <= 1
    && reasons.length > 0
    && reasons.every((reason) => reason === "unstable_amplitude_detected")
    && voiceSynthesisTokenCountsValid(validation)
    && voiceSynthesisModulationScore(validation) !== null
    && typeof activity === "number"
    && Number.isFinite(activity)
    && activity >= 0.2
    && activity <= 1
    && typeof lineHumRatio === "number"
    && Number.isFinite(lineHumRatio)
    && lineHumRatio >= 0
    && lineHumRatio <= 0.25;
}

function isVoiceSynthesisCoverageAdvisory(validation) {
  const reasons = voiceSynthesisValidationReasons(validation);
  const coverage = validation?.coverage;
  const activity = validation?.waveformHealth?.activity;
  const lineHumRatio = validation?.waveformHealth?.lineHumRatio;
  return reasons.length > 0
    && reasons.every((reason) => reason === "ordered_text_coverage_low" || reason === "unstable_amplitude_detected")
    && reasons.includes("ordered_text_coverage_low")
    && typeof coverage === "number"
    && Number.isFinite(coverage)
    && coverage >= 0.5
    && coverage <= 1
    && voiceSynthesisTokenCountsValid(validation)
    && voiceSynthesisModulationScore(validation) !== null
    && typeof activity === "number"
    && Number.isFinite(activity)
    && activity >= 0.2
    && activity <= 1
    && typeof lineHumRatio === "number"
    && Number.isFinite(lineHumRatio)
    && lineHumRatio >= 0
    && lineHumRatio <= 0.25;
}

async function repairVoiceSynthesisCandidates({ candidates, tempDir, remediations, signal = null }) {
  throwIfVoiceAbortSignalAborted(signal);
  const repairRequests = candidates
    .map((candidate) => ({ candidate, remediation: remediations.get(candidate.id) }))
    .filter(({ remediation }) => remediation?.reason === "line_hum_detected");
  if (!repairRequests.length) {
    return candidates;
  }
  const repaired = await callVoiceEngineWorker({
    action: "repair-synthesis-batch",
    candidates: repairRequests.map(({ candidate, remediation }) => ({
      id: candidate.id,
      audioPath: candidate.audioPath,
      outputPath: path.join(tempDir, `${candidate.id}-repaired.wav`),
      lineHumFrequencyHz: remediation.lineHumFrequencyHz
    }))
  }, { engine: voicePreparationEngineId, timeoutMs: voiceEngineRequestTimeoutMs, signal });
  const byId = new Map((Array.isArray(repaired?.results) ? repaired.results : []).map((item) => [String(item?.id || ""), item]));
  return candidates.map((candidate) => {
    const remediation = remediations.get(candidate.id);
    if (!remediation || remediation.reason !== "line_hum_detected") {
      return candidate;
    }
    const result = byId.get(candidate.id);
    const outputPath = String(result?.outputPath || "");
    if (!outputPath || !pathIsInside(tempDir, outputPath)) {
      throw new Error(`Voice remediation did not return a safe audio candidate for clause ${candidate.index}.`);
    }
    return {
      ...candidate,
      audioPath: outputPath,
      remediation: {
        reason: remediation.reason,
        appliedFilters: Array.isArray(result?.appliedFilters)
          ? result.appliedFilters.map((filter) => sanitizeUnicodeText(filter)).filter(Boolean).slice(0, 6)
          : []
      }
    };
  });
}

function openVoiceRetrySpeed(settings, attempt) {
  const requested = Number(settings?.speed);
  const base = Number.isFinite(requested) ? requested : 1;
  const adjustment = [0, -0.035, 0.035][Math.max(0, Math.min(2, attempt - 1))] || 0;
  return Number(Math.max(0.7, Math.min(1.3, base + adjustment)).toFixed(3));
}

function voiceSynthesisClausePlan(cleanText, parsedSegments = []) {
  const styledSegments = Array.isArray(parsedSegments)
    ? parsedSegments.filter((segment) => String(segment?.text || "").trim())
    : [];
  const sourceSegments = styledSegments.length
    ? styledSegments
    : [{ style: "neutral", text: cleanText }];
  const clauses = [];
  for (const segment of sourceSegments) {
    for (const text of splitVoiceSynthesisClauses(segment.text)) {
      clauses.push({
        id: `clause-${clauses.length + 1}`,
        index: clauses.length + 1,
        text,
        style: segment.style || "neutral"
      });
    }
  }
  return clauses.length
    ? clauses
    : [{ id: "clause-1", index: 1, text: cleanText, style: "neutral" }];
}

function voiceSynthesisTextHash(value) {
  return createHash("sha256")
    .update(normalizeVoiceTranscript(value), "utf8")
    .digest("hex")
    .slice(0, 24);
}

function stabilizeRepeatedChineseTokens(value, boundary = "，") {
  const separator = String(boundary || "，");
  return String(value || "").replace(/([\u3400-\u9fff])\1{2,}([，,、]?)/gu, (match, character, originalBoundary) => {
    const originalBoundaryLength = [...String(originalBoundary || "")].length;
    const repeatCount = Math.max(3, [...match].length - originalBoundaryLength);
    // Give short repeated fillers explicit acoustic boundaries. Consume the
    // original soft punctuation so the transformation never creates doubled
    // punctuation. The caller rotates the boundary deterministically across
    // GPT candidates; the evaluator still receives the original text.
    return Array.from({ length: repeatCount }, () => character).join(separator) + separator;
  });
}

function normalizeVoiceGenerationText(value) {
  return String(value || "")
    .replace(/\bMagicBox\b/giu, "Magic Box")
    .replace(/\bv(\d+)\.(\d+)\b/giu, "V$1.$2");
}

async function concatenateVoiceSynthesisWavs(inputPaths, outputPath, signal = null, pauseMs = 0) {
  throwIfVoiceAbortSignalAborted(signal);
  if (!inputPaths.length) {
    throw new Error("No validated speech clauses were available to combine.");
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (inputPaths.length === 1) {
    await fs.copyFile(inputPaths[0], outputPath);
    return;
  }
  const inputArgs = inputPaths.flatMap((inputPath) => ["-i", inputPath]);
  const normalizedPauseMs = Math.max(0, Math.min(500, Math.round(Number(pauseMs) || 0)));
  const delayFilters = inputPaths
    .map((_, index) => index === 0 || normalizedPauseMs <= 0
      ? ""
      : `[${index}:a]adelay=${normalizedPauseMs}|${normalizedPauseMs}[delayed${index}]`)
    .filter(Boolean);
  const concatLabels = inputPaths.map((_, index) => (
    index === 0 || normalizedPauseMs <= 0 ? `[${index}:a]` : `[delayed${index}]`
  )).join("");
  const filterComplex = [
    ...delayFilters,
    `${concatLabels}concat=n=${inputPaths.length}:v=0:a=1[voice]`
  ].join(";");
  await runFfmpegVoiceCommand([
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    ...inputArgs,
    "-filter_complex", filterComplex,
    "-map", "[voice]",
    "-ac", "1",
    "-ar", "32000",
    "-c:a", "pcm_s16le",
    outputPath
  ], { timeoutMs: voiceEngineRequestTimeoutMs });
  throwIfVoiceAbortSignalAborted(signal);
}

async function synthesizeValidatedVoiceClauses({
  engine,
  cleanText,
  effectiveLanguage,
  parsedSegments,
  referenceAudioPath = "",
  baselineAudioPaths = [],
  settings = {},
  tempDir,
  makeBatchRequest,
  settingsForAttempt = null,
  signal = null
}) {
  throwIfVoiceAbortSignalAborted(signal);
  const clausePlan = voiceSynthesisClausePlan(cleanText, parsedSegments);
  const accepted = new Map();
  const attemptsByClause = new Map(clausePlan.map((clause) => [clause.id, []]));
  const amplitudeAdvisoriesByClause = new Map(clausePlan.map((clause) => [clause.id, []]));
  const coverageAdvisoriesByClause = new Map(clausePlan.map((clause) => [clause.id, []]));
  const advisorySelections = new Map();
  const integrityAttempts = [];
  const warnings = [];
  let pending = clausePlan.slice();
  const retryLimit = 3;
  const remediations = new Map();

  for (let attempt = 1; pending.length && attempt <= retryLimit; attempt += 1) {
    throwIfVoiceAbortSignalAborted(signal);
    const attemptSettings = settingsForAttempt
      ? settingsForAttempt({ attempt, remediations })
      : { ...settings, integrityAttempt: attempt };
    const workerClauses = pending.map((clause) => ({
      id: clause.id,
      index: clause.index,
      text: clause.text,
      outputPath: path.join(tempDir, `${clause.id}-attempt-${attempt}.wav`),
      style: clause.style
    }));
    let generated;
    try {
      const callWorker = attemptSettings.conversationMode || voiceCloneFeatureFlags(process.env).persistentWorkers
        ? callLiveVoiceEngineWorker
        : callVoiceEngineWorker;
      generated = await callWorker(
        makeBatchRequest({ clauses: workerClauses, settings: attemptSettings, attempt }),
        { engine, signal }
      );
    } catch (error) {
      if (signal?.aborted || error.code === "VOICE_JOB_CANCELLED") throw error;
      integrityAttempts.push({
        attempt,
        accepted: false,
        reason: "worker_generation_failed",
        message: sanitizeUnicodeText(error.message || "Voice synthesis worker failed.")
      });
      for (const clause of pending) {
        attemptsByClause.get(clause.id)?.push({
          clauseIndex: clause.index,
          clauseTextHash: voiceSynthesisTextHash(clause.text),
          attempt,
          accepted: false,
          coverage: 0,
          reason: "worker_generation_failed",
          reasons: ["worker_generation_failed"],
          waveformHealth: {}
        });
      }
      if (attempt < retryLimit) continue;
      throw error;
    }
    const generatedById = new Map((Array.isArray(generated?.candidates) ? generated.candidates : []).map((candidate) => [String(candidate?.id || ""), candidate]));
    const candidates = workerClauses.map((clause) => {
      const candidate = generatedById.get(clause.id);
      const outputPath = String(candidate?.outputPath || clause.outputPath || "");
      if (!candidate || !outputPath || !pathIsInside(tempDir, outputPath)) {
        throw new Error(`Voice synthesis did not return a safe audio candidate for clause ${clause.index}.`);
      }
      return {
        ...clause,
        candidate,
        audioPath: outputPath,
        expectedText: clause.text
      };
    });
    const repairedCandidates = await repairVoiceSynthesisCandidates({ candidates, tempDir, remediations, signal });
    const validated = await validateVoiceSynthesisCandidates({
      candidates: repairedCandidates,
      language: effectiveLanguage,
      referenceAudioPath,
      baselineAudioPaths,
      settings: attemptSettings,
      signal
    });
    const failed = [];
    for (const item of validated) {
      const validation = item.validation;
      const strictlyAccepted = isVoiceSynthesisStrictlyAccepted(validation);
      const record = {
        clauseIndex: item.index,
        clauseTextHash: voiceSynthesisTextHash(item.text),
        attempt,
        accepted: strictlyAccepted,
        coverage: Number(validation.coverage) || 0,
        reason: sanitizeUnicodeText(validation.reason || ""),
        reasons: Array.isArray(validation.reasons)
          ? validation.reasons.map((reason) => sanitizeUnicodeText(reason)).filter(Boolean)
          : [],
        waveformHealth: validation.waveformHealth || {},
        preset: {
          speed: Number.isFinite(Number(attemptSettings.speed)) ? Number(attemptSettings.speed) : null,
          seed: Number.isFinite(Number(attemptSettings.seed)) ? Number(attemptSettings.seed) : null,
          style: sanitizeUnicodeText(item.candidate?.appliedStyle || item.style || "neutral"),
          styleStrength: Number.isFinite(Number(item.candidate?.appliedStyleStrength)) ? Number(item.candidate.appliedStyleStrength) : null,
          pitchSemitones: Number.isFinite(Number(item.candidate?.appliedPitchSemitones)) ? Number(item.candidate.appliedPitchSemitones) : null,
          recoverySplit: sanitizeUnicodeText(item.candidate?.recoverySplit || "sentence"),
          semanticStrategy: sanitizeUnicodeText(item.candidate?.semanticStrategy || "profile"),
          remediation: Array.isArray(item.remediation?.appliedFilters) ? item.remediation.appliedFilters : []
        }
      };
      record.advisoryAmplitude = isVoiceSynthesisAmplitudeAdvisory(validation);
      record.advisoryCoverage = isVoiceSynthesisCoverageAdvisory(validation);
      integrityAttempts.push(record);
      attemptsByClause.get(item.id)?.push(record);
      if (strictlyAccepted) {
        accepted.set(item.id, item);
        warnings.push(...(Array.isArray(item.candidate.warnings) ? item.candidate.warnings : []));
      } else {
        const validationReasons = voiceSynthesisValidationReasons(validation);
        if (record.advisoryAmplitude) {
          amplitudeAdvisoriesByClause.get(item.id)?.push({ item, record });
        }
        if (record.advisoryCoverage) {
          coverageAdvisoriesByClause.get(item.id)?.push({ item, record });
        }
        if (validation.reason === "line_hum_detected" || validationReasons.includes("line_hum_detected")) {
          remediations.set(item.id, {
            reason: "line_hum_detected",
            lineHumFrequencyHz: Number(validation.waveformHealth?.lineHumFrequencyHz) || 0
          });
        } else {
          remediations.delete(item.id);
        }
        failed.push(item);
      }
    }
    if (!failed.length) {
      pending = [];
      break;
    }
    pending = failed.map((item) => ({
      id: item.id,
      index: item.index,
      text: item.text,
      style: item.style
    }));
  }

  if (pending.length) {
    const unresolved = [];
    for (const clause of pending) {
      const advisoryCandidates = [
        ...(amplitudeAdvisoriesByClause.get(clause.id) || []),
        ...(coverageAdvisoriesByClause.get(clause.id) || [])
      ].filter((candidate, index, all) => all.findIndex((item) => item.record === candidate.record) === index);
      const selected = advisoryCandidates.sort((left, right) => (
        Number(right.item.validation?.coverage || 0) - Number(left.item.validation?.coverage || 0)
        || voiceSynthesisModulationScore(left.item.validation) - voiceSynthesisModulationScore(right.item.validation)
        || left.record.attempt - right.record.attempt
      ))[0];
      if (!selected) {
        unresolved.push(clause);
        continue;
      }
      selected.record.selectedAsAdvisory = true;
      accepted.set(clause.id, selected.item);
      advisorySelections.set(clause.id, {
        attempt: selected.record.attempt,
        modulationScore: voiceSynthesisModulationScore(selected.item.validation),
        coverageAdvisory: selected.record.advisoryCoverage === true,
        amplitudeAdvisory: selected.record.advisoryAmplitude === true
      });
      warnings.push(...(Array.isArray(selected.item.candidate.warnings) ? selected.item.candidate.warnings : []));
    }
    pending = unresolved;
  }

  if (pending.length) {
    const failed = pending[0];
    const lastAttempt = attemptsByClause.get(failed.id)?.at(-1);
    const reason = lastAttempt?.reasons?.length ? lastAttempt.reasons.join(", ") : lastAttempt?.reason || "speech_integrity_failed";
    throw new Error(`Generated speech clause ${failed.index} did not pass the local coverage and waveform check after ${retryLimit} attempts (${reason}). No partial output was saved.`);
  }

  const acceptedClauses = clausePlan.map((clause) => accepted.get(clause.id));
  if (acceptedClauses.some((item) => !item)) {
    throw new Error("A validated speech clause was missing before output assembly. No partial output was saved.");
  }
  const mergedPath = path.join(tempDir, "validated-speech.wav");
  await concatenateVoiceSynthesisWavs(
          acceptedClauses.map((item) => item.audioPath),
          mergedPath,
          signal,
    clausePlan.length > 1 && cleanText.length > 48 ? 120 : 0
  );
  // Every clause has already passed the text gate above. Copying or joining
  // those PCM WAVs cannot remove a word, while a second whole-script ASR pass
  // is especially prone to collapsing chants and words around clause joins.
  // Preserve the clause coverage evidence and re-check only the waveform that
  // was actually assembled for playback.
  const finalWaveformIntegrity = await validateVoiceSynthesisWaveformCandidate({
    audioPath: mergedPath,
    expectedText: cleanText,
    language: effectiveLanguage,
    referenceAudioPath,
    baselineAudioPaths,
    settings,
    signal
  });
  const finalIntegrity = combineVoiceClauseIntegrity(acceptedClauses, finalWaveformIntegrity);
  const finalStrictlyAccepted = isVoiceSynthesisStrictlyAccepted(finalIntegrity);
  const finalAmplitudeAdvisory = isVoiceSynthesisAmplitudeAdvisory(finalIntegrity);
  const finalCoverageAdvisory = isVoiceSynthesisCoverageAdvisory(finalIntegrity);
  if (!finalStrictlyAccepted && !finalAmplitudeAdvisory && !finalCoverageAdvisory) {
    const allReasons = voiceSynthesisValidationReasons(finalIntegrity);
    const reason = allReasons.length ? allReasons.join(", ") : sanitizeUnicodeText(finalIntegrity.reason || "speech_integrity_failed");
    throw new Error(`Combined speech did not pass the final local coverage and waveform check (${reason}). No partial output was saved.`);
  }
  if (advisorySelections.size) {
    if ([...advisorySelections.values()].some((selection) => selection.coverageAdvisory)) {
      warnings.push("Generated speech used the best audible clause after three local ASR coverage attempts; listen for any missed or changed word.");
    }
    if ([...advisorySelections.values()].some((selection) => selection.amplitudeAdvisory)) {
      warnings.push("Generated speech used the least-modulated text-complete attempt after the amplitude detector flagged normal speech rhythm.");
    }
  }
  if (finalAmplitudeAdvisory) {
    warnings.push("Combined speech passed coverage, activity, and hum checks. Its amplitude score is advisory because sentence joins and normal syllable rhythm can trigger this detector.");
  }
  if (finalCoverageAdvisory) {
    warnings.push("Combined speech was saved after recovery attempts because waveform checks passed even though local ASR could not certify every word.");
  }
  throwIfVoiceAbortSignalAborted(signal);
  const buffer = await fs.readFile(mergedPath);
  throwIfVoiceAbortSignalAborted(signal);
  return {
    buffer,
    acceptedClauses,
    warnings: Array.from(new Set(warnings.map((warning) => sanitizeUnicodeText(warning)).filter(Boolean))),
    synthesisIntegrity: {
      coverage: Number(finalIntegrity.coverage) || 0,
      waveformHealth: finalIntegrity.waveformHealth || {},
      ...(finalIntegrity.secondaryAsr ? { secondaryAsr: finalIntegrity.secondaryAsr } : {}),
      attempts: integrityAttempts,
      clauses: clausePlan.map((clause) => ({
        index: clause.index,
        textHash: voiceSynthesisTextHash(clause.text),
        attempts: attemptsByClause.get(clause.id) || [],
        selectedAttempt: advisorySelections.get(clause.id)?.attempt
          || (attemptsByClause.get(clause.id) || []).find((attempt) => attempt.accepted)?.attempt
          || null,
        advisoryAmplitudeWarning: advisorySelections.has(clause.id)
          && advisorySelections.get(clause.id)?.amplitudeAdvisory === true,
        advisoryCoverageWarning: advisorySelections.has(clause.id)
          && advisorySelections.get(clause.id)?.coverageAdvisory === true
      })),
      final: {
        accepted: true,
        strictValidationAccepted: finalStrictlyAccepted,
        advisoryAmplitudeWarning: finalAmplitudeAdvisory,
        advisoryCoverageWarning: finalCoverageAdvisory,
        coverage: Number(finalIntegrity.coverage) || 0,
        reason: finalCoverageAdvisory
          ? "ordered_text_coverage_low"
          : finalAmplitudeAdvisory ? "unstable_amplitude_detected" : "",
        reasons: finalAmplitudeAdvisory || finalCoverageAdvisory ? voiceSynthesisValidationReasons(finalIntegrity) : []
      }
    }
  };
}

async function synthesizeOpenVoiceSpeech({ text, language, profile, settings = {}, parsedSegments = [], signal = null }) {
  await assertVoiceNeuralEngineReady();
  await assertVoicePreparationReady();
  if (profile.voiceModel?.engine !== voiceNeuralEngineId || !profile.voiceModel?.modelPath) {
    throw new Error("Rebuild this Target Voice Profile with the OpenVoice V2 local neural engine first.");
  }
  const cleanText = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleanText) {
    throw new Error("Enter text to generate.");
  }
  const effectiveLanguage = resolveVoiceLanguage({
    requestedLanguage: language,
    profileLanguage: profile.language || profile.voiceModel?.language,
    text: cleanText
  });
  const tempDir = path.join(os.tmpdir(), makeVoiceId("voice-openvoice-tts"));
  try {
    await fs.mkdir(tempDir, { recursive: true });
    throwIfVoiceAbortSignalAborted(signal);
    const synthesis = await synthesizeValidatedVoiceClauses({
      engine: voiceNeuralEngineId,
      cleanText,
      effectiveLanguage,
      parsedSegments,
      referenceAudioPath: voiceModelReferenceAudioPath(profile.voiceModel),
      baselineAudioPaths: voiceModelValidationBaselineAudioPaths(profile),
      settings,
      tempDir,
      signal,
      settingsForAttempt: ({ attempt }) => ({
        ...settings,
        speed: openVoiceRetrySpeed(settings, attempt),
        integrityAttempt: attempt,
        retryPreset: `openvoice-speed-${openVoiceRetrySpeed(settings, attempt)}`
      }),
      makeBatchRequest: ({ clauses, settings: attemptSettings }) => ({
        action: "tts-batch",
        profileId: profile.id,
        language: effectiveLanguage,
        requestedLanguage: normalizeVoiceLanguage(language),
        profileLanguage: normalizeVoiceLanguage(profile.language || profile.voiceModel?.language),
        text: cleanText,
        segments: parsedSegments,
        clauses,
        voiceModel: profile.voiceModel,
        settings: attemptSettings
      })
    });
    const result = synthesis.acceptedClauses[0]?.candidate || {};
    const buffer = synthesis.buffer;
    let durationSeconds = Number(result.durationSeconds) || 0;
    try {
      durationSeconds = parseWavInfo(buffer).durationSeconds;
    } catch {
      durationSeconds = durationSeconds || Math.max(1.2, Math.min(25, cleanText.length / 12));
    }
    return {
      buffer,
      durationSeconds,
      engine: voiceNeuralEngineId,
      modelVersion: result.modelVersion || profile.voiceModel?.modelVersion || voiceNeuralModelVersion,
      language: normalizeVoiceLanguage(result.language || effectiveLanguage, { allowAuto: false }),
      warnings: synthesis.warnings,
      synthesisIntegrity: synthesis.synthesisIntegrity
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function buildPipelineV2PolicyCandidate({
  candidate,
  expectedText,
  profile,
  pipelineFlags,
  qualityMode,
  preset = null,
  processingSteps = 0,
  durationMs = 0,
  converted = null
}) {
  const contentReport = evaluateContentPolicy({
    primaryAsr: {
      coverage: Number(candidate.validation?.coverage) || 0,
      rawCoverage: candidate.validation?.primaryAsrRawCoverage,
      expectedTokenCount: candidate.validation?.expectedTokenCount,
      observedTokenCount: candidate.validation?.observedTokenCount,
      secondaryAuthoritative: candidate.validation?.secondaryAsrAuthoritative === true
        || candidate.validation?.mixedScriptSecondaryAuthoritative === true
    },
    secondaryAsr: candidate.validation?.secondaryAsr || null,
    expectedText,
    forcedAlignmentPass: candidate.validation?.forcedAlignmentPass === true,
    requiredSecondary: pipelineFlags.secondaryAsr === true,
    qualityMode
  });
  const artifactReport = evaluateArtifactPolicy(candidate.validation?.waveformHealth, {
    required: true,
    qualityMode
  });
  const identityReport = evaluateIdentityPolicy({
    encoderA: {
      passed: candidate.identity?.accepted === true && Number(candidate.identity?.identityGain) >= -0.01,
      score: Number(candidate.identity?.targetSimilarity) || 0
    },
    encoderB: candidate.identity?.encoderB || null,
    calibrationA: profile.voiceModel?.identityCalibration?.encoderA,
    calibrationB: profile.voiceModel?.identityCalibration?.encoderB,
    required: pipelineFlags.dualSpeakerGate === true,
    qualityMode
  });
  const perceptualReport = evaluatePerceptualPolicy(candidate.perceptual || candidate.validation?.perceptual, {
    required: pipelineFlags.perceptualGate === true,
    qualityMode,
    baseline: candidate.validation?.perceptualBaseline
  });
  const qualityReport = createVoiceQualityReport({
    qualityMode,
    flags: pipelineFlags,
    content: contentReport,
    identity: identityReport,
    perceptual: perceptualReport,
    artifacts: artifactReport,
    evaluatorVersions: {
      policy: voiceQualityPolicyVersion,
      speaker: candidate.identity?.evaluatorVersion || "",
      perceptual: candidate.perceptual?.evaluatorVersion || ""
    }
  });
  const strictlyAccepted = contentReport.passed === true && artifactReport.passed === true;
  return {
    id: candidate.id,
    audioPath: candidate.audioPath,
    buffer: candidate.buffer,
    contentPassed: strictlyAccepted,
    artifactPassed: artifactReport.passed === true,
    naturalnessPassed: perceptualReport.passed === true,
    identity: {
      encoderA: identityReport.encoderA,
      encoderB: identityReport.encoderB,
      stability: Number(candidate.identity?.targetSimilarityFloor) || 0
    },
    perceptual: { passed: perceptualReport.passed === true, ...perceptualReport },
    naturalness: {
      score: Number(candidate.validation?.waveformHealth?.naturalnessScore) || Number(perceptualReport.utmos) || 0
    },
    processingSteps,
    nativeSampleRate: 32000,
    reasons: [
      ...(identityReport.passed ? [] : ["target_identity_weak"]),
      ...(qualityReport.decision.reasons || []),
      ...(strictlyAccepted ? [] : voiceSynthesisValidationReasons(candidate.validation))
    ],
    qualityReport,
    validation: candidate.validation,
    identityMetrics: candidate.identity,
    preset,
    durationMs,
    converted
  };
}

async function refineGptCandidateWithSeedPipelineV2({
  sourceBuffer,
  sourceAudioPath,
  sourceDurationSeconds,
  sourceClauseAudioPaths = [],
  sourceClauseTexts = [],
  expectedText,
  effectiveLanguage,
  profile,
  targetReference,
  settings = {},
  qualityMode = "strict",
  onProgress = null,
  signal = null,
  acquireSeedVcResources = null
}) {
  const workDir = path.join(os.tmpdir(), makeVoiceId("voice-seed-vc-pipeline-v2"));
  const attempts = [];
  let resourceLease = null;
  try {
    await fs.mkdir(workDir, { recursive: true });
    const sourcePath = sourceAudioPath || path.join(workDir, "source.wav");
    if (!sourceAudioPath) await fs.writeFile(sourcePath, sourceBuffer);
    const pipelineFlags = voiceCloneFeatureFlags(process.env);
    if (typeof acquireSeedVcResources === "function") {
      resourceLease = await acquireSeedVcResources({ profile, signal });
    }
    const identityReferenceAudioPaths = voiceProfileIdentityEvaluationAudioPaths(profile);
    const presetList = [
      { name: "conservative", seed: 4101, diffusionSteps: 30, inferenceCfgRate: 0.85 },
      { name: "identity", seed: 4102, diffusionSteps: 50, inferenceCfgRate: 0.85 },
      { name: "clarity-recovery", seed: 4103, diffusionSteps: 50, inferenceCfgRate: 0.85 }
    ];
    const requestedCount = Math.max(1, Math.min(3, Math.round(Number(settings.seedCandidateCount) || 3)));
    const candidates = [];
    const clauseCandidates = [];
    const scheduledPresets = presetList.slice(0, requestedCount);
    for (const [index, preset] of scheduledPresets.entries()) {
      throwIfVoiceAbortSignalAborted(signal);
      const startedAt = Date.now();
      const candidateId = `seed-full-${preset.name}`;
      try {
        const conversionSettings = {
          ...settings,
          ...preset,
          resultType: "full_conversion",
          seed: preset.seed,
          convertStyle: settings.copyStyle === true,
          targetBlendRatio: undefined
        };
        const clauseWiseConversion = !preset.assembly && sourceClauseAudioPaths.length > 1
          && sourceClauseAudioPaths.length === sourceClauseTexts.length;
        const clausePauseSeconds = sourceClauseTexts.join("").length > 48 ? 0.12 : 0;
        const clauseRecovery = clauseWiseConversion && preset.name === "clarity-recovery"
          ? await convertTtsRecoveryClauses({
              sourcePaths: sourceClauseAudioPaths,
              texts: sourceClauseTexts,
              outputDir: path.join(workDir, `${candidateId}-clauses`),
              seed: preset.seed,
              pauseMs: clausePauseSeconds * 1000,
              signal,
              durationOf: (buffer) => parseWavInfo(buffer).durationSeconds,
              concatenate: concatenateVoiceSynthesisWavs,
              convert: ({ sourceAudioPath, sourceDurationSeconds, seed, index }) => convertSeedVcSpeech({
                sourceAudioPath,
                sourceDurationSeconds,
                targetReferenceAudioPath: targetReference.audioPath,
                settings: { ...conversionSettings, seed },
                targetBlendRatio: 0,
                onProgress: () => onProgress?.({ progress: 90, message: `Recovering speech clause ${index + 1}/${sourceClauseAudioPaths.length}` }),
                signal
              })
            })
          : null;
        let assembledConversion = null;
        if (preset.assembly) {
          const assembledPath = path.join(workDir, "validated-clause-assembly.wav");
          onProgress?.({ progress: 94, message: "Validating recovered speech assembly" });
          await concatenateVoiceSynthesisWavs(preset.assembly.map(({ clause }) => clause.audioPath), assembledPath, signal, clausePauseSeconds * 1000);
          assembledConversion = { buffer: await fs.readFile(assembledPath), conversionStrategy: "validated-clause-assembly" };
        }
        const converted = preset.assembly
          ? assembledConversion
          : clauseRecovery || await convertSeedVcSpeech({
            sourceAudioPath: sourcePath,
            sourceDurationSeconds,
            targetReferenceAudioPath: targetReference.audioPath,
            settings: conversionSettings,
            targetBlendRatio: 0,
            onProgress: (event) => onProgress?.({
              progress: Math.max(78, Math.min(96, 78 + Math.round((Number(event.progress) || 0) * 0.18))),
              message: `Evaluating Seed-VC ${preset.name} full conversion`
            }),
            signal
          });
        const candidatePath = path.join(workDir, `${candidateId}.wav`);
        await fs.writeFile(candidatePath, converted.buffer);
        let validated;
        if (clauseWiseConversion) {
          const convertedClausePaths = clauseRecovery?.clausePaths || [];
          if (!clauseRecovery) {
            const sourceClauseDurations = [];
            let sourceClauseTotal = 0;
            for (const clauseSourcePath of sourceClauseAudioPaths) {
              const clauseDuration = parseWavInfo(await fs.readFile(clauseSourcePath)).durationSeconds;
              sourceClauseDurations.push(clauseDuration);
              sourceClauseTotal += clauseDuration;
            }
            sourceClauseTotal += Math.max(0, sourceClauseDurations.length - 1) * clausePauseSeconds;
            const convertedDuration = parseWavInfo(converted.buffer).durationSeconds;
            const validationPaddingSeconds = 0.45;
            let sourceOffset = 0;
            for (let clauseIndex = 0; clauseIndex < sourceClauseDurations.length; clauseIndex += 1) {
              const clauseStart = sourceClauseTotal > 0 ? sourceOffset / sourceClauseTotal * convertedDuration : 0;
              sourceOffset += sourceClauseDurations[clauseIndex]
                + (clauseIndex < sourceClauseDurations.length - 1 ? clausePauseSeconds : 0);
              const clauseEnd = sourceClauseTotal > 0 ? sourceOffset / sourceClauseTotal * convertedDuration : convertedDuration;
              const clausePath = path.join(workDir, `${candidateId}-validation-clause-${clauseIndex + 1}.wav`);
              await runFfmpegVoiceCommand([
                "-y",
                "-hide_banner",
                "-loglevel", "error",
                "-ss", String(Math.max(0, clauseStart - validationPaddingSeconds).toFixed(4)),
                "-t", String(Math.max(0.1, (clauseEnd - clauseStart + validationPaddingSeconds * 2).toFixed(4))),
                "-i", candidatePath,
                "-ac", "1",
                "-ar", "32000",
                "-c:a", "pcm_s16le",
                clausePath
              ], { timeoutMs: voiceEngineRequestTimeoutMs, signal });
              convertedClausePaths.push(clausePath);
            }
          }
          const clauseValidated = await validateVoiceSynthesisCandidates({
            candidates: convertedClausePaths.map((audioPath, clauseIndex) => ({
              id: `${candidateId}-clause-${clauseIndex + 1}`,
              audioPath,
              expectedText: sourceClauseTexts[clauseIndex]
            })),
            language: effectiveLanguage,
            referenceAudioPath: voiceModelReferenceAudioPath(profile.voiceModel),
            baselineAudioPaths: voiceModelValidationBaselineAudioPaths(profile),
            settings: { ...settings, enforceSpectralQuality: true },
            signal
          });
          const joinedWaveform = await validateVoiceSynthesisWaveformCandidate({
            audioPath: candidatePath,
            expectedText,
            language: effectiveLanguage,
            referenceAudioPath: voiceModelReferenceAudioPath(profile.voiceModel),
            baselineAudioPaths: voiceModelValidationBaselineAudioPaths(profile),
            settings: { ...settings, enforceSpectralQuality: true },
            signal
          });
          const clauseCoverage = clauseValidated.map((item) => item.validation);
          const recoveryClauses = clauseValidated.map((item, clauseIndex) => ({
            id: item.id, index: clauseIndex + 1, text: sourceClauseTexts[clauseIndex], audioPath: convertedClausePaths[clauseIndex], validation: item.validation,
            boundaryStrategy: clauseRecovery ? "exact-converted-clause" : "padded-validation-only"
          }));
          // Context padding helps recognition but contains neighbouring speech.
          // Never concatenate those diagnostic files directly into an output.
          const trimCandidates = clauseRecovery || pipelineFlags.secondaryAsr !== true ? [] : recoveryClauses.filter(clause =>
            isVoiceSynthesisStrictlyAccepted(clause.validation) && clause.validation?.secondaryAsr?.available === true);
          if (trimCandidates.length) {
            const trimmed = await callVoiceEngineWorker({
              action: "trim-synthesis-clause-batch", language: effectiveLanguage,
              candidates: trimCandidates.map(clause => ({ id: clause.id, audioPath: clause.audioPath, expectedText: clause.text,
                outputPath: path.join(workDir, `${clause.id}-aligned.wav`) }))
            }, { engine: voicePreparationEngineId, timeoutMs: voiceEngineRequestTimeoutMs, signal });
            const aligned = trimCandidates.flatMap(clause => {
              const matches = (trimmed?.results || []).filter(item => item.id === clause.id && item.accepted === true
                && item.boundaryStrategy === "silence-aligned-converted-clause"
                && path.resolve(item.outputPath || "") === path.join(workDir, `${clause.id}-aligned.wav`));
              return matches.length === 1 ? [{ ...clause, audioPath: matches[0].outputPath, expectedText: clause.text, alignment: matches[0] }] : [];
            });
            if (aligned.length) {
              const revalidated = await validateVoiceSynthesisCandidates({ candidates: aligned, language: effectiveLanguage,
                referenceAudioPath: voiceModelReferenceAudioPath(profile.voiceModel), baselineAudioPaths: voiceModelValidationBaselineAudioPaths(profile),
                settings: { ...settings, enforceSpectralQuality: true }, signal });
              for (const item of revalidated) {
                const clause = recoveryClauses.find(value => value.id === item.id);
                const alignment = aligned.find(value => value.id === item.id);
                if (clause && alignment) Object.assign(clause, { audioPath: alignment.audioPath, validation: item.validation,
                  boundaryStrategy: "silence-aligned-converted-clause", alignment: alignment.alignment });
              }
            }
          }
          clauseCandidates.push({ id: candidateId, synthesis: { acceptedClauses: recoveryClauses } });
          if (index === requestedCount - 1) {
            const assembly = selectStrictTtsRecoveryClauses(clauseCandidates, isVoiceSynthesisStrictlyAccepted);
            if (assembly) scheduledPresets.push({ name: "clause-assembly", seed: null, diffusionSteps: 0, inferenceCfgRate: 0, assembly });
          }
          const secondaryValues = clauseCoverage
            .map((item) => item?.secondaryAsr)
            .filter((item) => item?.available === true && Number.isFinite(Number(item.coverage)));
          const reasons = Array.from(new Set([
            ...clauseCoverage.flatMap((item) => voiceSynthesisValidationReasons(item)),
            ...voiceSynthesisValidationReasons(joinedWaveform)
          ]));
          const aggregate = {
            ...joinedWaveform,
            accepted: clauseCoverage.every((item) => item?.accepted === true) && joinedWaveform.accepted === true && reasons.length === 0,
            coverage: clauseCoverage.length ? Math.min(...clauseCoverage.map((item) => Number(item.coverage) || 0)) : 0,
            expectedTokenCount: clauseCoverage.reduce((sum, item) => sum + (Number(item.expectedTokenCount) || 0), 0),
            observedTokenCount: clauseCoverage.reduce((sum, item) => sum + (Number(item.observedTokenCount) || 0), 0),
            secondaryAsr: secondaryValues.length
              ? {
                ...secondaryValues[0],
                coverage: Math.min(...secondaryValues.map((item) => Number(item.coverage) || 0)),
                expectedTokenCount: clauseCoverage.reduce((sum, item) => sum + (Number(item.secondaryAsr?.expectedTokenCount) || 0), 0),
                observedTokenCount: clauseCoverage.reduce((sum, item) => sum + (Number(item.secondaryAsr?.observedTokenCount) || 0), 0)
              }
              : null,
            reasons,
            reason: reasons[0] || "",
            clauseCoverageValidated: true,
            clauseBoundaryStrategy: clauseRecovery ? "exact-converted-clauses" : "proportional-source-duration",
            clauses: clauseCoverage.map((item, clauseIndex) => ({
              index: clauseIndex + 1,
              coverage: Number(item.coverage) || 0,
              secondaryCoverage: Number(item.secondaryAsr?.coverage) || null,
              accepted: item.accepted === true
            }))
          };
          validated = [{ id: candidateId, audioPath: candidatePath, expectedText, validation: aggregate }];
        } else {
          validated = await validateVoiceSynthesisCandidates({
            candidates: [{ id: candidateId, audioPath: candidatePath, expectedText }],
            language: effectiveLanguage,
            referenceAudioPath: voiceModelReferenceAudioPath(profile.voiceModel),
            baselineAudioPaths: voiceModelValidationBaselineAudioPaths(profile),
            settings: { ...settings, enforceSpectralQuality: true },
            signal
          });
        }
        const identified = await analyzeSeedSpeechIdentityCandidates({
          sourceAudioPath: sourcePath,
          candidates: validated,
          targetReferenceAudioPath: targetReference.audioPath,
          targetReferenceAudioPaths: identityReferenceAudioPaths.length
            ? identityReferenceAudioPaths
            : targetReference.validationAudioPaths,
          settings: { ...settings, convertStyle: false },
          signal
        });
        const evaluated = await evaluateSeedSpeechQualityCandidates({
          candidates: identified,
          targetReferenceAudioPath: targetReference.audioPath,
          targetReferenceAudioPaths: identityReferenceAudioPaths.length
            ? identityReferenceAudioPaths
            : targetReference.validationAudioPaths,
          signal
        });
        const candidate = evaluated[0];
        const contentReport = evaluateContentPolicy({
          primaryAsr: {
            coverage: Number(candidate.validation?.coverage) || 0,
            rawCoverage: candidate.validation?.primaryAsrRawCoverage,
            expectedTokenCount: candidate.validation?.expectedTokenCount,
            observedTokenCount: candidate.validation?.observedTokenCount,
            secondaryAuthoritative: candidate.validation?.secondaryAsrAuthoritative === true
              || candidate.validation?.mixedScriptSecondaryAuthoritative === true,
            clauseCoverage: Array.isArray(candidate.validation?.clauses) ? candidate.validation.clauses : null
          },
          secondaryAsr: candidate.validation?.secondaryAsr || null,
          expectedText,
          forcedAlignmentPass: candidate.validation?.forcedAlignmentPass === true,
          requiredSecondary: pipelineFlags.secondaryAsr === true,
          qualityMode
        });
        const artifactReport = evaluateArtifactPolicy(candidate.validation?.waveformHealth, {
          required: true,
          qualityMode
        });
        const identityReport = evaluateIdentityPolicy({
          encoderA: {
            passed: candidate.identity?.accepted === true && Number(candidate.identity?.identityGain) >= -0.01,
            score: Number(candidate.identity?.targetSimilarity) || 0
          },
          encoderB: candidate.identity?.encoderB || null,
          calibrationA: profile.voiceModel?.identityCalibration?.encoderA,
          calibrationB: profile.voiceModel?.identityCalibration?.encoderB,
          required: pipelineFlags.dualSpeakerGate === true,
          qualityMode
        });
        const perceptualReport = evaluatePerceptualPolicy(candidate.perceptual || candidate.validation?.perceptual, {
          required: pipelineFlags.perceptualGate === true,
          qualityMode,
          baseline: candidate.validation?.perceptualBaseline
        });
        const qualityReport = createVoiceQualityReport({
          qualityMode,
          flags: pipelineFlags,
          content: contentReport,
          identity: identityReport,
          perceptual: perceptualReport,
          artifacts: artifactReport,
          evaluatorVersions: {
            policy: voiceQualityPolicyVersion,
            speaker: candidate.identity?.evaluatorVersion || "",
            perceptual: candidate.perceptual?.evaluatorVersion || ""
          }
        });
        const strictValidationAccepted = contentReport.passed === true && artifactReport.passed === true;
        const identityAccepted = identityReport.passed === true;
        const policyCandidate = {
          id: candidateId,
          audioPath: candidatePath,
          buffer: converted.buffer,
          contentPassed: strictValidationAccepted,
          artifactPassed: artifactReport.passed === true,
          naturalnessPassed: perceptualReport.passed === true,
          identity: {
            encoderA: identityReport.encoderA,
            encoderB: identityReport.encoderB,
            stability: Number(candidate.identity?.targetSimilarityFloor) || 0
          },
          perceptual: { passed: perceptualReport.passed === true, ...perceptualReport },
          naturalness: { score: Number(candidate.validation?.waveformHealth?.naturalnessScore) || Number(perceptualReport.utmos) || 0 },
          processingSteps: 1,
          nativeSampleRate: 32000,
          reasons: [
            ...(identityAccepted ? [] : ["target_identity_weak"]),
            ...(qualityReport.decision.reasons || []),
            ...(strictValidationAccepted ? [] : voiceSynthesisValidationReasons(candidate.validation))
          ],
          qualityReport,
          validation: candidate.validation,
          identityMetrics: candidate.identity,
          preset,
          conversionStrategy: converted.conversionStrategy || "whole-utterance",
          durationMs: Date.now() - startedAt,
          converted
        };
        candidates.push(policyCandidate);
        attempts.push({
          attempt: index + 1,
          preset: preset.name,
          accepted: candidatePassedForVoicePipeline(policyCandidate, pipelineFlags),
          resultType: "full_conversion",
          seed: preset.seed,
          diffusionSteps: preset.diffusionSteps,
          inferenceCfgRate: preset.inferenceCfgRate,
          convertStyle: false,
          conversionStrategy: converted.conversionStrategy || "whole-utterance",
          ...(preset.assembly ? { clauseSources: preset.assembly.map(({ clause, sourceCandidateId }) => ({ index: clause.index, sourceCandidateId,
            boundaryStrategy: clause.boundaryStrategy, startSeconds: clause.alignment?.startSeconds, endSeconds: clause.alignment?.endSeconds })) } : {}),
          ...(clauseRecovery ? { clauses: clauseRecovery.clauses } : {}),
          targetSimilarity: Number(candidate.identity?.targetSimilarity) || 0,
          identityGain: Number(candidate.identity?.identityGain) || 0,
          encoderA: policyCandidate.identity.encoderA,
          encoderB: policyCandidate.identity.encoderB,
          perceptual: {
            available: policyCandidate.perceptual?.available === true,
            score: Number.isFinite(Number(policyCandidate.perceptual?.utmos)) ? Number(policyCandidate.perceptual.utmos) : null,
            evaluatorVersion: policyCandidate.perceptual?.evaluatorVersion || ""
          },
          qualityReasons: policyCandidate.qualityReport?.decision?.reasons || [],
          durationMs: Date.now() - startedAt
        });
        // Once every enabled strict gate passes, additional diffusion runs
        // add latency without changing whether the requested quality is met.
        if (qualityMode === "strict" && candidatePassedForVoicePipeline(policyCandidate, pipelineFlags)) break;
      } catch (error) {
        if (signal?.aborted) throw error;
        attempts.push({
          attempt: index + 1,
          preset: preset.name,
          accepted: false,
          resultType: "full_conversion",
          code: sanitizeUnicodeText(error?.code || "seed_full_conversion_failed"),
          message: sanitizeUnicodeText(error?.message || "Seed-VC full conversion failed"),
          durationMs: Date.now() - startedAt
        });
      }
    }
    const baseline = {
      id: "gpt-direct-baseline",
      buffer: sourceBuffer,
      contentPassed: true,
      artifactPassed: true,
      naturalnessPassed: true,
      identity: { encoderA: { passed: true, score: 0 }, stability: 0 },
      naturalness: { score: 0 },
      processingSteps: 0,
      nativeSampleRate: 32000
    };
    baseline.identity.encoderB = { passed: pipelineFlags.dualSpeakerGate !== true, score: 0 };
    baseline.perceptual = { passed: pipelineFlags.perceptualGate !== true };
    const decision = selectVoiceCandidate(candidates, {
      qualityMode,
      baseline: qualityMode === "balanced" ? baseline : null,
      requireDualEncoder: pipelineFlags.dualSpeakerGate === true,
      requirePerceptual: pipelineFlags.perceptualGate === true
    });
    if (decision.selected.id === baseline.id) {
      return {
        buffer: sourceBuffer,
        applied: false,
        degraded: true,
        generationPath: "gpt_direct",
        attempts,
        warnings: decision.warnings,
        qualityReport: createVoiceQualityReport({
          qualityMode,
          flags: pipelineFlags,
          content: evaluateContentPolicy({ primaryAsr: { coverage: 1 }, expectedText, qualityMode }),
          identity: evaluateIdentityPolicy({ required: pipelineFlags.dualSpeakerGate === true, qualityMode }),
          perceptual: evaluatePerceptualPolicy({}, { required: pipelineFlags.perceptualGate === true, qualityMode }),
          artifacts: evaluateArtifactPolicy({}, { qualityMode })
        })
      };
    }
    const selected = decision.selected;
    return {
      buffer: selected.buffer,
      applied: true,
      degraded: false,
      generationPath: "seed_full_conversion",
      attempts,
      warnings: [],
      qualityReport: selected.qualityReport,
      metrics: selected.identityMetrics || {},
      waveformHealth: selected.validation?.waveformHealth || {},
      preset: selected.preset
    };
  } finally {
    await resourceLease?.release?.().catch(() => {});
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function candidatePassedForVoicePipeline(candidate, flags = {}) {
  return candidate?.contentPassed === true
    && candidate?.artifactPassed === true
    && candidate?.naturalnessPassed === true
    && candidate?.identity?.encoderA?.passed === true
    && (flags.dualSpeakerGate !== true || candidate?.identity?.encoderB?.passed === true)
    && (flags.perceptualGate !== true || candidate?.perceptual?.passed === true);
}

async function synthesizeGptSoVitsSpeech({
  text,
  language,
  profile,
  settings = {},
  parsedSegments = [],
  onProgress = null,
  signal = null,
  acquireSeedVcResources = null
}) {
  await assertVoiceNeuralEngineReady(gptSoVitsEngineId);
  await assertVoicePreparationReady();
  if (profile.voiceModel?.engine !== gptSoVitsEngineId || !profile.voiceModel?.modelPath) {
    throw new Error("Rebuild this Target Voice Profile with the GPT-SoVITS local engine first.");
  }
  const cleanText = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleanText) {
    throw new Error("Enter text to generate.");
  }
  // Protect repeated Chinese tokens in the actual GPT clause text. The three
  // deterministic GPT candidates rotate only the boundary punctuation; the
  // evaluator always receives the original text so the repeated-token gate
  // remains authoritative rather than validating the transformed text.
  const spokenText = voiceSynthesisClausePlan(cleanText, parsedSegments)
    .map((clause) => clause.text)
    .join(" ")
    .trim();
  const effectiveLanguage = resolveVoiceLanguage({
    requestedLanguage: language,
    profileLanguage: profile.language || profile.voiceModel?.language,
    text: cleanText
  });
  const promptLanguage = normalizeTranscriptLanguage(profile.voiceModel.promptLanguage, profile.language);
  const promptText = normalizeVoiceTranscript(profile.voiceModel.promptText);
  if (!promptText || !profile.voiceModel.referenceAudioPath) {
    throw new Error("This GPT-SoVITS profile is missing prompt audio or transcript. Rebuild it after adding a transcript to the reference sample.");
  }
  const requestedSeed = Number(settings.seed);
  const fineProfile = String(profile.qualityMode || profile.voiceModel?.qualityMode || "").toLowerCase() === "fine";
  const requestedQualityMode = settings.qualityMode || settings.generationQualityMode;
  const qualityMode = requestedQualityMode ? normalizeVoiceQualityMode(requestedQualityMode) : "balanced";
  const pipelineFlags = voiceCloneFeatureFlags(process.env);
  const usePipelineV2 = pipelineFlags.pipelineV2 && Boolean(requestedQualityMode);
  const fixtureCandidateIndex = usePipelineV2
    && settings.voiceGoldenFixture === true
    && Number.isInteger(Number(settings.gptCandidateFixtureIndex))
    && Number(settings.gptCandidateFixtureIndex) >= 0
    && Number(settings.gptCandidateFixtureIndex) <= 2
    ? Math.round(Number(settings.gptCandidateFixtureIndex))
    : null;
  const candidateIndices = fixtureCandidateIndex === null
    ? Array.from({
      length: usePipelineV2 && !settings.conversationMode && fineProfile
        ? Math.max(2, Math.min(3, Math.round(Number(settings.gptCandidateCount) || 3)))
        : 1
    }, (_, index) => index)
    : [fixtureCandidateIndex];
  const gptCandidateCount = candidateIndices.length;
  const tempDir = path.join(os.tmpdir(), makeVoiceId("voice-gpt-sovits-tts"));
  try {
    await fs.mkdir(tempDir, { recursive: true });
    throwIfVoiceAbortSignalAborted(signal);
    const baseCandidates = [];
    const baseCandidateFailures = [];
    for (const candidateIndex of candidateIndices) {
      throwIfVoiceAbortSignalAborted(signal);
      const candidateId = `gpt-base-${candidateIndex + 1}`;
      const repetitionBoundary = ["，", "、", "。"][candidateIndex % 3];
      const candidateGenerationText = stabilizeRepeatedChineseTokens(
        normalizeVoiceGenerationText(cleanText),
        repetitionBoundary
      );
      const candidateGenerationSegments = (Array.isArray(parsedSegments) ? parsedSegments : [])
        .map((segment) => ({
          ...segment,
          text: stabilizeRepeatedChineseTokens(
            normalizeVoiceGenerationText(segment?.text || ""),
            repetitionBoundary
          )
        }));
      const candidateSeed = Number.isFinite(requestedSeed) && requestedSeed >= 0
        ? Math.round(requestedSeed) + candidateIndex * 997
        : 9071 + candidateIndex * 997;
      const candidateTempDir = path.join(tempDir, candidateId);
      try {
        const candidateSynthesis = await synthesizeValidatedVoiceClauses({
          engine: gptSoVitsEngineId,
          cleanText: candidateGenerationText,
          effectiveLanguage,
          parsedSegments: candidateGenerationSegments,
          referenceAudioPath: voiceModelReferenceAudioPath(profile.voiceModel),
          baselineAudioPaths: voiceModelValidationBaselineAudioPaths(profile),
          settings,
          tempDir: candidateTempDir,
          signal,
          settingsForAttempt: ({ attempt }) => ({
            ...settings,
            seed: candidateSeed + (Number.isFinite(requestedSeed) && requestedSeed >= 0 ? attempt : attempt * 97),
            sentenceSafeSynthesis: true,
            recoverMultilingualSemantics: !settings.conversationMode,
            // The first pass remains one render per clause. Recovery passes split
            // failed Chinese clauses at soft punctuation (then to an 18-unit cap),
            // and get one local retry so one weak sub-clause cannot abort the outer
            // integrity controller before the shorter recovery plan is evaluated.
            sentenceMaxAttempts: settings.conversationMode ? (attempt >= 3 ? 3 : 2) : (attempt === 1 ? 1 : 2),
            temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0.85,
            repetitionPenalty: Number.isFinite(Number(settings.repetitionPenalty)) ? Number(settings.repetitionPenalty) : 1.35,
            integrityAttempt: attempt
          }),
          makeBatchRequest: ({ clauses, settings: attemptSettings }) => ({
            action: "tts-batch",
            profileId: profile.id,
            language: effectiveLanguage,
            requestedLanguage: normalizeVoiceLanguage(language),
            profileLanguage: normalizeVoiceLanguage(profile.language || profile.voiceModel?.language),
            text: candidateGenerationText,
            textLang: effectiveLanguage,
            promptText,
            promptLang: promptLanguage,
            refAudioPath: profile.voiceModel.referenceAudioPath,
            segments: candidateGenerationSegments,
            clauses,
            voiceModel: profile.voiceModel,
            settings: attemptSettings
          })
        });
        const integrity = candidateSynthesis.synthesisIntegrity || {};
        const waveformHealth = integrity.waveformHealth || {};
        const retryCount = (integrity.attempts || []).filter((attempt) => Number(attempt?.attempt) > 1).length;
        baseCandidates.push({
          id: candidateId,
          seed: candidateSeed,
          repetitionBoundary,
          synthesis: candidateSynthesis,
          score: [
            Number(integrity.final?.strictValidationAccepted === true),
            Number(integrity.coverage) || 0,
            Number(waveformHealth.activity) || 0,
            -(Number(waveformHealth.lineHumRatio) || 0),
            Number(waveformHealth.modulationScore) || 0,
            -retryCount
          ],
          retryCount
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        baseCandidateFailures.push({
          id: candidateId,
          seed: candidateSeed,
          code: sanitizeUnicodeText(error?.code || "gpt_base_candidate_failed"),
          message: sanitizeUnicodeText(error?.message || "GPT base candidate failed")
        });
      }
    }
    if (!baseCandidates.length) {
      const failure = baseCandidateFailures[0];
      throw new Error(failure?.message || "GPT-SoVITS did not return a validated base candidate.");
    }
    const clauseSelection = selectBestTtsClauses(baseCandidates, isVoiceSynthesisStrictlyAccepted);
    if (clauseSelection) {
      const assembledPath = path.join(tempDir, "gpt-assembled.wav");
      const acceptedClauses = clauseSelection.map(item => item.clause);
      await concatenateVoiceSynthesisWavs(acceptedClauses.map(item => item.audioPath), assembledPath, signal, cleanText.length > 48 ? 120 : 0);
      const waveform = await validateVoiceSynthesisWaveformCandidate({
        audioPath: assembledPath, expectedText: cleanText, language: effectiveLanguage,
        referenceAudioPath: voiceModelReferenceAudioPath(profile.voiceModel),
        baselineAudioPaths: voiceModelValidationBaselineAudioPaths(profile), settings, signal
      });
      const integrity = combineVoiceClauseIntegrity(acceptedClauses, waveform);
      const strict = isVoiceSynthesisStrictlyAccepted(integrity);
      if (strict || isVoiceSynthesisAmplitudeAdvisory(integrity) || isVoiceSynthesisCoverageAdvisory(integrity)) {
        baseCandidates.push({
          id: "gpt-assembled", seed: null, retryCount: 0,
          synthesis: {
            buffer: await fs.readFile(assembledPath), acceptedClauses, warnings: [],
            synthesisIntegrity: {
              ...integrity,
              clauseSources: clauseSelection.map(item => ({ index: item.clause.index, sourceCandidateId: item.sourceCandidateId })),
              attempts: [],
              final: { ...integrity, strictValidationAccepted: strict }
            }
          },
          score: [Number(strict), integrity.coverage, waveform.waveformHealth?.activity || 0,
            -(waveform.waveformHealth?.lineHumRatio || 0), waveform.waveformHealth?.modulationScore || 0, 0]
        });
      }
    }
    baseCandidates.sort((left, right) => {
      const leftStrictClauses = left.synthesis.acceptedClauses.filter(item => isVoiceSynthesisStrictlyAccepted(item.validation) && (!item.validation.secondaryAsr || item.validation.secondaryAsr.coverage >= 0.92)).length;
      const rightStrictClauses = right.synthesis.acceptedClauses.filter(item => isVoiceSynthesisStrictlyAccepted(item.validation) && (!item.validation.secondaryAsr || item.validation.secondaryAsr.coverage >= 0.92)).length;
      if (leftStrictClauses !== rightStrictClauses) return rightStrictClauses - leftStrictClauses;
      for (let index = 0; index < left.score.length; index += 1) {
        if (left.score[index] !== right.score[index]) return right.score[index] - left.score[index];
      }
      return left.id.localeCompare(right.id);
    });
    let selectedBaseCandidate = baseCandidates[0];
    let synthesis = selectedBaseCandidate.synthesis;
    const gptSoVitsRequest = {
      textLang: effectiveLanguage,
      promptLang: promptLanguage,
      candidateCount: baseCandidates.length + baseCandidateFailures.length,
      generatedCandidateCount: gptCandidateCount,
      assembledCandidateCount: baseCandidates.filter(candidate => candidate.id === "gpt-assembled").length,
      selectedCandidateId: selectedBaseCandidate.id,
      selectedCandidateSeed: selectedBaseCandidate.seed,
      candidates: [
        ...baseCandidates.map((candidate) => ({
          id: candidate.id,
          seed: candidate.seed,
          repetitionBoundary: candidate.repetitionBoundary || "",
          selected: candidate.id === selectedBaseCandidate.id,
          strictValidationAccepted: candidate.synthesis.synthesisIntegrity?.final?.strictValidationAccepted === true,
          coverage: Number(candidate.synthesis.synthesisIntegrity?.coverage) || 0,
          retryCount: candidate.retryCount
        })),
        ...baseCandidateFailures.map((candidate) => ({ ...candidate, selected: false }))
      ]
    };
    let result = synthesis.acceptedClauses[0]?.candidate || {};
    let buffer = synthesis.buffer;
    const synthesisWarnings = [...synthesis.warnings];
    let qualityReport = null;
    const generatedCandidates = synthesis.acceptedClauses.map((item) => item.candidate || {});
    gptSoVitsRequest.sentenceCount = generatedCandidates.reduce((total, candidate) => total + (Number(candidate.sentenceCount) || 1), 0);
    const retryCount = generatedCandidates.reduce((total, candidate) => total + (Number(candidate.retryCount) || 0), 0);
    if (retryCount > 0) {
      gptSoVitsRequest.retryCount = retryCount;
    }
    gptSoVitsRequest.integrity = synthesis.synthesisIntegrity;
    const similarityStrength = Math.max(0, Math.min(1, Number(settings.similarityStrength) || 0));
    const refinementMode = sanitizeUnicodeText(settings.refinementMode || "auto").toLowerCase();
    if (usePipelineV2 && !settings.conversationMode && fineProfile && settings.disableRefinement !== true) {
      const sourcePath = path.join(tempDir, "pipeline-v2-source.wav");
      await fs.writeFile(sourcePath, buffer);
      let sourceDurationSeconds = parseWavInfo(buffer).durationSeconds;
      const targetReference = await buildSeedSongTargetReference({
        profile,
        fallbackReferenceAudioPath: voiceModelReferenceAudioPath(profile.voiceModel),
        workingDir: tempDir,
        signal
      });
      if (pipelineFlags.referenceStrict && targetReference.strategy === "single-version-reference" && qualityMode === "strict") {
        const error = new Error("Seed-VC Pipeline V2 requires a complete multi-reference pack; the available reference degraded to a single clip.");
        error.code = voiceCloneErrorCodes.referencePackIncomplete;
        throw error;
      }
      const baseAudioCandidates = baseCandidates.map((candidate) => ({
        id: candidate.id,
        audioPath: path.join(tempDir, `${candidate.id}-joined.wav`),
        buffer: candidate.synthesis.buffer,
        validation: candidate.synthesis.synthesisIntegrity || {}
      }));
      for (const candidate of baseAudioCandidates) {
        await fs.writeFile(candidate.audioPath, candidate.buffer);
      }
      const identityReferenceAudioPaths = voiceProfileIdentityEvaluationAudioPaths(profile);
      const identityEvaluationPaths = identityReferenceAudioPaths.length
        ? identityReferenceAudioPaths
        : targetReference.validationAudioPaths;
      const identifiedBaseCandidates = await analyzeSeedSpeechIdentityCandidates({
        sourceAudioPath: sourcePath,
        candidates: baseAudioCandidates,
        targetReferenceAudioPath: targetReference.audioPath,
        targetReferenceAudioPaths: identityEvaluationPaths,
        settings: { ...settings, convertStyle: false },
        signal
      });
      const evaluatedBaseCandidates = await evaluateSeedSpeechQualityCandidates({
        candidates: identifiedBaseCandidates,
        targetReferenceAudioPath: targetReference.audioPath,
        targetReferenceAudioPaths: identityEvaluationPaths,
        signal
      });
      const basePolicies = evaluatedBaseCandidates.map((candidate) => buildPipelineV2PolicyCandidate({
        candidate,
        expectedText: spokenText,
        profile,
        pipelineFlags,
        qualityMode,
        processingSteps: 0,
        durationMs: 0
      }));
      gptSoVitsRequest.baseQualityCandidates = basePolicies.map((candidate) => ({
        id: candidate.id,
        contentPassed: candidate.contentPassed,
        artifactPassed: candidate.artifactPassed,
        identityPassed: candidate.identity?.encoderA?.passed === true,
        encoderBPassed: candidate.identity?.encoderB?.passed === true,
        perceptualAvailable: candidate.perceptual?.available === true,
        perceptualScore: Number.isFinite(Number(candidate.perceptual?.utmos)) ? Number(candidate.perceptual.utmos) : null,
        qualityDecision: candidate.qualityReport?.decision || {},
        evaluatorVersions: candidate.qualityReport?.evaluatorVersions || {}
      }));
      const directCandidates = basePolicies
        .filter((candidate) => candidatePassedForVoicePipeline(candidate, pipelineFlags))
        .sort((left, right) => (
          Math.min(Number(right.identity?.encoderA?.score || 0), Number(right.identity?.encoderB?.score || 0))
            - Math.min(Number(left.identity?.encoderA?.score || 0), Number(left.identity?.encoderB?.score || 0))
          || Number(right.perceptual?.utmos || 0) - Number(left.perceptual?.utmos || 0)
          || Number(right.identity?.encoderA?.score || 0) - Number(left.identity?.encoderA?.score || 0)
        ));
      const directCandidate = directCandidates[0] || null;
      if (directCandidate) {
        selectedBaseCandidate = baseCandidates.find((candidate) => candidate.id === directCandidate.id) || selectedBaseCandidate;
        synthesis = selectedBaseCandidate.synthesis;
        result = synthesis.acceptedClauses[0]?.candidate || result;
        buffer = directCandidate.buffer;
        gptSoVitsRequest.integrity = synthesis.synthesisIntegrity;
        qualityReport = directCandidate.qualityReport;
        gptSoVitsRequest.selectedCandidateId = selectedBaseCandidate.id;
        gptSoVitsRequest.selectedCandidateSeed = selectedBaseCandidate.seed;
        gptSoVitsRequest.candidates = gptSoVitsRequest.candidates.map((candidate) => ({
          ...candidate,
          selected: candidate.id === selectedBaseCandidate.id
        }));
        gptSoVitsRequest.refinement = {
          applied: false,
          engine: seedVcEngineId,
          resultType: "gpt_direct",
          similarityStrength,
          targetReferenceStrategy: targetReference.strategy,
          targetReferenceClipCount: targetReference.clipCount,
          targetReferenceDurationSeconds: targetReference.durationSeconds,
          attempts: [],
          waveformHealth: directCandidate.validation?.waveformHealth || {},
          metrics: directCandidate.identityMetrics || {},
          reason: "base_candidate_passed_all_pipeline_gates"
        };
        synthesisWarnings.push("Pipeline V2 selected a validated GPT-SoVITS candidate directly; Seed-VC refinement was not needed.");
      } else if (refinementMode !== "gpt_direct_only") {
        // Prefer the strongest weaker encoder among safe base candidates as
        // the Seed source. Selecting only by activity/retry score can send an
        // identity-weak GPT candidate into the expensive refinement path even
        // when another generated candidate is closer to the calibrated target.
        const refinementSourcePolicy = [...basePolicies]
          .filter((candidate) => candidate.contentPassed === true && candidate.artifactPassed === true)
          .sort((left, right) => (
            // GPT-SoVITS candidate 3 is the deterministic recovery path that
            // has been most stable across the pinned Ameath2 calibration
            // set. Prefer it when it is content/artifact-safe, then use the
            // evaluator coverage and identity metrics as tie-breakers. This
            // prevents a merely higher ASR score from selecting a source that
            // consistently produces a weaker Seed-VC target identity.
            Number(right.id === "gpt-base-3") - Number(left.id === "gpt-base-3")
            || Number(right.validation?.secondaryAsr?.coverage || 0)
              - Number(left.validation?.secondaryAsr?.coverage || 0)
            || Number(right.validation?.coverage || 0) - Number(left.validation?.coverage || 0)
            || Math.min(Number(right.identity?.encoderA?.score || 0), Number(right.identity?.encoderB?.score || 0))
              - Math.min(Number(left.identity?.encoderA?.score || 0), Number(left.identity?.encoderB?.score || 0))
            || Number(right.identity?.encoderB?.score || 0) - Number(left.identity?.encoderB?.score || 0)
            || Number(right.identity?.encoderA?.score || 0) - Number(left.identity?.encoderA?.score || 0)
            || Number(right.perceptual?.utmos || 0) - Number(left.perceptual?.utmos || 0)
          ))[0];
        if (refinementSourcePolicy) {
          selectedBaseCandidate = baseCandidates.find((candidate) => candidate.id === refinementSourcePolicy.id) || selectedBaseCandidate;
          synthesis = selectedBaseCandidate.synthesis;
          result = synthesis.acceptedClauses[0]?.candidate || result;
          buffer = refinementSourcePolicy.buffer;
          await fs.writeFile(sourcePath, buffer);
          sourceDurationSeconds = parseWavInfo(buffer).durationSeconds;
          gptSoVitsRequest.integrity = synthesis.synthesisIntegrity;
          gptSoVitsRequest.selectedCandidateId = selectedBaseCandidate.id;
          gptSoVitsRequest.selectedCandidateSeed = selectedBaseCandidate.seed;
          gptSoVitsRequest.candidates = gptSoVitsRequest.candidates.map((candidate) => ({
            ...candidate,
            selected: candidate.id === selectedBaseCandidate.id
          }));
        }
        const refined = await refineGptCandidateWithSeedPipelineV2({
          sourceBuffer: buffer,
          sourceAudioPath: sourcePath,
          sourceDurationSeconds,
          sourceClauseAudioPaths: synthesis.acceptedClauses
            .map((item) => String(item?.audioPath || ""))
            .filter(Boolean),
          sourceClauseTexts: synthesis.acceptedClauses
            .map((item) => String(item?.text || ""))
            .filter(Boolean),
          expectedText: spokenText,
          effectiveLanguage,
          profile,
          targetReference,
          settings,
          qualityMode,
          onProgress,
          signal,
          acquireSeedVcResources
        });
        if (refined.applied) buffer = refined.buffer;
        qualityReport = refined.qualityReport || null;
        if (!refined.applied && qualityMode === "strict") {
          const error = new Error("Pipeline V2 could not produce a candidate that passed identity, content, and artifact gates. No degraded GPT-only output was saved.");
          error.code = voiceCloneErrorCodes.candidateRejected;
          error.details = { attempts: refined.attempts, qualityReport };
          throw error;
        }
        gptSoVitsRequest.refinement = {
          applied: refined.applied === true,
          engine: seedVcEngineId,
          resultType: refined.applied ? "full_conversion" : "gpt_direct_fallback",
          similarityStrength,
          targetReferenceStrategy: targetReference.strategy,
          targetReferenceClipCount: targetReference.clipCount,
          targetReferenceDurationSeconds: targetReference.durationSeconds,
          attempts: refined.attempts,
          waveformHealth: refined.waveformHealth || {},
          ...(refined.metrics || {}),
          reason: refined.applied ? "" : "no_safe_identity_improvement"
        };
        synthesisWarnings.push(...(refined.warnings || []));
      } else {
        const failedDirect = basePolicies[0] || null;
        qualityReport = failedDirect?.qualityReport || null;
        gptSoVitsRequest.refinement = {
          applied: false,
          engine: seedVcEngineId,
          resultType: "gpt_direct_fallback",
          similarityStrength,
          targetReferenceStrategy: targetReference.strategy,
          targetReferenceClipCount: targetReference.clipCount,
          targetReferenceDurationSeconds: targetReference.durationSeconds,
          attempts: [],
          waveformHealth: failedDirect?.validation?.waveformHealth || {},
          reason: "gpt_direct_only_candidate_failed_pipeline_gates"
        };
      }
      if (qualityMode === "strict" && qualityReport?.decision?.accepted !== true) {
        const error = new Error("GPT-SoVITS direct candidate did not pass the Pipeline V2 quality gates. No degraded output was saved.");
        error.code = voiceCloneErrorCodes.candidateRejected;
        error.details = { qualityReport, gptSoVitsRequest };
        throw error;
      }
      if (targetReference.strategy === "single-version-reference") {
        synthesisWarnings.push("Pipeline V2 used a degraded single-reference pack; the output is not eligible for model promotion.");
      }
    } else if ((!pipelineFlags.pipelineV2 || !requestedQualityMode) && !settings.conversationMode && fineProfile && similarityStrength >= 0.5) {
      const sourcePath = path.join(tempDir, "speaker-refinement-source.wav");
      let refinementAttemptCount = 0;
      const refinementAttempts = [];
      let resourceLease = null;
      try {
        if (typeof acquireSeedVcResources === "function") {
          try {
            resourceLease = await acquireSeedVcResources({ profile, signal });
          } catch (error) {
            throw voiceRefinementStageError(error, "resource-acquisition", { durationMs: 0 });
          }
        }
        await fs.writeFile(sourcePath, buffer);
        const sourceDurationSeconds = parseWavInfo(buffer).durationSeconds;
        const targetReference = await buildSeedSongTargetReference({
          profile,
          fallbackReferenceAudioPath: voiceModelReferenceAudioPath(profile.voiceModel),
          workingDir: tempDir,
          signal
        });
        let refined = null;
        let safeRefined = null;
        let lastRefinementError = null;
        for (let refinementAttempt = 1; refinementAttempt <= 2; refinementAttempt += 1) {
          refinementAttemptCount = refinementAttempt;
          const attemptStartedAt = Date.now();
          try {
            const conversionPreset = refinementAttempt === 1
              ? { diffusionSteps: 50, inferenceCfgRate: 0.5, chunkCrossfadeMs: 750 }
              : { diffusionSteps: 30, inferenceCfgRate: 0.45, chunkCrossfadeMs: 500 };
            refined = await convertSeedVcSpeech({
              sourceAudioPath: sourcePath,
              sourceDurationSeconds,
              targetReferenceAudioPath: targetReference.audioPath,
              settings: {
                preserveEmotion: true,
                pitchShift: 0,
                ...conversionPreset,
                diagnosticFixture: sanitizeUnicodeText(settings.refinementFailureFixture || "").slice(0, 80)
              },
              targetBlendRatio: 0,
              onProgress: (event) => onProgress?.({
                progress: Math.max(82, Math.min(96, 82 + Math.round((Number(event.progress) || 0) * 0.14))),
                message: refinementAttempt === 1
                  ? "Refining speaker identity with a coverage-safe Seed-VC blend"
                  : "Retrying speaker identity refinement with a fresh Seed-VC pass"
              }),
              signal
            });
            safeRefined = await selectCoverageSafeSeedVoiceBlend({
              sourceAudioPath: sourcePath,
              convertedBuffer: refined.buffer,
              language: effectiveLanguage,
              expectedText: spokenText,
              referenceAudioPath: voiceModelReferenceAudioPath(profile.voiceModel),
              targetReferenceAudioPaths: targetReference.validationAudioPaths,
              baselineAudioPaths: voiceModelValidationBaselineAudioPaths(profile),
              settings: settings.refinementRetryFixture === "fail-first" && refinementAttempt === 1
                ? { ...settings, integrityFixture: "missing", enforceSpectralQuality: true }
                : { ...settings, enforceSpectralQuality: true },
              maxTargetBlendRatio: 1,
              allowSourceDominantCoverageRecovery: refinementAttempt >= 2,
              signal
            });
            refinementAttempts.push({
              attempt: refinementAttempt,
              accepted: true,
              stage: "completed",
              code: "",
              message: "",
              durationMs: Date.now() - attemptStartedAt,
              diffusionSteps: conversionPreset.diffusionSteps,
              inferenceCfgRate: conversionPreset.inferenceCfgRate,
              chunkCrossfadeMs: conversionPreset.chunkCrossfadeMs,
              targetBlendRatio: safeRefined.targetBlendRatio,
              coverage: Number(safeRefined.coverage) || 0,
              targetSimilarity: Number(safeRefined.targetSimilarity) || 0,
              identityGain: Number(safeRefined.identityGain) || 0
            });
            break;
          } catch (error) {
            if (signal?.aborted) {
              throw error;
            }
            const diagnostic = error.voiceRefinementDiagnostic || {
              ...classifyVoiceRefinementFailure(error),
              stage: "unknown",
              durationMs: Date.now() - attemptStartedAt
            };
            refinementAttempts.push({
              attempt: refinementAttempt,
              accepted: false,
              ...diagnostic,
              durationMs: Number(diagnostic.durationMs) || Date.now() - attemptStartedAt
            });
            refined = null;
            safeRefined = null;
            lastRefinementError = error;
          }
        }
        if (!refined || !safeRefined) {
          throw lastRefinementError || new Error("Speaker refinement did not produce a coverage-safe candidate.");
        }
        const refinedStrictlyAccepted = safeRefined.strictValidationAccepted === true;
        const refinedAmplitudeAdvisory = safeRefined.advisoryAmplitudeWarning === true;
        const refinedCoverageAdvisory = safeRefined.advisoryCoverageWarning === true;
        if (refinedStrictlyAccepted || refinedAmplitudeAdvisory || refinedCoverageAdvisory) {
          buffer = safeRefined.buffer;
          gptSoVitsRequest.refinement = {
            applied: true,
            engine: seedVcEngineId,
            strategy: refined.conversionStrategy,
            similarityStrength,
            attemptCount: refinementAttemptCount,
            targetBlendRatio: safeRefined.targetBlendRatio,
            coverage: Number(safeRefined.coverage) || 0,
            identityValidationAccepted: safeRefined.identityValidationAccepted === true,
            sourceTargetSimilarity: Number(safeRefined.sourceTargetSimilarity) || 0,
            targetSimilarity: Number(safeRefined.targetSimilarity) || 0,
            targetSimilarityFloor: Number(safeRefined.targetSimilarityFloor) || 0,
            identityGain: Number(safeRefined.identityGain) || 0,
            targetReferenceStrategy: targetReference.strategy,
            targetReferenceClipCount: targetReference.clipCount,
            targetReferenceDurationSeconds: targetReference.durationSeconds,
            strictValidationAccepted: refinedStrictlyAccepted,
            advisoryAmplitudeWarning: refinedAmplitudeAdvisory,
            advisoryCoverageWarning: refinedCoverageAdvisory,
            waveformHealth: safeRefined.waveformHealth || {},
            attempts: refinementAttempts,
            resourceCoordination: resourceLease?.diagnostics || {}
          };
          if (refinementAttemptCount > 1) {
            synthesisWarnings.push("Speaker refinement recovered on a fresh Seed-VC retry after the first pass failed validation.");
          }
          synthesisWarnings.push(refinedCoverageAdvisory
            ? "Fine TTV used a source-dominant Seed-VC blend after whole-file ASR remained uncertain; hard waveform and excess-text checks still passed."
            : "Fine TTV selected the strongest validated Seed-VC target tone while preserving every recognized word.");
        } else {
          gptSoVitsRequest.refinement = {
            applied: false,
            engine: seedVcEngineId,
            similarityStrength,
            attemptCount: refinementAttemptCount,
            attempts: refinementAttempts,
            resourceCoordination: resourceLease?.diagnostics || {},
            reason: "speech_integrity_failed"
          };
          synthesisWarnings.push("Seed-VC speaker refinement did not pass coverage and waveform checks, so the validated GPT-SoVITS audio was preserved.");
        }
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        gptSoVitsRequest.refinement = {
          applied: false,
          engine: seedVcEngineId,
          similarityStrength,
          attemptCount: refinementAttemptCount,
          attempts: refinementAttempts,
          resourceCoordination: resourceLease?.diagnostics || {},
          reason: "speaker_refinement_failed"
        };
        if (settings.allowUnrefinedFineFallback === true) {
          synthesisWarnings.push("Seed-VC speaker refinement was unavailable, so the validated GPT-SoVITS audio was preserved as an explicitly requested degraded fallback.");
        } else {
          const lastDiagnostic = refinementAttempts.at(-1) || error.voiceRefinementDiagnostic || classifyVoiceRefinementFailure(error);
          const failure = new Error(
            `Fine voice speaker refinement failed after ${Math.max(1, refinementAttemptCount)} attempts `
            + `(${sanitizeUnicodeText(lastDiagnostic.code || "speaker_refinement_failed")}). No unrefined output was saved.`
          );
          failure.voiceJobDiagnostics = {
            speakerRefinement: {
              accepted: false,
              fallbackSaved: false,
              attemptCount: refinementAttemptCount,
              attempts: refinementAttempts,
              resourceCoordination: resourceLease?.diagnostics || {}
            }
          };
          throw failure;
        }
      } finally {
        await resourceLease?.release?.().catch((error) => {
          warnDiagnostic(`Seed-VC resource restoration failed: ${sanitizeUnicodeText(error.message || error)}`);
        });
      }
    }
    let durationSeconds = Number(result.durationSeconds) || 0;
    try {
      durationSeconds = parseWavInfo(buffer).durationSeconds;
    } catch {
      durationSeconds = durationSeconds || Math.max(1.2, Math.min(25, cleanText.length / 12));
    }
    if (!qualityReport) {
      const flags = voiceCloneFeatureFlags(process.env);
      qualityReport = createVoiceQualityReport({
        qualityMode,
        flags,
        content: evaluateContentPolicy({
          primaryAsr: {
            coverage: Number(synthesis.synthesisIntegrity?.coverage) || 0,
            rawCoverage: synthesis.synthesisIntegrity?.primaryAsrRawCoverage,
            expectedTokenCount: synthesis.synthesisIntegrity?.expectedTokenCount,
            observedTokenCount: synthesis.synthesisIntegrity?.observedTokenCount,
            secondaryAuthoritative: synthesis.synthesisIntegrity?.secondaryAsrAuthoritative === true
              || synthesis.synthesisIntegrity?.mixedScriptSecondaryAuthoritative === true
          },
          secondaryAsr: synthesis.synthesisIntegrity?.secondaryAsr || null,
          expectedText: spokenText,
          forcedAlignmentPass: synthesis.synthesisIntegrity?.forcedAlignmentPass === true,
          requiredSecondary: flags.secondaryAsr === true,
          qualityMode
        }),
        identity: evaluateIdentityPolicy({ required: flags.dualSpeakerGate === true, qualityMode }),
        perceptual: evaluatePerceptualPolicy({}, { required: flags.perceptualGate === true, qualityMode }),
        artifacts: evaluateArtifactPolicy(synthesis.synthesisIntegrity?.waveformHealth, { qualityMode })
      });
    }
    if (qualityMode === "strict" && qualityReport?.decision?.accepted !== true) {
      const error = new Error("Voice candidate did not pass the Strict content, identity, naturalness, and artifact gates. No degraded output was saved.");
      error.code = voiceCloneErrorCodes.candidateRejected;
      error.details = { qualityReport, gptSoVitsRequest };
      throw error;
    }
    return {
      buffer,
      durationSeconds,
      engine: result.engine || gptSoVitsEngineId,
      modelVersion: result.modelVersion || gptSoVitsModelVersion,
      language: result.language || effectiveLanguage,
      warnings: Array.from(new Set(synthesisWarnings)),
      pipeline: gptSoVitsRequest.refinement?.resultType === "full_conversion"
        ? "pipeline_v2"
        : (requestedQualityMode ? "pipeline_v2" : "legacy"),
      generationPath: gptSoVitsRequest.refinement?.resultType === "full_conversion"
        ? "seed_full_conversion"
        : gptSoVitsRequest.refinement?.applied ? "legacy_refinement" : "gpt_direct",
      eligibleForPromotion: gptSoVitsRequest.refinement?.resultType === "full_conversion"
        ? gptSoVitsRequest.refinement?.applied === true
        : true,
      qualityReport,
      synthesisIntegrity: gptSoVitsRequest.integrity,
      gptSoVitsRequest
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function synthesizeVoiceSpeech(options) {
  const engine = normalizeVoiceEngine(options.profile?.voiceModel?.engine || options.profile?.engine, { language: options.profile?.language });
  if (engine === gptSoVitsEngineId) {
    return synthesizeGptSoVitsSpeech(options);
  }
  return synthesizeOpenVoiceSpeech(options);
}

async function convertOpenVoiceSpeech({ sourceAudioPath, sourceDurationSeconds, language, profile, settings = {}, signal = null }) {
  await assertVoiceNeuralEngineReady(voiceNeuralEngineId);
  throwIfVoiceAbortSignalAborted(signal);
  if (profile.voiceModel?.engine !== voiceNeuralEngineId || !profile.voiceModel?.modelPath) {
    throw new Error("Rebuild this Target Voice Profile with the OpenVoice V2 local neural engine first.");
  }
  const effectiveLanguage = resolveVoiceLanguage({
    requestedLanguage: language,
    profileLanguage: profile.language || profile.voiceModel?.language
  });
  const tempDir = path.join(os.tmpdir(), makeVoiceId("voice-openvoice-v2v"));
  const normalizedSourcePath = path.join(tempDir, "source.wav");
  const outputPath = path.join(tempDir, "output.wav");
  try {
    await fs.mkdir(tempDir, { recursive: true });
    await normalizeVoiceAudioFile({
      inputPath: sourceAudioPath,
      outputPath: normalizedSourcePath,
      sampleRate: 24000
    });
    throwIfVoiceAbortSignalAborted(signal);
    const result = await callVoiceEngineWorker({
      action: "v2v",
      profileId: profile.id,
      language: effectiveLanguage,
      requestedLanguage: normalizeVoiceLanguage(language),
      profileLanguage: normalizeVoiceLanguage(profile.language || profile.voiceModel?.language),
      sourceAudioPath: normalizedSourcePath,
      durationSeconds: sourceDurationSeconds,
      voiceModel: profile.voiceModel,
      outputPath,
      settings
    }, { engine: voiceNeuralEngineId, signal });
    throwIfVoiceAbortSignalAborted(signal);
    const buffer = await fs.readFile(result.outputPath || outputPath);
    let durationSeconds = Number(result.durationSeconds) || Number(sourceDurationSeconds) || 0;
    try {
      durationSeconds = parseWavInfo(buffer).durationSeconds;
    } catch {
      durationSeconds = durationSeconds || 2;
    }
    return {
      buffer,
      durationSeconds,
      engine: voiceNeuralEngineId,
      modelVersion: result.modelVersion || profile.voiceModel?.modelVersion || voiceNeuralModelVersion,
      language: normalizeVoiceLanguage(result.language || effectiveLanguage, { allowAuto: false }),
      warnings: Array.isArray(result.warnings) ? result.warnings : []
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function convertSeedVcSpeech({
  sourceAudioPath,
  sourceDurationSeconds,
  targetReferenceAudioPath,
  settings = {},
  targetBlendRatio = 0,
  onProgress = null,
  signal = null
}) {
  await assertSeedVcEngineReady();
  if (!targetReferenceAudioPath || !await pathExists(targetReferenceAudioPath)) {
    throw new Error("The selected target voice version does not have readable reference audio for Seed-VC.");
  }
  const tempDir = path.join(os.tmpdir(), makeVoiceId("voice-seed-vc-v2v"));
  const outputPath = path.join(tempDir, "output.wav");
  const normalizedOutputPath = path.join(tempDir, "output-pcm.wav");
  const blendedOutputPath = path.join(tempDir, "output-blended.wav");
  const targetSampleRate = Math.round(Number(settings.nativeSampleRate || settings.outputSampleRate || settings.targetSampleRate)
    || VTV_SPEECH_SAMPLE_RATE);
  const startedAt = Date.now();
  try {
    await fs.mkdir(tempDir, { recursive: true });
    let result;
    try {
      result = await callSeedVcWorkerSerialized({
        action: "v2v",
        sourceAudioPath,
        targetReferenceAudioPath,
        durationSeconds: sourceDurationSeconds,
        outputPath,
        settings
      }, {
        engine: seedVcEngineId,
        timeoutMs: seedVcRequestTimeoutMs,
        onProgress,
        signal
      });
    } catch (error) {
      throw voiceRefinementStageError(error, "conversion", {
        durationMs: Date.now() - startedAt,
        device: "cuda"
      });
    }
    const resolvedOutputPath = result.outputPath || outputPath;
    // Seed-VC may emit IEEE-float WAV. Normalize to the mode's explicit
    // contract. Song VTV stays native 44.1 kHz; speech VTV keeps its 32 kHz
    // contract. Evaluator downsampling must happen in the evaluator only.
    try {
      await runFfmpegVoiceCommand([
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", resolvedOutputPath,
        "-ac", "1",
        "-ar", String(targetSampleRate),
        "-c:a", "pcm_s16le",
        normalizedOutputPath
      ], { timeoutMs: voiceEngineRequestTimeoutMs, signal });
    } catch (error) {
      throw voiceRefinementStageError(error, "normalization", {
        durationMs: Date.now() - startedAt
      });
    }
    const safeBlendRatio = Math.max(0, Math.min(0.4, Number(targetBlendRatio) || 0));
    let finalOutputPath = normalizedOutputPath;
    if (safeBlendRatio > 0) {
      const sourceRatio = Number((1 - safeBlendRatio).toFixed(3));
      const convertedRatio = Number(safeBlendRatio.toFixed(3));
      try {
        await runFfmpegVoiceCommand([
          "-y",
          "-hide_banner",
          "-loglevel", "error",
          "-i", sourceAudioPath,
          "-i", normalizedOutputPath,
          "-filter_complex", `[0:a]volume=${sourceRatio}[source];[1:a]volume=${convertedRatio}[target];[source][target]amix=inputs=2:duration=shortest:normalize=0[voice]`,
          "-map", "[voice]",
          "-ac", "1",
          "-ar", String(targetSampleRate),
          "-c:a", "pcm_s16le",
          blendedOutputPath
        ], { timeoutMs: voiceEngineRequestTimeoutMs, signal });
      } catch (error) {
        throw voiceRefinementStageError(error, "source-blend", {
          durationMs: Date.now() - startedAt,
          targetBlendRatio: safeBlendRatio
        });
      }
      finalOutputPath = blendedOutputPath;
    }
    const buffer = await fs.readFile(finalOutputPath);
    let durationSeconds = Number(result.durationSeconds) || Number(sourceDurationSeconds) || 0;
    try {
      durationSeconds = parseWavInfo(buffer).durationSeconds;
    } catch {
      durationSeconds = durationSeconds || 2;
    }
    return {
      buffer,
      durationSeconds,
      engine: seedVcEngineId,
      modelVersion: result.modelVersion || seedVcModelVersion,
      device: result.device || "",
      conversionStrategy: result.conversionStrategy || "seed-vc-zero-shot-svc-f0",
      diffusionSteps: Number(result.diffusionSteps) || 50,
      inferenceCfgRate: Number.isFinite(Number(result.inferenceCfgRate))
        ? Number(result.inferenceCfgRate)
        : Number.isFinite(Number(settings.inferenceCfgRate)) ? Number(settings.inferenceCfgRate) : 0.85,
      chunkCrossfadeMs: Number(result.chunkCrossfadeMs) || 750,
      chunkOverlapFrames: Number(result.chunkOverlapFrames) || 65,
      targetBlendRatio: safeBlendRatio,
      nativeSampleRate: targetSampleRate,
      warnings: Array.isArray(result.warnings) ? result.warnings : []
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function normalizeVoiceMixGain(value, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(1.8, Number(number.toFixed(2))));
}

function normalizeSongReplacementSettings(settings = {}) {
  const diffusionSteps = Number(settings.diffusionSteps ?? settings.diffusion_steps);
  const inferenceCfgRate = Number(settings.inferenceCfgRate ?? settings.inference_cfg_rate);
  const chunkCrossfadeMs = Number(settings.chunkCrossfadeMs ?? settings.chunk_crossfade_ms);
  const separationOverlap = Number(settings.separationOverlap ?? settings.separation_overlap);
  return {
    ...settings,
    pipelineVersion: VTV_PIPELINE_VERSION,
    mode: "song",
    qualityPreset: settings.qualityPreset || settings.presetId || "identity-first",
    candidateBudget: Math.max(1, Math.min(3, Math.round(Number(settings.candidateBudget) || 3))),
    allowNeedsReview: settings.allowNeedsReview !== false,
    nativeSampleRate: VTV_SONG_SAMPLE_RATE,
    outputFormat: "wav",
    vocalVolume: normalizeVoiceMixGain(settings.vocalVolume ?? settings.vocal_volume, 1),
    accompanimentVolume: normalizeVoiceMixGain(settings.accompanimentVolume ?? settings.accompaniment_volume, 0.9),
    diffusionSteps: Number.isFinite(diffusionSteps) ? Math.max(12, Math.min(50, Math.round(diffusionSteps))) : 50,
    inferenceCfgRate: Number.isFinite(inferenceCfgRate) ? Math.max(0, Math.min(1, Number(inferenceCfgRate.toFixed(2)))) : 0.85,
    chunkCrossfadeMs: Number.isFinite(chunkCrossfadeMs) ? Math.max(180, Math.min(1200, Math.round(chunkCrossfadeMs))) : 750,
    separationOverlap: Number.isFinite(separationOverlap) ? Math.max(0.1, Math.min(0.75, Number(separationOverlap.toFixed(2)))) : 0.5
  };
}

async function runFfmpegVoiceCommand(args, { timeoutMs = 120000, maxBuffer = 8 * 1024 * 1024, signal = null } = {}) {
  const ffmpegTool = await resolveMediaTool("ffmpeg");
  if (!ffmpegTool) {
    throw new Error("Bundled FFmpeg is required for song vocal separation and mixback.");
  }
  await execFileAsync(ffmpegTool.command, args, {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer,
    ...(signal ? { signal } : {})
  });
  return ffmpegTool;
}

function normalizeSongIntegrityResult(result) {
  if (!result || typeof result !== "object" || typeof result.accepted !== "boolean") {
    throw new Error("Song integrity analysis returned an invalid result.");
  }
  const numericMetric = (key) => {
    const value = result.metrics?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const integerMetric = (key) => {
    const value = numericMetric(key);
    return value !== null && Number.isInteger(value) && value >= 0 ? value : null;
  };
  const problemIntervals = (Array.isArray(result.problemIntervals) ? result.problemIntervals : [])
    .map((item) => ({
      startSeconds: Math.max(0, Number(item?.startSeconds) || 0),
      endSeconds: Math.max(0, Number(item?.endSeconds) || 0),
      issueSeconds: Math.max(0, Number(item?.issueSeconds) || 0)
    }))
    .filter((item) => item.endSeconds > item.startSeconds)
    .slice(0, 8);
  const reasons = (Array.isArray(result.reasons) ? result.reasons : [])
    .map((reason) => sanitizeUnicodeText(reason).slice(0, 80))
    .filter(Boolean)
    .slice(0, 8);
  const metrics = {
    sourceDurationSeconds: numericMetric("sourceDurationSeconds"),
    convertedDurationSeconds: numericMetric("convertedDurationSeconds"),
    durationDeltaPercent: numericMetric("durationDeltaPercent"),
    onsetLagMs: numericMetric("onsetLagMs"),
    sourceVoicedFrames: integerMetric("sourceVoicedFrames"),
    pairedVoicedFrames: integerMetric("pairedVoicedFrames"),
    voicedDropoutPercent: numericMetric("voicedDropoutPercent"),
    medianPitchErrorCents: numericMetric("medianPitchErrorCents"),
    pitchOver100CentsPercent: numericMetric("pitchOver100CentsPercent"),
    abruptPitchJumpCount: integerMetric("abruptPitchJumpCount"),
    abruptPitchJumpsPerMinute: numericMetric("abruptPitchJumpsPerMinute"),
    sourceTargetSimilarity: numericMetric("sourceTargetSimilarity"),
    targetSimilarity: numericMetric("targetSimilarity"),
    targetSimilarityFloor: numericMetric("targetSimilarityFloor"),
    targetReferenceCount: integerMetric("targetReferenceCount")
  };
  const score = typeof result.score === "number" && Number.isFinite(result.score) ? result.score : null;
  const metricsComplete = Object.values(metrics).every((value) => typeof value === "number" && Number.isFinite(value))
    && metrics.sourceDurationSeconds > 0
    && metrics.convertedDurationSeconds > 0
    && metrics.durationDeltaPercent >= 0
    && metrics.sourceVoicedFrames > 0
    && metrics.pairedVoicedFrames >= 0
    && metrics.pairedVoicedFrames <= metrics.sourceVoicedFrames
    && metrics.voicedDropoutPercent >= 0
    && metrics.voicedDropoutPercent <= 100
    && metrics.medianPitchErrorCents >= 0
    && metrics.pitchOver100CentsPercent >= 0
    && metrics.pitchOver100CentsPercent <= 100
    && metrics.abruptPitchJumpCount >= 0
    && metrics.abruptPitchJumpsPerMinute >= 0
    && metrics.sourceTargetSimilarity >= 0
    && metrics.sourceTargetSimilarity <= 1
    && metrics.targetSimilarity >= 0
    && metrics.targetSimilarity <= 1
    && metrics.targetSimilarityFloor > 0
    && metrics.targetSimilarityFloor <= 1
    && metrics.targetReferenceCount > 0;
  if ((!metricsComplete || score === null) && !reasons.includes("song_integrity_metrics_invalid")) {
    reasons.push("song_integrity_metrics_invalid");
  }
  if (metricsComplete && result.accepted === true) {
    const durationDeltaFromEvidence = metrics.sourceDurationSeconds > 0
      ? Math.abs(metrics.convertedDurationSeconds - metrics.sourceDurationSeconds) / metrics.sourceDurationSeconds * 100
      : Number.POSITIVE_INFINITY;
    const dropoutFromEvidence = metrics.sourceVoicedFrames > 0
      ? Math.max(0, metrics.sourceVoicedFrames - metrics.pairedVoicedFrames) / metrics.sourceVoicedFrames * 100
      : Number.POSITIVE_INFINITY;
    const jumpsPerMinuteFromEvidence = metrics.sourceDurationSeconds > 0
      ? metrics.abruptPitchJumpCount / metrics.sourceDurationSeconds * 60
      : Number.POSITIVE_INFINITY;
    const evidenceConsistent = Math.abs(metrics.durationDeltaPercent - durationDeltaFromEvidence) <= 0.05
      && Math.abs(metrics.voicedDropoutPercent - dropoutFromEvidence) <= 0.05
      && Math.abs(metrics.abruptPitchJumpsPerMinute - jumpsPerMinuteFromEvidence) <= 0.05;
    if (!evidenceConsistent && !reasons.includes("song_integrity_metrics_invalid")) {
      reasons.push("song_integrity_metrics_invalid");
    }
  }
  return {
    accepted: result.accepted === true && metricsComplete && score !== null,
    score,
    reasons: reasons.slice(0, 8),
    metrics,
    problemIntervals,
    f0Gate: result.f0Gate && typeof result.f0Gate === "object"
      ? result.f0Gate
      : evaluateDualF0Gate(result.f0Evaluators || {})
  };
}

function selectSeedSongReferenceClips(candidates) {
  const selected = [];
  let durationSeconds = 0;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const clipDurationSeconds = Math.max(0, Number(candidate?.durationSeconds) || 0);
    const contributionSeconds = Math.min(6, clipDurationSeconds, 18 - durationSeconds);
    if (!candidate?.audioPath || contributionSeconds < 1) continue;
    selected.push({ audioPath: candidate.audioPath, contributionSeconds });
    durationSeconds += contributionSeconds;
    if (durationSeconds >= 12 && selected.length >= 3) break;
  }
  return durationSeconds >= 12 && selected.length >= 2
    ? { clips: selected, durationSeconds }
    : { clips: [], durationSeconds: 0 };
}

function voiceProfileIdentityEvaluationAudioPaths(profile) {
  return (profile?.voiceModel?.referencePacks?.identityEvaluation?.artifacts || [])
    .slice(0, 16)
    .map((artifact) => {
      try { return resolveManagedArtifactPath(voiceDataRootDir(), artifact.relativePath); } catch { return ""; }
    })
    .filter((audioPath) => audioPath && pathIsInside(voiceDataRootDir(), audioPath));
}

async function buildSeedSongTargetReference({ profile, fallbackReferenceAudioPath, workingDir, signal = null }) {
  const configuredPackPaths = (profile?.voiceModel?.referencePacks?.seedInference?.artifacts || [])
    .map((artifact) => {
      try { return resolveManagedArtifactPath(voiceDataRootDir(), artifact.relativePath); } catch { return ""; }
    })
    .filter(Boolean);
  const baselineAudioPaths = Array.from(new Set([
    ...configuredPackPaths,
    ...voiceModelValidationBaselineAudioPaths(profile)
  ]));
  const candidates = [];
  for (const audioPath of baselineAudioPaths.slice(0, 16)) {
    throwIfVoiceAbortSignalAborted(signal);
    if (!(await pathExists(audioPath))) continue;
    let clipDurationSeconds = 0;
    try {
      clipDurationSeconds = parseWavInfo(await fs.readFile(audioPath)).durationSeconds;
    } catch {
      continue;
    }
    candidates.push({ audioPath, durationSeconds: clipDurationSeconds });
  }
  const selection = selectSeedSongReferenceClips(candidates);
  const selected = selection.clips;
  if (!selected.length) {
    return {
      audioPath: fallbackReferenceAudioPath,
      validationAudioPaths: [fallbackReferenceAudioPath],
      strategy: "single-version-reference",
      clipCount: 1,
      durationSeconds: 0
    };
  }
  const outputPath = path.join(workingDir, "song-target-multi-reference.wav");
  const filterParts = selected.map((clip, index) => (
    `[${index}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono,atrim=duration=${Number(clip.contributionSeconds.toFixed(4))},asetpts=PTS-STARTPTS[ref${index}]`
  ));
  const concatInputs = selected.map((_clip, index) => `[ref${index}]`).join("");
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const clip of selected) {
    args.push("-i", clip.audioPath);
  }
  args.push(
    "-filter_complex",
    `${filterParts.join(";")};${concatInputs}concat=n=${selected.length}:v=0:a=1,atrim=duration=18,asetpts=PTS-STARTPTS[target]`,
    "-map", "[target]",
    "-ac", "1",
    "-ar", "44100",
    "-c:a", "pcm_s16le",
    outputPath
  );
  await runFfmpegVoiceCommand(args, { timeoutMs: voiceEngineRequestTimeoutMs, signal });
  let durationSeconds = 0;
  try {
    durationSeconds = parseWavInfo(await fs.readFile(outputPath)).durationSeconds;
  } catch {
    durationSeconds = 0;
  }
  return {
    audioPath: outputPath,
    validationAudioPaths: selected.map((clip) => clip.audioPath),
    strategy: "multi-clip-target-reference-v1",
    clipCount: selected.length,
    durationSeconds
  };
}

async function analyzeSeedSongCandidate({
  sourceAudioPath,
  convertedAudioPath,
  durationSeconds,
  targetReference,
  settings,
  attempt,
  phase,
  validatorSession = null,
  signal
}) {
  throwIfVoiceAbortSignalAborted(signal);
  const request = {
    action: "analyze-song-conversion",
    sourceAudioPath,
    convertedAudioPath,
    durationSeconds,
    targetReferenceAudioPath: targetReference.audioPath,
    targetReferenceAudioPaths: targetReference.validationAudioPaths,
    attempt,
    phase,
    settings
  };
  const result = validatorSession
    ? await validatorSession.request(request)
    : await callVoiceEngineWorker(request, {
        engine: seedVcEngineId,
        timeoutMs: seedVcRequestTimeoutMs,
        signal
      });
  return normalizeSongIntegrityResult(result);
}

async function extractSeedSongRepairPhrase({ sourceAudioPath, outputPath, sourceDurationSeconds, startSeconds, endSeconds, signal = null }) {
  const repairDuration = Math.max(0.25, endSeconds - startSeconds);
  // Give Seed-VC musical context on both sides of the damaged interval. The
  // converted context is validated as a whole, but only the original damaged
  // center is copied back into the full stem. This avoids conditioning a
  // repair on an isolated phrase boundary and keeps the replacement aligned.
  const contextMarginSeconds = 0.75;
  const contextStartSeconds = Math.max(0, startSeconds - contextMarginSeconds);
  const contextEndSeconds = Math.min(
    Math.max(contextStartSeconds + repairDuration, Number(sourceDurationSeconds) || 0),
    endSeconds + contextMarginSeconds
  );
  const durationSeconds = Math.max(repairDuration, contextEndSeconds - contextStartSeconds);
  await runFfmpegVoiceCommand([
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-ss", Number(contextStartSeconds.toFixed(4)),
    "-t", Number(durationSeconds.toFixed(4)),
    "-i", sourceAudioPath,
    "-af", `apad,atrim=duration=${Number(durationSeconds.toFixed(4))},asetpts=PTS-STARTPTS`,
    "-ac", "1",
    "-ar", "44100",
    "-c:a", "pcm_s16le",
    outputPath
  ], { timeoutMs: voiceEngineRequestTimeoutMs, signal });
  return {
    durationSeconds,
    replacementStartSeconds: Math.max(0, startSeconds - contextStartSeconds),
    replacementDurationSeconds: repairDuration,
    contextStartSeconds,
    contextEndSeconds: contextStartSeconds + durationSeconds
  };
}

async function replaceSeedSongPhrase({
  convertedAudioPath,
  replacementAudioPath,
  outputPath,
  sourceDurationSeconds,
  startSeconds,
  endSeconds,
  replacementStartSeconds = 0,
  signal = null
}) {
  const repairDuration = Math.max(0.25, endSeconds - startSeconds);
  const parts = [];
  const concatInputs = [];
  if (startSeconds > 0.001) {
    parts.push(`[0:a]atrim=end=${Number(startSeconds.toFixed(4))},asetpts=PTS-STARTPTS[pre]`);
    concatInputs.push("[pre]");
  }
  // The interval detector already expands each issue with musical context.
  // Use a real context-sized edge ramp here; the old 30 ms splice produced
  // audible clicks when the replacement had a different phase.
  const fadeDuration = Math.min(0.12, repairDuration / 3);
  const fadeOutStart = Math.max(0, repairDuration - fadeDuration);
  const replacementStart = Math.max(0, Number(replacementStartSeconds) || 0);
  const replacementEnd = replacementStart + repairDuration;
  parts.push(`[1:a]apad,atrim=start=${Number(replacementStart.toFixed(4))}:end=${Number(replacementEnd.toFixed(4))},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fadeDuration},afade=t=out:st=${Number(fadeOutStart.toFixed(4))}:d=${fadeDuration}[repair]`);
  concatInputs.push("[repair]");
  if (endSeconds < sourceDurationSeconds - 0.001) {
    parts.push(`[0:a]atrim=start=${Number(endSeconds.toFixed(4))},asetpts=PTS-STARTPTS[post]`);
    concatInputs.push("[post]");
  }
  parts.push(`${concatInputs.join("")}concat=n=${concatInputs.length}:v=0:a=1,atrim=duration=${Number(sourceDurationSeconds.toFixed(4))},asetpts=PTS-STARTPTS[out]`);
  await runFfmpegVoiceCommand([
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", convertedAudioPath,
    "-i", replacementAudioPath,
    "-filter_complex", parts.join(";"),
    "-map", "[out]",
    "-ac", "1",
    "-ar", "44100",
    "-c:a", "pcm_s16le",
    outputPath
  ], { timeoutMs: voiceEngineRequestTimeoutMs, signal });
}

function publicSeedSongIntegrityAttempt({ phase, attempt, validation, repairedPhraseCount = 0 }) {
  return {
    phase,
    attempt,
    accepted: validation.accepted,
    selectedForFinalVerification: false,
    score: validation.score,
    reasons: validation.reasons,
    metrics: validation.metrics,
    repairedPhraseCount
  };
}

function isSeedSongRepairCandidateUsable(validation) {
  const metrics = validation?.metrics || {};
  const sourceSimilarity = Number(metrics.sourceTargetSimilarity);
  const targetSimilarity = Number(metrics.targetSimilarity);
  const targetSimilarityFloor = Number(metrics.targetSimilarityFloor);
  const provisionalIdentityFloor = sourceSimilarity >= 0.78 && Number.isFinite(targetSimilarityFloor)
    ? targetSimilarityFloor
    : Math.max(0.4, sourceSimilarity + 0.05);
  return Number(metrics.durationDeltaPercent) <= 1
    && Math.abs(Number(metrics.onsetLagMs)) <= 80
    && Number(metrics.voicedDropoutPercent) <= 15
    && Number(metrics.pitchOver100CentsPercent) <= 10
    && Number(metrics.abruptPitchJumpCount) <= 3
    && Number.isFinite(sourceSimilarity)
    && Number.isFinite(targetSimilarity)
    && targetSimilarity >= provisionalIdentityFloor;
}

function isSeedSongStrictlyAccepted(validation) {
  const metrics = validation?.metrics || {};
  const reasons = Array.isArray(validation?.reasons) ? validation.reasons : [];
  const requiredMetrics = [
    "sourceDurationSeconds",
    "convertedDurationSeconds",
    "durationDeltaPercent",
    "onsetLagMs",
    "sourceVoicedFrames",
    "pairedVoicedFrames",
    "voicedDropoutPercent",
    "medianPitchErrorCents",
    "pitchOver100CentsPercent",
    "abruptPitchJumpCount",
    "abruptPitchJumpsPerMinute",
    "sourceTargetSimilarity",
    "targetSimilarity",
    "targetSimilarityFloor",
    "targetReferenceCount"
  ];
  const durationDeltaFromEvidence = metrics.sourceDurationSeconds > 0
    ? Math.abs(metrics.convertedDurationSeconds - metrics.sourceDurationSeconds) / metrics.sourceDurationSeconds * 100
    : Number.POSITIVE_INFINITY;
  const dropoutFromEvidence = metrics.sourceVoicedFrames > 0
    ? Math.max(0, metrics.sourceVoicedFrames - metrics.pairedVoicedFrames) / metrics.sourceVoicedFrames * 100
    : Number.POSITIVE_INFINITY;
  const jumpsPerMinuteFromEvidence = metrics.sourceDurationSeconds > 0
    ? metrics.abruptPitchJumpCount / metrics.sourceDurationSeconds * 60
    : Number.POSITIVE_INFINITY;
  return validation?.accepted === true
    && typeof validation?.score === "number"
    && Number.isFinite(validation.score)
    && reasons.length === 0
    && (!Array.isArray(validation.problemIntervals) || validation.problemIntervals.length === 0)
    && requiredMetrics.every((key) => typeof metrics[key] === "number" && Number.isFinite(metrics[key]))
    && metrics.sourceDurationSeconds > 0
    && metrics.convertedDurationSeconds > 0
    && metrics.durationDeltaPercent >= 0
    && metrics.durationDeltaPercent <= 1
    && Math.abs(metrics.onsetLagMs) <= 80
    && metrics.sourceVoicedFrames > 0
    && Number.isInteger(metrics.sourceVoicedFrames)
    && metrics.pairedVoicedFrames > 0
    && Number.isInteger(metrics.pairedVoicedFrames)
    && metrics.pairedVoicedFrames <= metrics.sourceVoicedFrames
    && metrics.voicedDropoutPercent >= 0
    && metrics.voicedDropoutPercent <= 3
    && metrics.medianPitchErrorCents >= 0
    && metrics.pitchOver100CentsPercent >= 0
    && metrics.pitchOver100CentsPercent <= 4
    && Number.isInteger(metrics.abruptPitchJumpCount)
    && metrics.abruptPitchJumpCount >= 0
    && metrics.abruptPitchJumpsPerMinute >= 0
    && metrics.abruptPitchJumpsPerMinute <= 6
    && metrics.sourceTargetSimilarity >= 0
    && metrics.sourceTargetSimilarity <= 1
    && metrics.targetSimilarity >= metrics.targetSimilarityFloor
    && metrics.targetSimilarity <= 1
    && metrics.targetSimilarityFloor > 0
    && metrics.targetSimilarityFloor <= 1
    && Number.isInteger(metrics.targetReferenceCount)
    && metrics.targetReferenceCount > 0
    && Math.abs(metrics.durationDeltaPercent - durationDeltaFromEvidence) <= 0.05
    && Math.abs(metrics.voicedDropoutPercent - dropoutFromEvidence) <= 0.05
    && Math.abs(metrics.abruptPitchJumpsPerMinute - jumpsPerMinuteFromEvidence) <= 0.05
    && validation?.f0Gate?.passed === true;
}

function isSeedSongAdvisoryCandidateUsable(validation) {
  const metrics = validation?.metrics || {};
  const reasons = Array.isArray(validation?.reasons) ? validation.reasons : [];
  const requiredMetrics = [
    "sourceDurationSeconds",
    "convertedDurationSeconds",
    "durationDeltaPercent",
    "onsetLagMs",
    "sourceVoicedFrames",
    "pairedVoicedFrames",
    "voicedDropoutPercent",
    "medianPitchErrorCents",
    "pitchOver100CentsPercent",
    "abruptPitchJumpCount",
    "abruptPitchJumpsPerMinute",
    "sourceTargetSimilarity",
    "targetSimilarity",
    "targetSimilarityFloor",
    "targetReferenceCount"
  ];
  if (validation?.accepted === true
    || typeof validation?.score !== "number"
    || !Number.isFinite(validation.score)
    || reasons.length === 0
    || !reasons.every((reason) => reason === "pitch_discontinuity" || reason === "localized_pitch_failure")
    || !requiredMetrics.every((key) => typeof metrics[key] === "number" && Number.isFinite(metrics[key]))) {
    return false;
  }
  const targetSimilarity = metrics.targetSimilarity;
  const targetSimilarityFloor = metrics.targetSimilarityFloor;
  return metrics.sourceDurationSeconds > 0
    && metrics.convertedDurationSeconds > 0
    && metrics.durationDeltaPercent >= 0
    && metrics.durationDeltaPercent <= 1
    && Math.abs(metrics.onsetLagMs) <= 80
    && metrics.sourceVoicedFrames > 0
    && metrics.pairedVoicedFrames > 0
    && metrics.pairedVoicedFrames <= metrics.sourceVoicedFrames
    && metrics.voicedDropoutPercent >= 0
    && metrics.voicedDropoutPercent <= 5
    && metrics.medianPitchErrorCents >= 0
    && metrics.pitchOver100CentsPercent >= 0
    && metrics.pitchOver100CentsPercent <= 8
    && Number.isInteger(metrics.abruptPitchJumpCount)
    && metrics.abruptPitchJumpCount >= 0
    && metrics.abruptPitchJumpsPerMinute >= 0
    && metrics.abruptPitchJumpsPerMinute <= 20
    && metrics.sourceTargetSimilarity >= 0
    && metrics.sourceTargetSimilarity <= 1
    && targetSimilarity >= 0
    && targetSimilarity <= 1
    && targetSimilarityFloor > 0
    && targetSimilarityFloor <= 1
    && Number.isInteger(metrics.targetReferenceCount)
    && metrics.targetReferenceCount > 0
    && targetSimilarity >= targetSimilarityFloor;
}

async function convertVerifiedSeedSong({
  sourceAudioPath,
  sourceDurationSeconds,
  profile,
  fallbackReferenceAudioPath,
  settings,
  workingDir,
  onProgress = null,
  signal = null
}) {
  const vtvSettings = normalizeVtvSettings(settings, { mode: "song" });
  const vtvInference = await resolveVtvInferenceArtifacts(settings);
  const referencePack = buildRuntimeVtvReferencePack(profile, profile?.voiceModel?.versionId || "", "song", vtvSettings);
  const targetProfile = {
    ...profile,
    voiceModel: {
      ...(profile?.voiceModel || {}),
      referencePacks: {
        ...(profile?.voiceModel?.referencePacks || {}),
        seedInference: referencePack
      }
    }
  };
  const targetReference = await buildSeedSongTargetReference({
    profile: targetProfile,
    fallbackReferenceAudioPath,
    workingDir,
    signal
  });
  const sourceSha256 = await sha256File(sourceAudioPath);
  const runtimeManifestHash = profile?.voiceModel?.runtimeManifestHash || await seedVcRuntimeManifestHash();
  const vtvLineage = createVtvLineage({
    mode: "song",
    sourceSha256,
    referencePackId: referencePack.packId,
    referencePackSha256: referencePack.sha256,
    modelArtifactId: profile?.voiceModel?.versionId || "",
    modelCheckpointSha256: vtvInference.checkpointSha256
      || profile?.voiceModel?.vtvCheckpointSha256
      || profile?.voiceModel?.checkpointHash
      || profile?.voiceModel?.modelHash
      || "",
    runtimeManifestHash,
    normalizedSettings: {
      ...vtvSettings,
      modelConfigSha256: vtvInference.configSha256
    }
  });
  const jobBaseSeed = deriveVtvJobSeed({
    sourceSha256,
    referencePackSha256: vtvLineage.referencePackSha256,
    modelCheckpointSha256: vtvLineage.modelCheckpointSha256,
    normalizedSettings: vtvSettings
  });
  const candidatePlans = planVtvCandidates({
    jobBaseSeed,
    candidateBudget: Math.max(2, vtvSettings.candidateBudget),
    presetId: vtvSettings.presetId,
    kind: "song"
  });
  const validatorSession = createVoiceEngineWorkerSession({
    engine: seedVcEngineId,
    timeoutMs: seedVcRequestTimeoutMs,
    signal
  });
  try {
    const integrityAttempts = [];
    const conversionWarnings = [];
    const phraseConversionBudget = 12;
    let phraseConversionAttempts = 0;
    let phraseConversionBudgetExhausted = false;
    let lastValidation = null;
    let bestAdvisoryFullCandidate = null;
    let bestStrictCandidate = null;
    const persistedCandidates = [];
    for (let fullAttempt = 1; fullAttempt <= 2; fullAttempt += 1) {
    throwIfVoiceAbortSignalAborted(signal);
    const converted = await convertSeedVcSpeech({
      sourceAudioPath,
      sourceDurationSeconds,
      targetReferenceAudioPath: targetReference.audioPath,
      settings: {
         ...settings,
         ...vtvSettings,
         ...vtvInference.settings,
         nativeSampleRate: VTV_SONG_SAMPLE_RATE,
        outputSampleRate: VTV_SONG_SAMPLE_RATE,
        seed: candidatePlans[(fullAttempt - 1) % candidatePlans.length].seed
      },
      signal,
      onProgress: (event) => onProgress?.({
        progress: Math.max(4, Math.min(58, Math.round((Number(event.progress) || 0) * 0.54))),
        message: fullAttempt === 1
          ? "Converting vocals with the richer target reference"
          : "Retrying the full vocal candidate with a fresh Seed-VC pass"
      })
    });
    conversionWarnings.push(...(converted.warnings || []));
    const candidatePath = path.join(workingDir, `verified-song-full-${fullAttempt}.wav`);
    await fs.writeFile(candidatePath, converted.buffer);
    onProgress?.({ progress: 62, message: "Checking melody continuity and target voice identity" });
    let validation = await analyzeSeedSongCandidate({
      sourceAudioPath,
      convertedAudioPath: candidatePath,
      durationSeconds: sourceDurationSeconds,
      targetReference,
      settings,
      attempt: fullAttempt,
      phase: "full",
      validatorSession,
      signal
    });
    lastValidation = validation;
    integrityAttempts.push(publicSeedSongIntegrityAttempt({ phase: "full", attempt: fullAttempt, validation }));
    const candidateRecord = {
      id: `song-full-${fullAttempt}`,
      seed: candidatePlans[(fullAttempt - 1) % candidatePlans.length].seed,
      score: Number(validation.score) || 0,
      hardPassed: isSeedSongStrictlyAccepted(validation),
      needsReview: isSeedSongAdvisoryCandidateUsable(validation),
      reasons: Array.isArray(validation.reasons) ? validation.reasons : [],
      buffer: converted.buffer,
      repairedPhraseCount: 0
    };
    persistedCandidates.push(candidateRecord);
    if (isSeedSongAdvisoryCandidateUsable(validation)
      && (!bestAdvisoryFullCandidate || validation.score > bestAdvisoryFullCandidate.validation.score)) {
      bestAdvisoryFullCandidate = { converted, validation, fullAttempt, candidateRecord };
    }
    if (isSeedSongStrictlyAccepted(validation)) {
      candidateRecord.hardPassed = true;
      candidateRecord.needsReview = false;
      if (!bestStrictCandidate || validation.score > bestStrictCandidate.validation.score) {
        bestStrictCandidate = { converted, validation, fullAttempt, repairedPhraseCount: 0, candidateRecord };
      }
      continue;
    }

    if (validation.problemIntervals.length) {
      let patchedPath = candidatePath;
      let repairedPhraseCount = 0;
      for (let intervalIndex = 0; intervalIndex < validation.problemIntervals.length; intervalIndex += 1) {
        throwIfVoiceAbortSignalAborted(signal);
        const interval = validation.problemIntervals[intervalIndex];
        const phraseSourcePath = path.join(workingDir, `repair-${fullAttempt}-${intervalIndex}-source.wav`);
        const repairPhrase = await extractSeedSongRepairPhrase({
          sourceAudioPath,
          outputPath: phraseSourcePath,
          sourceDurationSeconds,
          startSeconds: interval.startSeconds,
          endSeconds: interval.endSeconds,
          signal
        });
        const phraseDuration = repairPhrase.durationSeconds;
        let acceptedPhrasePath = "";
        let bestRepairCandidate = null;
        for (let phraseAttempt = 1; phraseAttempt <= 3; phraseAttempt += 1) {
          if (phraseConversionAttempts >= phraseConversionBudget) {
            phraseConversionBudgetExhausted = true;
            break;
          }
          phraseConversionAttempts += 1;
          onProgress?.({
            progress: Math.max(65, Math.min(86, 65 + Math.round(((intervalIndex * 2 + phraseAttempt) / Math.max(1, validation.problemIntervals.length * 2)) * 21))),
            message: `Repairing unstable vocal phrase ${intervalIndex + 1}/${validation.problemIntervals.length}`
          });
          const repaired = await convertSeedVcSpeech({
            sourceAudioPath: phraseSourcePath,
            sourceDurationSeconds: phraseDuration,
            targetReferenceAudioPath: targetReference.audioPath,
            settings: {
               ...settings,
               ...vtvSettings,
               ...vtvInference.settings,
               nativeSampleRate: VTV_SONG_SAMPLE_RATE,
              outputSampleRate: VTV_SONG_SAMPLE_RATE,
              seed: deriveVtvJobSeed({
                sourceSha256: vtvLineage.sourceSha256,
                referencePackSha256: vtvLineage.referencePackSha256,
                modelCheckpointSha256: vtvLineage.modelCheckpointSha256,
                normalizedSettings: { ...vtvSettings, intervalStartMs: Math.round(interval.startSeconds * 1000), repairIndex: phraseAttempt }
              })
            },
            signal
          });
          conversionWarnings.push(...(repaired.warnings || []));
          const phraseCandidatePath = path.join(workingDir, `repair-${fullAttempt}-${intervalIndex}-attempt-${phraseAttempt}.wav`);
          await fs.writeFile(phraseCandidatePath, repaired.buffer);
          const phraseValidation = await analyzeSeedSongCandidate({
            sourceAudioPath: phraseSourcePath,
            convertedAudioPath: phraseCandidatePath,
            durationSeconds: phraseDuration,
            targetReference,
            settings,
            attempt: phraseAttempt,
            phase: "repair",
            validatorSession,
            signal
          });
          const publicAttempt = publicSeedSongIntegrityAttempt({
            phase: `repair-${fullAttempt}-${intervalIndex + 1}`,
            attempt: phraseAttempt,
            validation: phraseValidation,
            repairedPhraseCount: repairedPhraseCount + (isSeedSongStrictlyAccepted(phraseValidation) ? 1 : 0)
          });
          integrityAttempts.push(publicAttempt);
          if (isSeedSongStrictlyAccepted(phraseValidation)) {
            acceptedPhrasePath = phraseCandidatePath;
            break;
          }
          if (isSeedSongRepairCandidateUsable(phraseValidation)
            && (!bestRepairCandidate || phraseValidation.score > bestRepairCandidate.score)) {
            bestRepairCandidate = {
              path: phraseCandidatePath,
              score: phraseValidation.score,
              publicAttempt
            };
          }
        }
        if (!acceptedPhrasePath && bestRepairCandidate) {
          acceptedPhrasePath = bestRepairCandidate.path;
          bestRepairCandidate.publicAttempt.selectedForFinalVerification = true;
        }
        if (!acceptedPhrasePath) {
          patchedPath = "";
          break;
        }
        const nextPatchedPath = path.join(workingDir, `verified-song-patched-${fullAttempt}-${intervalIndex}.wav`);
        await replaceSeedSongPhrase({
          convertedAudioPath: patchedPath,
          replacementAudioPath: acceptedPhrasePath,
          outputPath: nextPatchedPath,
          sourceDurationSeconds,
          startSeconds: interval.startSeconds,
          endSeconds: interval.endSeconds,
          replacementStartSeconds: repairPhrase.replacementStartSeconds,
          signal
        });
        patchedPath = nextPatchedPath;
        repairedPhraseCount += 1;
      }
      if (patchedPath) {
        onProgress?.({ progress: 90, message: "Verifying the repaired full vocal stem" });
        validation = await analyzeSeedSongCandidate({
          sourceAudioPath,
          convertedAudioPath: patchedPath,
          durationSeconds: sourceDurationSeconds,
          targetReference,
          settings,
          attempt: fullAttempt,
          phase: "final",
          validatorSession,
          signal
        });
        lastValidation = validation;
        integrityAttempts.push(publicSeedSongIntegrityAttempt({
          phase: "final",
          attempt: fullAttempt,
          validation,
          repairedPhraseCount
        }));
        if (isSeedSongStrictlyAccepted(validation)) {
          if (repairedPhraseCount > 0) {
            conversionWarnings.push(`Song integrity recovered ${repairedPhraseCount} unstable vocal phrase(s) before mixback.`);
          }
          const repairedBuffer = await fs.readFile(patchedPath);
          candidateRecord.buffer = repairedBuffer;
          candidateRecord.hardPassed = true;
          candidateRecord.needsReview = false;
          candidateRecord.reasons = [];
          candidateRecord.score = Number(validation.score) || candidateRecord.score;
          candidateRecord.repairedPhraseCount = repairedPhraseCount;
          if (!bestStrictCandidate || validation.score > bestStrictCandidate.validation.score) {
            bestStrictCandidate = {
              converted: { ...converted, buffer: repairedBuffer, durationSeconds: sourceDurationSeconds },
              validation,
              fullAttempt,
              repairedPhraseCount,
              candidateRecord
            };
          }
        }
      }
    }
    }
    if (bestStrictCandidate) {
      return {
        ...bestStrictCandidate.converted,
        vtvPipelineVersion: VTV_PIPELINE_VERSION,
        vtvCandidateSeed: bestStrictCandidate.candidateRecord.seed,
        vtvLineage,
        vtvReferencePack: referencePack,
        vtvCandidates: persistedCandidates,
        vtvModelCheckpointSha256: vtvLineage.modelCheckpointSha256,
        vtvModelConfigSha256: vtvInference.configSha256,
        songIntegrity: {
          accepted: true,
          strictValidationAccepted: true,
          advisoryAccepted: false,
          advisoryReasons: [],
          fullAttemptCount: bestStrictCandidate.fullAttempt,
          repairedPhraseCount: bestStrictCandidate.repairedPhraseCount,
          phraseConversionBudget,
          phraseConversionAttempts,
          phraseConversionBudgetExhausted,
          targetReferenceStrategy: targetReference.strategy,
          targetReferenceClipCount: targetReference.clipCount,
          targetReferenceDurationSeconds: targetReference.durationSeconds,
          attempts: integrityAttempts,
          final: bestStrictCandidate.validation
        },
        warnings: conversionWarnings
      };
    }
    if (bestAdvisoryFullCandidate) {
      const advisoryReasons = bestAdvisoryFullCandidate.validation.reasons || [];
      conversionWarnings.push("Song conversion saved the best usable full vocal after strict local pitch recovery could not clear every flagged transition. Listen to the advisory sections before keeping the result.");
      return {
        ...bestAdvisoryFullCandidate.converted,
        vtvPipelineVersion: VTV_PIPELINE_VERSION,
        vtvCandidateSeed: candidatePlans[(bestAdvisoryFullCandidate.fullAttempt - 1) % candidatePlans.length].seed,
        vtvLineage,
        vtvReferencePack: referencePack,
        vtvCandidates: persistedCandidates,
        vtvModelCheckpointSha256: vtvLineage.modelCheckpointSha256,
        vtvModelConfigSha256: vtvInference.configSha256,
        songIntegrity: {
          accepted: true,
          strictValidationAccepted: false,
          advisoryAccepted: true,
          advisoryReasons,
          fullAttemptCount: bestAdvisoryFullCandidate.fullAttempt,
          repairedPhraseCount: 0,
          phraseConversionBudget,
          phraseConversionAttempts,
          phraseConversionBudgetExhausted,
          targetReferenceStrategy: targetReference.strategy,
          targetReferenceClipCount: targetReference.clipCount,
          targetReferenceDurationSeconds: targetReference.durationSeconds,
          attempts: integrityAttempts,
          final: bestAdvisoryFullCandidate.validation
        },
        warnings: conversionWarnings
      };
    }
    const failureReasons = new Set(lastValidation?.reasons || []);
    if (phraseConversionBudgetExhausted) {
      failureReasons.add("phrase_repair_budget_exhausted");
    }
    const reasons = [...failureReasons].join(", ") || "song_integrity_failed";
    const failure = new Error(`Song vocal conversion did not preserve melody and target identity (${reasons}). No defective output was saved.`);
    failure.voiceOutcomeStatus = failureReasons.has("song_integrity_metrics_invalid") ? "failed" : "rejected";
    failure.voiceJobDiagnostics = {
      songIntegrity: {
        accepted: false,
        fullAttemptCount: 2,
        phraseConversionBudget,
        phraseConversionAttempts,
        phraseConversionBudgetExhausted,
        targetReferenceStrategy: targetReference.strategy,
        targetReferenceClipCount: targetReference.clipCount,
        targetReferenceDurationSeconds: targetReference.durationSeconds,
        attempts: integrityAttempts,
        final: lastValidation
      }
    };
    throw failure;
  } finally {
    await validatorSession.close();
  }
}

async function analyzeSeedSpeechIdentityCandidates({
  sourceAudioPath,
  candidates,
  targetReferenceAudioPath = "",
  targetReferenceAudioPaths = [],
  settings = {},
  signal = null
}) {
  const result = await callSeedVcWorkerSerialized({
    action: "analyze-speaker-identity-batch",
    sourceAudioPath,
    targetReferenceAudioPath,
    targetReferenceAudioPaths,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      audioPath: candidate.audioPath
    })),
    settings
  }, { engine: seedVcEngineId, timeoutMs: seedVcRequestTimeoutMs, signal });
  const sourceTargetSimilarity = Number(result?.sourceTargetSimilarity);
  const targetSimilarityFloor = Number(result?.targetSimilarityFloor);
  const targetReferenceCount = Math.max(0, Math.round(Number(result?.targetReferenceCount) || 0));
  if (!Number.isFinite(sourceTargetSimilarity)
    || !Number.isFinite(targetSimilarityFloor)
    || targetSimilarityFloor <= 0
    || targetReferenceCount < 1) {
    throw new Error("Seed-VC target speaker identity analysis returned invalid metrics.");
  }
  const resultsById = new Map((Array.isArray(result?.results) ? result.results : []).map((item) => [String(item?.id || ""), item]));
  return candidates.map((candidate) => {
    const identity = resultsById.get(String(candidate.id));
    const targetSimilarity = Number(identity?.targetSimilarity);
    const identityGain = Number(identity?.identityGain);
    if (!identity || !Number.isFinite(targetSimilarity) || !Number.isFinite(identityGain)) {
      throw new Error(`Seed-VC target speaker identity analysis did not return valid metrics for ${candidate.id}.`);
    }
    return {
      ...candidate,
      identity: {
        accepted: identity.accepted === true && targetSimilarity >= targetSimilarityFloor,
        sourceTargetSimilarity,
        targetSimilarity,
        targetSimilarityFloor,
        identityGain,
        targetReferenceCount,
        encoderB: identity.encoderB && typeof identity.encoderB === "object"
          ? {
            passed: identity.encoderB.passed === true,
            score: Number(identity.encoderB.targetSimilarity),
            identityGain: Number(identity.encoderB.identityGain),
            targetSimilarityFloor: Number(identity.encoderB.targetSimilarityFloor),
            targetReferenceCount: Math.max(0, Math.round(Number(identity.encoderB.targetReferenceCount) || 0)),
            embeddingCount: Math.max(0, Math.round(Number(identity.encoderB.embeddingCount) || 0)),
            evaluatorVersion: sanitizeUnicodeText(identity.encoderB.evaluatorVersion || "")
          }
          : null,
        evaluatorVersion: sanitizeUnicodeText(result?.evaluatorVersion || "")
      }
    };
  });
}

async function validateVtvSpeechCandidate({
  sourceAudioPath,
  converted,
  referenceAudioPath,
  referenceAudioPaths = [],
  workingDir,
  candidateId,
  settings = {},
  validateContent = true,
  signal = null
}) {
  const candidatePath = path.join(workingDir, `${candidateId}.wav`);
  await fs.writeFile(candidatePath, converted.buffer);
  const alignment = await callVoiceEngineWorker({
    action: "analyze-conversion-alignment",
    sourceAudioPath,
    convertedAudioPath: candidatePath,
    settings
  }, { engine: voicePreparationEngineId, timeoutMs: voiceEngineRequestTimeoutMs, signal });
  const sourceDurationSeconds = Number(alignment?.sourceDurationSeconds);
  const convertedDurationSeconds = Number(alignment?.convertedDurationSeconds);
  const onsetLagMs = Number(alignment?.onsetLagMs);
  if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0
    || !Number.isFinite(convertedDurationSeconds) || convertedDurationSeconds <= 0
    || !Number.isFinite(onsetLagMs)
    || Math.abs(convertedDurationSeconds - sourceDurationSeconds) > Math.max(0.18, sourceDurationSeconds * 0.04)
    || Math.abs(onsetLagMs) > 250) {
    throw new Error("Speech VTV conversion did not preserve source timing.");
  }
  const identity = await analyzeSeedSpeechIdentityCandidates({
    sourceAudioPath,
    // The evaluator-facing id is intentionally stable and independent from
    // the display candidate id; some local test workers use numeric suffixes
    // as deterministic fixture selectors.
    candidates: [{ id: "target-100", audioPath: candidatePath }],
    targetReferenceAudioPath: referenceAudioPath,
    targetReferenceAudioPaths: referenceAudioPaths,
    settings: { ...settings, convertStyle: false },
    signal
  });
  const selected = identity[0];
  const targetSimilarity = Number(selected?.identity?.targetSimilarity);
  const targetSimilarityFloor = Number(selected?.identity?.targetSimilarityFloor);
  if (!selected?.identity?.accepted || !Number.isFinite(targetSimilarity) || !Number.isFinite(targetSimilarityFloor)) {
    throw new Error("Speech VTV target identity gate failed.");
  }
  return {
    ...converted,
    id: candidateId,
    audioPath: candidatePath,
    buffer: await fs.readFile(candidatePath),
    durationSeconds: convertedDurationSeconds,
    nativeSampleRate: VTV_SPEECH_SAMPLE_RATE,
    targetBlendRatio: 0,
    conversionCoverage: 1,
    conversionStrictValidationAccepted: true,
    sourceDurationSeconds,
    convertedDurationSeconds,
    conversionOnsetLagMs: onsetLagMs,
    identity: selected.identity,
    sourceTranscriptTokenCount: validateContent ? undefined : null,
    observedTranscriptTokenCount: validateContent ? undefined : null,
    sourceTargetSimilarity: Number(selected.identity.sourceTargetSimilarity) || 0,
    targetSimilarity,
    targetSimilarityFloor,
    targetReferenceCount: Math.max(1, Math.round(Number(selected.identity.targetReferenceCount) || 1)),
    identityValidationAccepted: true,
    vtvCandidateId: candidateId,
    vtvCandidatePath: candidatePath
  };
}

async function validateVtvSpeechContentBatch({ candidates, settings = {}, signal = null }) {
  const normalizedCandidates = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      id: String(candidate?.vtvCandidateId || candidate?.id || ""),
      audioPath: String(candidate?.vtvCandidatePath || candidate?.audioPath || "")
    }))
    .filter((candidate) => candidate.id && candidate.audioPath);
  if (!normalizedCandidates.length) {
    throw new Error("Speech VTV content validation received no candidates.");
  }
  const content = await callVoiceEngineWorker({
    action: "validate-conversion-batch",
    candidates: normalizedCandidates,
    settings
  }, { engine: voicePreparationEngineId, timeoutMs: voiceEngineRequestTimeoutMs, signal });
  const rawSourceTranscriptTokenCount = content?.sourceTranscriptTokenCount;
  const sourceTranscriptTokenCount = Number(rawSourceTranscriptTokenCount);
  const results = Array.isArray(content?.results) ? content.results : [];
  const ids = results.map((result) => String(result?.id || ""));
  if (typeof rawSourceTranscriptTokenCount !== "number"
    || !Number.isFinite(sourceTranscriptTokenCount)
    || sourceTranscriptTokenCount <= 0
    || results.length !== normalizedCandidates.length
    || new Set(ids).size !== ids.length
    || ids.some((id) => !id)) {
    throw new Error("Speech VTV content validation returned an incomplete or duplicated candidate batch.");
  }
  const expectedIds = new Set(normalizedCandidates.map((candidate) => candidate.id));
  for (const result of results) {
    const resultId = String(result?.id || "");
    const observedTokenCount = Number(result?.observedTokenCount);
    const expectedTokenCount = Number(result?.expectedTokenCount);
    if (!expectedIds.has(resultId)
      || !Number.isFinite(observedTokenCount)
      || observedTokenCount !== sourceTranscriptTokenCount
      || !Number.isFinite(expectedTokenCount)
      || expectedTokenCount !== sourceTranscriptTokenCount) {
      throw new Error("Speech VTV content validation returned an incomplete or mismatched transcript.");
    }
  }
  return {
    sourceTranscriptTokenCount,
    observedTranscriptTokenCount: sourceTranscriptTokenCount
  };
}

function buildRuntimeVtvReferencePack(profile, modelVersionId, mode, settings = {}) {
  const packs = profile?.voiceModel?.referencePacks && typeof profile.voiceModel.referencePacks === "object"
    ? profile.voiceModel.referencePacks
    : {};
  const sourcePack = packs[mode === "song" ? "vtvSong" : "vtvSpeech"]
    || packs.seedInference
    || packs.identityEvaluation
    || profile?.voiceModel?.referencePack
    || {};
  const clips = (Array.isArray(sourcePack.artifacts) ? sourcePack.artifacts : []).map((artifact, index) => ({
    ...artifact,
    id: artifact.artifactId || `${mode}-reference-${index + 1}`,
    durationSeconds: Number(artifact.durationMs) > 0 ? Number(artifact.durationMs) / 1000 : Number(artifact.durationSeconds) || 0,
    voicedDurationSeconds: Number(artifact.voicedDurationMs) > 0 ? Number(artifact.voicedDurationMs) / 1000 : Number(artifact.voicedDurationSeconds) || 0,
    quality: artifact.quality || { passed: true },
    speakerConsistency: artifact.speakerConsistency || { passed: true },
    nativeSampleRate: artifact.nativeSampleRate || (mode === "song" ? VTV_SONG_SAMPLE_RATE : VTV_SPEECH_SAMPLE_RATE)
  }));
  const identityCalibration = profile?.voiceModel?.identityCalibration || {};
  const pack = createVtvReferencePackV2({
    profileId: profile?.id,
    modelVersionId,
    mode,
    clips,
    speakerCentroids: sourcePack.speakerCentroids || {
      campplus: identityCalibration.encoderA?.evaluatorVersion ? `${sourcePack.referencePackId || ""}:campplus` : "",
      eres2netv2: identityCalibration.encoderB?.evaluatorVersion ? `${sourcePack.referencePackId || ""}:eres2netv2` : ""
    },
    qualitySummary: sourcePack.qualitySummary || {
      sourcePackId: sourcePack.referencePackId || "",
      sourceHealth: identityCalibration.status || "unavailable"
    },
    evaluatorVersions: identityCalibration.evaluatorVersions || {},
    minimumVoicedSeconds: Number(settings.referencePackMinimumVoicedSeconds)
      || (mode === "song" ? 20 : 15)
  });
  const validation = validateVtvReferencePackV2(pack, {
    profileId: profile?.id,
    modelVersionId,
    mode,
    requireReady: false
  });
  return {
    ...pack,
    validation,
    sourcePackId: sourcePack.referencePackId || "",
    health: {
      ...pack.health,
      status: validation.valid && pack.health.status === "ready" ? "ready" : "needs-review"
    }
  };
}

async function evaluateSeedSpeechQualityCandidates({
  candidates,
  targetReferenceAudioPath = "",
  targetReferenceAudioPaths = [],
  signal = null
}) {
  const result = await callSeedVcWorkerSerialized({
    action: "evaluate-quality-batch",
    targetReferenceAudioPath,
    targetReferenceAudioPaths,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      audioPath: candidate.audioPath
    }))
  }, { engine: seedVcEngineId, timeoutMs: seedVcRequestTimeoutMs, signal });
  const resultsById = new Map((Array.isArray(result?.results) ? result.results : []).map((item) => [String(item?.id || ""), item]));
  return candidates.map((candidate) => {
    const evaluated = resultsById.get(String(candidate.id));
    if (!evaluated || typeof evaluated !== "object") {
      throw new Error(`Seed-VC quality evaluation did not return valid metrics for ${candidate.id}.`);
    }
    const encoderB = evaluated.encoderB && typeof evaluated.encoderB === "object"
      ? {
        ...evaluated.encoderB,
        score: Number(evaluated.encoderB.score),
        passed: evaluated.encoderB.passed !== false
      }
      : null;
    return {
      ...candidate,
      identity: {
        ...(candidate.identity || {}),
        encoderB,
        evaluatorVersion: candidate.identity?.evaluatorVersion || sanitizeUnicodeText(result?.evaluatorVersions?.speaker || "")
      },
      perceptual: evaluated.perceptual && typeof evaluated.perceptual === "object"
        ? {
          ...evaluated.perceptual,
          score: Number(evaluated.perceptual.score),
          evaluatorVersion: sanitizeUnicodeText(evaluated.perceptual.evaluatorVersion || result?.evaluatorVersions?.perceptual || "")
        }
        : null
    };
  });
}

async function calibrateVoiceProfileIdentity(referenceAudioPaths = [], signal = null) {
  const paths = Array.from(new Set((Array.isArray(referenceAudioPaths) ? referenceAudioPaths : [])
    .map((item) => sanitizeUnicodeText(item || ""))
    .filter(Boolean)))
    .slice(0, 16);
  if (!paths.length) {
    throw new Error("Profile identity calibration requires at least one reference audio path.");
  }
  return callSeedVcWorkerSerialized({
    action: "calibrate-speaker-identity",
    targetReferenceAudioPaths: paths
  }, { engine: seedVcEngineId, timeoutMs: seedVcRequestTimeoutMs, signal });
}

async function selectCoverageSafeSeedVoiceBlend({
  sourceAudioPath,
  convertedBuffer,
  language,
  expectedText = "",
  referenceAudioPath = "",
  targetReferenceAudioPaths = [],
  baselineAudioPaths = [],
  settings = {},
  maxTargetBlendRatio = 1,
  allowSourceDominantCoverageRecovery = false,
  signal = null
}) {
  const workDir = path.join(os.tmpdir(), makeVoiceId("voice-seed-vc-blend"));
  const startedAt = Date.now();
  let stage = "normalization";
  try {
    await fs.mkdir(workDir, { recursive: true });
    const normalizedSourcePath = path.join(workDir, "source-pcm.wav");
    const convertedPath = path.join(workDir, "converted.wav");
    const alignedConvertedPath = path.join(workDir, "converted-aligned.wav");
    await normalizeVoiceAudioFile({
      inputPath: sourceAudioPath,
      outputPath: normalizedSourcePath,
      sampleRate: 32000
    });
    await fs.writeFile(convertedPath, convertedBuffer);
    stage = "alignment";
    const alignment = await callVoiceEngineWorker({
      action: "analyze-conversion-alignment",
      sourceAudioPath: normalizedSourcePath,
      convertedAudioPath: convertedPath,
      settings
    }, { engine: voicePreparationEngineId, timeoutMs: voiceEngineRequestTimeoutMs, signal });
    const sourceDuration = Number(alignment?.sourceDurationSeconds);
    const convertedDuration = Number(alignment?.convertedDurationSeconds);
    const onsetLagMs = Number(alignment?.onsetLagMs);
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0
      || !Number.isFinite(convertedDuration) || convertedDuration <= 0
      || !Number.isFinite(onsetLagMs)) {
      throw new Error("Voice conversion timing analysis returned invalid metrics.");
    }
    const allowedDurationDelta = Math.max(0.18, sourceDuration * 0.04);
    if (Math.abs(convertedDuration - sourceDuration) > allowedDurationDelta) {
      throw new Error("Converted speech did not preserve source timing. No partial output was saved.");
    }
    if (Math.abs(onsetLagMs) > 250) {
      throw new Error("Converted speech was too far out of sync with the source. No partial output was saved.");
    }
    let blendInputPath = convertedPath;
    if (Math.abs(onsetLagMs) >= 40) {
      stage = "alignment-correction";
      const durationText = Number(sourceDuration.toFixed(4));
      const alignmentFilter = onsetLagMs > 0
        ? `atrim=start=${Number((onsetLagMs / 1000).toFixed(4))},asetpts=PTS-STARTPTS,apad,atrim=duration=${durationText}`
        : `adelay=${Math.round(Math.abs(onsetLagMs))}:all=1,atrim=duration=${durationText}`;
      await runFfmpegVoiceCommand([
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", convertedPath,
        "-af", alignmentFilter,
        "-ac", "1",
        "-ar", "32000",
        "-c:a", "pcm_s16le",
        alignedConvertedPath
      ], { timeoutMs: voiceEngineRequestTimeoutMs });
      blendInputPath = alignedConvertedPath;
    }
    const safeMaxTargetBlendRatio = Math.max(0.2, Math.min(1, Number(maxTargetBlendRatio) || 1));
    const ratios = [0.8, 0.6, 0.5, 0.4, 0.3, 0.2]
      .filter((ratio) => ratio <= safeMaxTargetBlendRatio + Number.EPSILON);
    const candidates = safeMaxTargetBlendRatio >= 1
      ? [{ id: "target-100", audioPath: blendInputPath, targetBlendRatio: 1 }]
      : [];
    stage = "candidate-blending";
    for (const ratio of ratios) {
      throwIfVoiceAbortSignalAborted(signal);
      const outputPath = path.join(workDir, `blend-${Math.round(ratio * 100)}.wav`);
      await runFfmpegVoiceCommand([
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", normalizedSourcePath,
        "-i", blendInputPath,
        "-filter_complex", `[0:a]volume=${Number((1 - ratio).toFixed(3))}[source];[1:a]volume=${ratio}[target];[source][target]amix=inputs=2:duration=first:normalize=0[voice]`,
        "-map", "[voice]",
        "-ac", "1",
        "-ar", "32000",
        "-c:a", "pcm_s16le",
        outputPath
      ], { timeoutMs: voiceEngineRequestTimeoutMs });
      candidates.push({ id: `blend-${Math.round(ratio * 100)}`, audioPath: outputPath, targetBlendRatio: ratio });
    }
    stage = "coverage-waveform-validation";
    const validated = expectedText
      ? {
          sourceTranscriptTokenCount: 0,
          candidates: await validateVoiceSynthesisCandidates({
            candidates: candidates.map((candidate) => ({ ...candidate, expectedText })),
            language,
            referenceAudioPath,
            baselineAudioPaths,
            settings,
            signal
          })
        }
      : await validateVoiceConversionCandidates({
          sourceAudioPath: normalizedSourcePath,
          candidates,
          language,
          referenceAudioPath,
          baselineAudioPaths,
          settings,
          signal
        });
    let rankedCandidates = validated.candidates;
    if (expectedText) {
      stage = "identity-validation";
      rankedCandidates = await analyzeSeedSpeechIdentityCandidates({
        sourceAudioPath: normalizedSourcePath,
        candidates: validated.candidates,
        targetReferenceAudioPath: referenceAudioPath,
        targetReferenceAudioPaths,
        settings,
        signal
      });
      stage = "coverage-waveform-validation";
    }
    const identityRank = (left, right) => (
      (Number(right.identity?.targetSimilarity) || 0) - (Number(left.identity?.targetSimilarity) || 0)
      || right.targetBlendRatio - left.targetBlendRatio
    );
    const strictlyUsable = rankedCandidates.filter((candidate) => (
      (isVoiceSynthesisStrictlyAccepted(candidate.validation)
        || isVoiceSynthesisAmplitudeAdvisory(candidate.validation))
      && (!expectedText || candidate.identity?.accepted === true)
    ));
    const strictlySelected = expectedText
      ? strictlyUsable.sort(identityRank)[0] || null
      : strictlyUsable[0] || null;
    // Fine TTS starts from speech whose words were already checked clause by
    // clause. If whole-file ASR remains uncertain after Seed-VC, a blend that
    // is still at least 70% that validated source is safer than discarding the
    // entire result. Keep this recovery unavailable to raw VTV and reject all
    // hard waveform, excess-text, or spectral failures through the advisory
    // predicate.
    const sourceDominantCoverageRecovery = !strictlySelected && expectedText && allowSourceDominantCoverageRecovery
      ? rankedCandidates.filter((candidate) => (
          candidate.targetBlendRatio <= 0.3
          && isVoiceSynthesisCoverageAdvisory(candidate.validation)
          && candidate.identity?.accepted === true
        )).sort(identityRank)[0] || null
      : null;
    const selected = strictlySelected || sourceDominantCoverageRecovery;
    if (!selected) {
      const textSafeWithoutIdentity = expectedText && rankedCandidates.some((candidate) => (
        isVoiceSynthesisStrictlyAccepted(candidate.validation)
        || isVoiceSynthesisAmplitudeAdvisory(candidate.validation)
        || (allowSourceDominantCoverageRecovery
          && candidate.targetBlendRatio <= 0.3
          && isVoiceSynthesisCoverageAdvisory(candidate.validation))
      ));
      if (textSafeWithoutIdentity) {
        stage = "identity-validation";
        throw new Error("Converted speech did not improve target speaker identity (target_identity_weak). No partial output was saved.");
      }
      const last = rankedCandidates.at(-1)?.validation;
      const reasons = voiceSynthesisValidationReasons(last);
      const transcriptLabel = expectedText ? "requested text" : "private source transcript";
      throw new Error(`Converted speech did not preserve the ${transcriptLabel} (${reasons.join(", ") || "speech_integrity_failed"}). No partial output was saved.`);
    }
    return {
      buffer: await fs.readFile(selected.audioPath),
      targetBlendRatio: selected.targetBlendRatio,
      coverage: Number(selected.validation.coverage) || 0,
      strictValidationAccepted: isVoiceSynthesisStrictlyAccepted(selected.validation),
      advisoryAmplitudeWarning: isVoiceSynthesisAmplitudeAdvisory(selected.validation),
      advisoryCoverageWarning: isVoiceSynthesisCoverageAdvisory(selected.validation),
      sourceTranscriptTokenCount: expectedText
        ? Math.max(0, Math.round(Number(selected.validation.expectedTokenCount) || 0))
        : validated.sourceTranscriptTokenCount,
      sourceDurationSeconds: sourceDuration,
      convertedDurationSeconds: convertedDuration,
      onsetLagMs,
      waveformHealth: selected.validation.waveformHealth || {},
      identityValidationAccepted: selected.identity?.accepted === true,
      sourceTargetSimilarity: Number(selected.identity?.sourceTargetSimilarity) || 0,
      targetSimilarity: Number(selected.identity?.targetSimilarity) || 0,
      targetSimilarityFloor: Number(selected.identity?.targetSimilarityFloor) || 0,
      identityGain: Number(selected.identity?.identityGain) || 0,
      targetReferenceCount: Math.max(0, Math.round(Number(selected.identity?.targetReferenceCount) || 0))
    };
  } catch (error) {
    throw voiceRefinementStageError(error, stage, {
      durationMs: Date.now() - startedAt,
      maxTargetBlendRatio: Math.max(0.2, Math.min(1, Number(maxTargetBlendRatio) || 1))
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function separateSongStemsWithFfmpeg({ sourceAudioPath, workingDir, sourceChannels = 0, settings = {} }) {
  const normalizedPath = path.join(workingDir, "song-source.wav");
  const vocalPath = path.join(workingDir, "song-vocals.wav");
  const accompanimentPath = path.join(workingDir, "song-accompaniment.wav");
  const warnings = [];
  if (Number(sourceChannels) && Number(sourceChannels) < 2) {
    warnings.push("Source song is mono, so vocal/accompaniment separation will be limited.");
  }
  await runFfmpegVoiceCommand([
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", sourceAudioPath,
    "-vn",
    "-ar", "44100",
    "-ac", "2",
    "-c:a", "pcm_s16le",
    normalizedPath
  ]);
  const vocalFilter = settings.noiseReduction === true
    ? "pan=mono|c0=0.5*c0+0.5*c1,highpass=f=70,lowpass=f=20000,loudnorm=I=-20:TP=-1.5:LRA=11"
    : "pan=mono|c0=0.5*c0+0.5*c1";
  await runFfmpegVoiceCommand([
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", normalizedPath,
    "-vn",
    "-af", vocalFilter,
    "-ar", "44100",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    vocalPath
  ]);
  await runFfmpegVoiceCommand([
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", normalizedPath,
    "-vn",
    "-af", "pan=stereo|c0=c0-c1|c1=c1-c0,volume=0.8",
    "-ar", "44100",
    "-ac", "2",
    "-c:a", "pcm_s16le",
    accompanimentPath
  ]);
  warnings.push("Song beta uses FFmpeg center/side separation. Dense mixes may still leave drums or instruments in the vocal stem.");
  return {
    vocalPath,
    accompanimentPath,
    normalizedPath,
    warnings,
    separationStrategy: "ffmpeg-center-side"
  };
}

async function separateSongStemsWithDemucs({ sourceAudioPath, workingDir, settings = {}, onProgress = null, signal = null }) {
  await assertSeedVcEngineReady();
  const vocalPath = path.join(workingDir, "song-vocals.wav");
  const accompanimentPath = path.join(workingDir, "song-accompaniment.wav");
  const separationModel = String(settings.separationModel || settings.separation_model || "htdemucs").toLowerCase() === "htdemucs_ft"
    ? "htdemucs_ft"
    : "htdemucs";
  const result = await callVoiceEngineWorker({
    action: "separate-stems",
    sourceAudioPath,
    vocalPath,
    accompanimentPath,
    workingDir,
    separationModel,
    segmentSeconds: 7,
    separationOverlap: settings.separationOverlap,
    separationShifts: settings.separationShifts,
    ffmpegPath: voiceWorkerFfmpegPath(),
    ffprobePath: staticMediaToolPath("ffprobe"),
    device: "auto"
  }, {
    engine: seedVcEngineId,
    timeoutMs: seedVcRequestTimeoutMs,
    onProgress,
    signal
  });
  return {
    vocalPath: result.vocalPath || vocalPath,
    accompanimentPath: result.accompanimentPath || accompanimentPath,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    separationStrategy: result.separationStrategy || `demucs-${separationModel}`,
    separationDevice: result.device || "",
    separationOverlap: Number(result.overlap) || Number(settings.separationOverlap) || 0.5,
    separationShifts: Number(result.shifts) || Number(settings.separationShifts) || 1
  };
}

async function separateSongStemsWithRoformer({ sourceAudioPath, workingDir, settings = {}, onProgress = null, signal = null }) {
  await assertSeedVcEngineReady();
  const vocalPath = path.join(workingDir, "song-vocals.wav");
  const accompanimentPath = path.join(workingDir, "song-accompaniment.wav");
  const result = await callVoiceEngineWorker({
    action: "separate-stems-roformer",
    sourceAudioPath,
    vocalPath,
    accompanimentPath,
    workingDir,
    roformerRoot: settings.roformerRoot || settings.roformer_root || "",
    roformerModelPath: settings.roformerModelPath || settings.roformer_model_path || "",
    roformerConfigPath: settings.roformerConfigPath || settings.roformer_config_path || "",
    roformerCodeRoot: settings.roformerCodeRoot || settings.roformer_code_root || "",
    device: "auto"
  }, {
    engine: seedVcEngineId,
    timeoutMs: seedVcRequestTimeoutMs,
    onProgress,
    signal
  });
  return {
    vocalPath: result.vocalPath || vocalPath,
    accompanimentPath: result.accompanimentPath || accompanimentPath,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    separationStrategy: result.separationStrategy || "bs-roformer-viperx-ep317-sdr12.9755",
    separationDevice: result.device || "",
    separationOverlap: Number(result.overlap) || 0.5,
    separationShifts: Number(result.shifts) || 1,
    separatorModelSha256: result.modelSha256 || "",
    separatorSampleRate: Number(result.sampleRate) || VTV_SONG_SAMPLE_RATE
  };
}

async function mixConvertedSongWithFfmpeg({ accompanimentPath, convertedVocalPath, outputPath, settings = {}, vocalPitchShiftSemitones = 0, signal = null }) {
  const normalizedSettings = normalizeSongReplacementSettings(settings);
  const mixPlan = buildSongMixPlan({ ...normalizedSettings, vocalPitchShiftSemitones });
  const { filter, ...mixPitch } = mixPlan;
  await runFfmpegVoiceCommand([
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", accompanimentPath,
    "-i", convertedVocalPath,
    "-filter_complex", filter,
    "-map", "[out]",
    "-ar", "44100",
    "-ac", "2",
    "-c:a", "pcm_s16le",
    outputPath
  ], { timeoutMs: voiceEngineRequestTimeoutMs, signal });
  const buffer = await fs.readFile(outputPath);
  let durationSeconds = 0;
  try {
    durationSeconds = parseWavInfo(buffer).durationSeconds;
  } catch {
    durationSeconds = 0;
  }
  return {
    buffer,
    durationSeconds,
    mixStrategy: "ffmpeg-amix",
    settings: { ...normalizedSettings, mixPitch },
    mixPitch
  };
}

function analyzeFinalSongMixGate(buffer) {
  try {
    const info = parseWavInfo(buffer);
    const reasons = [];
    if (info.sampleRate !== VTV_SONG_SAMPLE_RATE) reasons.push("final_mix_sample_rate_not_native_44k1");
    if (info.channels !== 2) reasons.push("final_mix_not_stereo");
    if (info.bitsPerSample !== 16) reasons.push("final_mix_not_pcm16");
    if (info.durationSeconds <= 0) reasons.push("final_mix_empty");
    if (info.clippingDetected) reasons.push("final_mix_clipping");
    if (Number.isFinite(info.peakDbfs) && info.peakDbfs > -0.1) reasons.push("final_mix_true_peak_exceeded");
    if (Number.isFinite(info.rmsDbfs) && (info.rmsDbfs < -30 || info.rmsDbfs > -10)) reasons.push("final_mix_loudness_out_of_range");
    return {
      passed: reasons.length === 0,
      sampleRate: info.sampleRate,
      channels: info.channels,
      bitsPerSample: info.bitsPerSample,
      durationSeconds: info.durationSeconds,
      clippingRatio: info.clippingRatio,
      truePeakDbfs: info.peakDbfs,
      loudnessLu: info.rmsDbfs,
      reasons
    };
  } catch (error) {
    return { passed: false, reasons: ["final_mix_invalid_wav", sanitizeUnicodeText(error.message || error)] };
  }
}

function pcm16MonoSamples(buffer) {
  const info = parseWavInfo(buffer);
  if (info.bitsPerSample !== 16 && !(info.audioFormat === 3 && info.bitsPerSample === 32)) return null;
  let cursor = 12;
  let dataOffset = 0;
  let dataSize = 0;
  while (cursor + 8 <= buffer.length) {
    const id = buffer.toString("ascii", cursor, cursor + 4);
    const size = buffer.readUInt32LE(cursor + 4);
    if (id === "data") {
      dataOffset = cursor + 8;
      dataSize = Math.min(size, Math.max(0, buffer.length - dataOffset));
      break;
    }
    cursor += 8 + size + (size % 2);
  }
  const bytesPerSample = Math.max(1, info.bitsPerSample / 8);
  const frames = Math.floor(dataSize / Math.max(1, info.channels * bytesPerSample));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let total = 0;
    for (let channel = 0; channel < info.channels; channel += 1) {
      const sampleOffset = dataOffset + (frame * info.channels + channel) * (info.bitsPerSample / 8);
      total += info.audioFormat === 3
        ? buffer.readFloatLE(sampleOffset)
        : buffer.readInt16LE(sampleOffset) / 32768;
    }
    samples[frame] = total / Math.max(1, info.channels);
  }
  return { info, samples };
}

function resampleMonoSamples(samples, fromSampleRate, toSampleRate) {
  if (!samples || !Number.isFinite(fromSampleRate) || !Number.isFinite(toSampleRate) || fromSampleRate <= 0 || toSampleRate <= 0 || fromSampleRate === toSampleRate) return samples;
  const outputLength = Math.max(1, Math.round(samples.length * toSampleRate / fromSampleRate));
  const output = new Float32Array(outputLength);
  const ratio = fromSampleRate / toSampleRate;
  for (let index = 0; index < output.length; index += 1) {
    const sourcePosition = index * ratio;
    const leftIndex = Math.min(samples.length - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    output[index] = (samples[leftIndex] || 0) * (1 - fraction) + (samples[rightIndex] || 0) * fraction;
  }
  return output;
}

function stemCorrelation(first, second) {
  const length = Math.min(first.length, second.length, 120000);
  if (length < 100) return 0;
  const stride = Math.max(1, Math.floor(Math.min(first.length, second.length) / length));
  let sumFirst = 0;
  let sumSecond = 0;
  for (let index = 0; index < length; index += 1) {
    sumFirst += first[index * stride] || 0;
    sumSecond += second[index * stride] || 0;
  }
  const meanFirst = sumFirst / length;
  const meanSecond = sumSecond / length;
  let numerator = 0;
  let firstEnergy = 0;
  let secondEnergy = 0;
  for (let index = 0; index < length; index += 1) {
    const left = (first[index * stride] || 0) - meanFirst;
    const right = (second[index * stride] || 0) - meanSecond;
    numerator += left * right;
    firstEnergy += left * left;
    secondEnergy += right * right;
  }
  return Math.abs(numerator / Math.max(1e-9, Math.sqrt(firstEnergy * secondEnergy)));
}

function alignStemReconstruction(source, reconstructed, maxLagSamples = 2048) {
  const limit = Math.min(source.length, reconstructed.length);
  const stride = Math.max(64, Math.floor(limit / 20000));
  let best = { lagSamples: 0, correlation: -1 };
  for (let lag = -maxLagSamples; lag <= maxLagSamples; lag += 128) {
    const sourceStart = Math.max(0, lag);
    const reconstructedStart = Math.max(0, -lag);
    const length = Math.min(limit - sourceStart, limit - reconstructedStart);
    if (length < stride * 32) continue;
    let sourceMean = 0;
    let reconstructedMean = 0;
    let count = 0;
    for (let index = 0; index < length; index += stride) {
      sourceMean += source[sourceStart + index] || 0;
      reconstructedMean += reconstructed[reconstructedStart + index] || 0;
      count += 1;
    }
    sourceMean /= Math.max(1, count);
    reconstructedMean /= Math.max(1, count);
    let numerator = 0;
    let sourceEnergy = 0;
    let reconstructedEnergy = 0;
    for (let index = 0; index < length; index += stride) {
      const sourceValue = (source[sourceStart + index] || 0) - sourceMean;
      const reconstructedValue = (reconstructed[reconstructedStart + index] || 0) - reconstructedMean;
      numerator += sourceValue * reconstructedValue;
      sourceEnergy += sourceValue * sourceValue;
      reconstructedEnergy += reconstructedValue * reconstructedValue;
    }
    const correlation = numerator / Math.max(1e-9, Math.sqrt(sourceEnergy * reconstructedEnergy));
    if (correlation > best.correlation) best = { lagSamples: lag, correlation };
  }
  return best;
}

async function analyzeVtvSongStemGate({ sourceAudioPath, vocalPath, accompanimentPath }) {
  try {
    const [sourceBuffer, vocalBuffer, accompanimentBuffer] = await Promise.all([
      sourceAudioPath ? fs.readFile(sourceAudioPath) : Promise.resolve(null),
      fs.readFile(vocalPath),
      fs.readFile(accompanimentPath)
    ]);
    const vocal = parseWavInfo(vocalBuffer);
    const accompaniment = parseWavInfo(accompanimentBuffer);
    const sourceSamples = sourceBuffer ? pcm16MonoSamples(sourceBuffer) : null;
    const vocalSamples = pcm16MonoSamples(vocalBuffer);
    const accompanimentSamples = pcm16MonoSamples(accompanimentBuffer);
    let reconstruction = { errorDb: null, backgroundLeakRatio: null, vocalResidualRatio: null };
    if (sourceSamples && vocalSamples && accompanimentSamples) {
      const comparisonSampleRate = sourceSamples.info.sampleRate;
      const comparisonVocal = resampleMonoSamples(vocalSamples.samples, vocalSamples.info.sampleRate, comparisonSampleRate);
      const comparisonAccompaniment = resampleMonoSamples(accompanimentSamples.samples, accompanimentSamples.info.sampleRate, comparisonSampleRate);
      const length = Math.min(sourceSamples.samples.length, comparisonVocal.length, comparisonAccompaniment.length);
      const reconstructedSamples = new Float32Array(length);
      for (let index = 0; index < length; index += 1) {
        reconstructedSamples[index] = comparisonVocal[index] + comparisonAccompaniment[index];
      }
      const alignment = alignStemReconstruction(sourceSamples.samples, reconstructedSamples);
      const sourceStart = Math.max(0, alignment.lagSamples);
      const reconstructedStart = Math.max(0, -alignment.lagSamples);
      const alignedLength = Math.min(length - sourceStart, length - reconstructedStart);
      let sourceEnergy = 0;
      let errorEnergy = 0;
      for (let index = 0; index < alignedLength; index += 1) {
        const source = sourceSamples.samples[sourceStart + index];
        const reconstructed = reconstructedSamples[reconstructedStart + index];
        sourceEnergy += source * source;
        errorEnergy += (source - reconstructed) ** 2;
      }
      reconstruction = {
        errorDb: Number((20 * Math.log10(Math.max(1e-6, Math.sqrt(errorEnergy / Math.max(1, alignedLength)) / Math.max(1e-6, Math.sqrt(sourceEnergy / Math.max(1, alignedLength)))))).toFixed(3)),
        backgroundLeakRatio: stemCorrelation(comparisonVocal, comparisonAccompaniment),
        vocalResidualRatio: stemCorrelation(comparisonVocal, comparisonAccompaniment),
        alignmentLagSamples: alignment.lagSamples,
        alignmentCorrelation: Number(alignment.correlation.toFixed(6))
      };
    }
    const stemGate = evaluateStemGate({
      vocal: {
        durationSeconds: vocal.durationSeconds,
        clipping: vocal.clippingDetected === true
      },
      accompaniment: {
        durationSeconds: accompaniment.durationSeconds,
        clipping: accompaniment.clippingDetected === true
      },
      reconstruction
    });
    return {
      ...stemGate,
      source: sourceSamples ? {
        sampleRate: sourceSamples.info.sampleRate,
        channels: sourceSamples.info.channels,
        durationSeconds: Number((sourceSamples.samples.length / Math.max(1, sourceSamples.info.sampleRate)).toFixed(6))
      } : null,
      vocal: {
        sampleRate: vocal.sampleRate,
        channels: vocal.channels,
        durationSeconds: vocal.durationSeconds,
        sha256: createHash("sha256").update(vocalBuffer).digest("hex")
      },
      accompaniment: {
        sampleRate: accompaniment.sampleRate,
        channels: accompaniment.channels,
        durationSeconds: accompaniment.durationSeconds,
        sha256: createHash("sha256").update(accompanimentBuffer).digest("hex")
      },
      reconstruction
    };
  } catch (error) {
    return { passed: false, reasons: ["stem_gate_invalid_wav", sanitizeUnicodeText(error.message || error)] };
  }
}

function voiceOutputBaseDir(defaultDownloadDir, requestedOutputDir) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(
    normalizeDownloadDir(requestedOutputDir, path.join(defaultDownloadDir, "voice-clone-outputs")),
    date
  );
}

function voiceOutputFilename(outputId, mode, profileName, engineId = "") {
  const engineSuffix = mode === "song-v2v" && engineId ? `-${sanitizeFileName(engineId)}` : "";
  return `${outputId}-${sanitizeFileName(`${mode}-${profileName || "voice"}`)}${engineSuffix}.wav`;
}

function voiceJobCancelledError() {
  const error = new Error("Voice job cancelled.");
  error.code = "VOICE_JOB_CANCELLED";
  return error;
}

function cloneVoiceRecord(record) {
  return JSON.parse(JSON.stringify(record || {}));
}

function restoreVoiceRecord(target, snapshot) {
  for (const key of Object.keys(target || {})) {
    delete target[key];
  }
  Object.assign(target, cloneVoiceRecord(snapshot));
}

function throwIfVoiceAbortSignalAborted(signal) {
  if (signal?.aborted) {
    throw voiceJobCancelledError();
  }
}

async function removeVoiceOutputRecord(db, output) {
  if (!output) {
    return;
  }
  db.outputs = (Array.isArray(db.outputs) ? db.outputs : []).filter((item) => item.id !== output.id);
  await writeVoiceDb(db).catch(() => {});
  const candidatePaths = Array.isArray(output.settings?.vtvCandidates)
    ? output.settings.vtvCandidates.map((candidate) => {
      try { return resolveManagedArtifactPath(voiceDataRootDir(), candidate.relativePath); } catch { return ""; }
      }).filter((candidatePath) => candidatePath && pathIsInside(voiceDataRootDir(), candidatePath))
    : [];
  const candidateRoot = path.join(voiceDataRootDir(), "vtv-candidates", String(output.id || ""));
  await Promise.all([
    fs.rm(output.outputPath, { force: true }),
    fs.rm(output.metadataPath, { force: true }),
    fs.rm(candidateRoot, { recursive: true, force: true }),
    ...candidatePaths.map((candidatePath) => fs.rm(candidatePath, { force: true }))
  ].map((operation) => operation.catch(() => {})));
}

async function writeVoiceOutputRecord({ db, defaultDownloadDir, outputDir, mode, profile, language, inputSummary, sourceAudioName, durationSeconds, settings, audioBuffer = null, engine = voiceNeuralEngineId, signal = null }) {
  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) {
    throw new Error("Neural voice worker did not return playable audio.");
  }
  throwIfVoiceAbortSignalAborted(signal);
  const outputId = makeVoiceId("voice-output");
  const targetDir = await ensureDownloadDir(voiceOutputBaseDir(defaultDownloadDir, outputDir));
  throwIfVoiceAbortSignalAborted(signal);
    const filename = voiceOutputFilename(outputId, mode, profile.name, settings?.engineId || engine);
  const outputPath = path.join(targetDir, filename);
  const metadataPath = outputPath.replace(/\.wav$/i, ".meta.json");
  let output = null;
  try {
    await fs.writeFile(outputPath, audioBuffer);
    throwIfVoiceAbortSignalAborted(signal);
    const safeDurationSeconds = Math.max(0.5, Number(durationSeconds) || 2);
    const createdAt = new Date().toISOString();
    const audioHash = createHash("sha256").update(audioBuffer).digest("hex");
    const { vtvCandidates: _candidateArtifacts, ...persistedSettings } = settings || {};
    let audioFormat = null;
    try { audioFormat = parseWavInfo(audioBuffer); } catch {}
    const metadata = {
      schema_version: 2,
      pipeline_version: settings?.vtvPipelineVersion || settings?.pipelineVersion || "legacy",
      ai_generated: true,
      generated_by: "Magic Box Voice Clone",
      mode,
      profile_id: profile.id,
      profile_name: sanitizeUnicodeText(profile.name),
      language,
      requested_language: settings?.requestedLanguage || language,
      effective_language: settings?.effectiveLanguage || language,
      engine,
      model_version: settings?.modelVersion || voiceNeuralModelVersion,
      created_at: createdAt,
      output_sha256: audioHash,
      output_format: audioFormat ? {
        sample_rate: audioFormat.sampleRate,
        channels: audioFormat.channels,
        bits_per_sample: audioFormat.bitsPerSample,
        duration_seconds: Number(audioFormat.durationSeconds.toFixed(3))
      } : null,
      lineage: settings?.vtvLineage || settings?.lineage || null,
      reference_pack: settings?.vtvReferencePack || null,
      selected_seed: Number.isInteger(settings?.vtvCandidateSeed) ? settings.vtvCandidateSeed >>> 0 : null,
      candidate_quality: settings?.vtvQuality || null,
      quality_report: settings?.qualityReport || null,
      strict_validation_accepted: settings?.conversionStrictValidationAccepted === true
        || settings?.songIntegrity?.strictValidationAccepted === true,
      comparison_group_id: settings?.comparisonGroupId || null,
      engine_run_id: settings?.engineRunId || null,
      execution_status: settings?.executionStatus || (settings?.conversionNeedsReview === true ? "succeeded" : "succeeded"),
      quality_status: settings?.qualityStatus || (settings?.conversionNeedsReview === true ? "needs-review" : "not-evaluated"),
      target_artifact: settings?.targetArtifact || null,
      runtime_lineage: settings?.runtimeLineage || settings?.vtvLineage || null,
      shared_artifact_hashes: settings?.sharedArtifactHashes || null,
      final_mix_gate: settings?.finalMixGate || null,
      stem_gate: settings?.stemGate || null,
      input_summary: sanitizeUnicodeText(inputSummary),
      source_audio_name: sourceAudioName ? sanitizeUnicodeText(sourceAudioName) : null,
      safety_notice: "Synthetic voice generated from a consent-confirmed local profile."
    };
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
    throwIfVoiceAbortSignalAborted(signal);
    output = {
      id: outputId,
      mode,
      profileId: profile.id,
      profileName: profile.name,
      language,
      outputPath,
      outputFileName: filename,
      metadataPath,
      durationSeconds: Number(safeDurationSeconds.toFixed(3)),
      engine,
      textPreview: mode === "tts" ? inputSummary : "",
      sourceAudioName: sourceAudioName || "",
      aiGenerated: true,
      status: settings?.outputStatus || (settings?.qualityStatus === "rejected" ? "rejected" : settings?.qualityStatus === "needs-review" || settings?.conversionNeedsReview === true ? "needs-review" : "completed"),
      settings: publicVoiceOutputSettings(persistedSettings),
      createdAt
    };
    db.outputs.unshift(output);
    const lineage = settings?.lineage && typeof settings.lineage === "object" ? settings.lineage : {};
    if (settings?.qualityReport && typeof settings.qualityReport === "object") {
      const reports = Array.isArray(db.qualityReports) ? db.qualityReports : [];
      db.qualityReports = [
        {
          ...sanitizeStructuredText(settings.qualityReport),
          outputId,
          profileId: profile.id,
          createdAt
        },
        ...reports.filter((report) => report.outputId !== outputId)
      ].slice(0, 500);
    }
    if (Array.isArray(settings?.attempts)) {
      const persistedAttempts = Array.isArray(db.attempts) ? db.attempts : [];
      db.attempts = [
        ...settings.attempts.slice(0, 120).map((attempt, index) => ({
          attemptId: attempt.attemptId || `${outputId}-attempt-${index + 1}`,
          outputId,
          profileId: profile.id,
          stage: attempt.stage || "voice_generation",
          status: attempt.accepted === true ? "accepted" : "rejected",
          datasetSnapshotHash: lineage.datasetSnapshotHash || "",
          modelVersionId: lineage.modelVersionId || settings.modelVersionId || "",
          referencePackHash: lineage.referencePackHash || "",
          ...sanitizeStructuredText(attempt),
          createdAt
        })),
        ...persistedAttempts.filter((attempt) => attempt.outputId !== outputId)
      ].slice(0, 2000);
    }
    throwIfVoiceAbortSignalAborted(signal);
    await writeVoiceDb(db);
    throwIfVoiceAbortSignalAborted(signal);
    return output;
  } catch (error) {
    if (output) {
      await removeVoiceOutputRecord(db, output);
    } else {
      await Promise.all([
        fs.rm(outputPath, { force: true }),
        fs.rm(metadataPath, { force: true }),
      ].map((operation) => operation.catch(() => {})));
    }
    throw error;
  }
}

async function writeVoiceOutputForJob(job, options) {
  throwIfVoiceJobCancelled(job);
  const profileId = String(options.profile?.id || job.profileId || "voice-output");
  const output = await withVoiceProfileMutationLock(profileId, async () => {
    const latestDb = await readVoiceDb();
    const latestProfile = getVoiceProfile(latestDb, profileId);
    if (!latestProfile) {
      throw new Error("The target voice profile was deleted before this output could be saved.");
    }
    return writeVoiceOutputRecord({
      ...options,
      db: latestDb,
      profile: latestProfile,
      signal: job.abortController?.signal
    });
  });
  try {
    throwIfVoiceJobCancelled(job);
    return output;
  } catch (error) {
    await withVoiceProfileMutationLock(profileId, async () => {
      const latestDb = await readVoiceDb();
      await removeVoiceOutputRecord(latestDb, output);
    });
    throw error;
  }
}

function createVoiceJob(voiceJobs, type, payload = {}) {
  const job = {
    id: makeVoiceId("voice-job"),
    type,
    status: "pending",
    progress: 0,
    message: "Queued",
    result: null,
    error: null,
    diagnostics: null,
    ...payload,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null
  };
  Object.defineProperty(job, "abortController", {
    value: new AbortController(),
    enumerable: false
  });
  voiceJobs.set(job.id, job);
  persistVoiceJobSnapshot(job, { status: job.status, message: job.message });
  return job;
}

function updateVoiceJob(job, patch) {
  // A worker can still flush a buffered progress event while its process is
  // being terminated. Cancellation is terminal, so that late event must not
  // make the job appear to resume in the UI.
  if (job?.status === "cancelled" && patch?.status !== "cancelled") {
    return job;
  }
  Object.assign(job, sanitizeStructuredText(patch), { updatedAt: new Date().toISOString() });
  persistVoiceJobSnapshot(job, patch);
  return job;
}

function voiceJobSnapshot(job) {
  return sanitizeStructuredText({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    message: job.message,
    profileId: job.profileId || null,
    sampleId: job.sampleId || null,
    preparationRevision: Number(job.preparationRevision) || null,
    outputId: job.outputId || null,
    result: job.result ? {
      ...job.result,
      output: job.result.output ? publicVoiceOutput(job.result.output) : job.result.output
    } : null,
    error: job.error,
    diagnostics: job.diagnostics,
    quality: job.quality || job.terminalQuality || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt
  });
}

function voicePreparationJobResult(sample, preparationRevision, eligibleClipCount) {
  const preparation = normalizedVoicePreparation(sample);
  return {
    sampleId: sample.id,
    preparationRevision: Math.max(1, Math.round(Number(preparationRevision) || preparation.revision || 1)),
    preparationStatus: preparation.status,
    eligibleClipCount: Math.max(0, Math.round(Number(eligibleClipCount) || 0)),
    reviewClipCount: Array.isArray(sample.segments) ? sample.segments.length : 0
  };
}

function isVoiceJobTerminal(job) {
  return ["completed", "succeeded", "partial", "partial-cancelled", "needs-review", "rejected", "failed", "cancelled"].includes(job?.status);
}

function cancelVoiceJob(job) {
  if (!job || isVoiceJobTerminal(job)) {
    return false;
  }
  job.abortController?.abort();
  updateVoiceJob(job, {
    status: "cancelled",
    progress: Math.max(job.progress || 0, 1),
    message: "Cancelled",
    error: "Voice job cancelled.",
    finishedAt: new Date().toISOString()
  });
  if (job.type === "prepare-profile-source" && job.profileId && job.sampleId && job.preparationRevision) {
    // Cancellation can happen before the worker reaches its own cleanup path.
    // Move the source out of queued/preparing so the UI never promises work
    // that will no longer run, while retaining the original upload for retry.
    void markVoicePreparationNeedsAttention(
      String(job.profileId),
      String(job.sampleId),
      Math.max(1, Math.round(Number(job.preparationRevision) || 1)),
      "Voice Preparation was cancelled. The original source is safe; reprocess it when ready."
    ).catch(() => {});
  }
  return true;
}

function pruneVoiceJobs(voiceJobs) {
  const now = Date.now();
  for (const [id, job] of voiceJobs.entries()) {
    if (job.finishedAt && now - new Date(job.finishedAt).getTime() > voiceJobTtlMs) {
      voiceJobs.delete(id);
    }
  }
  while (voiceJobs.size > maxVoiceJobs) {
    const oldestCompleted = Array.from(voiceJobs.entries())
      .filter(([_id, job]) => job.finishedAt)
      .sort((left, right) => new Date(left[1].finishedAt).getTime() - new Date(right[1].finishedAt).getTime())[0];
    if (!oldestCompleted) {
      break;
    }
    voiceJobs.delete(oldestCompleted[0]);
  }
}

function throwIfVoiceJobCancelled(job) {
  if (job.status === "cancelled") {
    throw voiceJobCancelledError();
  }
}

async function runVoiceJob(job, steps) {
  if (["tts", "v2v"].includes(job.type) && !/^(0|false|off)$/i.test(process.env.VOICE_CLONE_JOB_WORKER_REUSE_ENABLED || "1")) {
    return withVoiceJobWorkers(createVoiceEngineWorkerSession, () => runVoiceJobSteps(job, steps));
  }
  return runVoiceJobSteps(job, steps);
}

async function runVoiceJobSteps(job, steps) {
  try {
    for (const step of steps) {
      throwIfVoiceJobCancelled(job);
      updateVoiceJob(job, {
        status: step.status || job.status,
        progress: step.progress,
        message: step.message || job.message
      });
      if (step.delay) {
        await sleep(step.delay);
      }
      if (step.run) {
        await step.run();
      }
    }
    if (!isVoiceJobTerminal(job)) {
      const terminalStatus = job.terminalStatus || "completed";
      updateVoiceJob(job, {
        status: terminalStatus,
        progress: 100,
        message: terminalStatus === "needs-review"
          ? "Needs review"
          : terminalStatus === "rejected"
            ? "Rejected"
            : terminalStatus === "failed"
              ? "Failed"
              : terminalStatus === "cancelled"
                ? "Cancelled"
                : terminalStatus === "partial" || terminalStatus === "partial-cancelled"
                  ? "Partial results"
                  : "Completed",
        ...(job.terminalQuality ? { quality: job.terminalQuality } : {}),
        finishedAt: new Date().toISOString()
      });
    }
  } catch (error) {
    if (job.status === "cancelled" || error.code === "VOICE_JOB_CANCELLED") {
      cancelVoiceJob(job);
      return;
    }
    const failureDiagnostics = error.voiceJobDiagnostics || (
      error.details && typeof error.details === "object"
        ? {
            errorCode: sanitizeUnicodeText(error.code || "").slice(0, 96),
            details: sanitizeStructuredText(error.details)
          }
        : null
    );
      updateVoiceJob(job, {
      status: error.voiceOutcomeStatus || "failed",
      progress: Math.max(job.progress || 0, 1),
      message: "Failed",
      error: sanitizeUnicodeText(error.message || "Voice job failed."),
      diagnostics: failureDiagnostics ? sanitizeStructuredText(failureDiagnostics) : null,
      finishedAt: new Date().toISOString()
    });
    const diagnosticSuffix = job.diagnostics
      ? ` diagnostics=${JSON.stringify(job.diagnostics)}`
      : "";
    warnDiagnostic(`Voice clone job failed: ${job.error}${diagnosticSuffix}`);
  } finally {
    if (job.inputDir && !retainVoiceJobTemp(job)) {
      await fs.rm(job.inputDir, { recursive: true, force: true }).catch(() => {});
      delete job.inputDir;
    } else if (job.inputDir) {
      job.inputDirRetained = true;
      warnDiagnostic(`Retaining voice job temp for debug policy ${voiceDebugRetentionPolicy()}: ${job.inputDir}`);
    }
  }
}

function voiceInstallManifest(engine = voiceNeuralEngineId) {
  if (engine === cosyVoiceStreamingEngineId) {
    return cosyVoiceStreamingInstallManifest;
  }
  if (engine === whisperTurboStreamingEngineId) {
    return whisperTurboStreamingInstallManifest;
  }
  if (engine === voicePreparationEngineId) {
    return voicePreparationInstallManifest;
  }
  if (engine === seedVcEngineId) {
    return seedVcInstallManifest;
  }
  return engine === gptSoVitsEngineId ? gptSoVitsInstallManifest : voiceModelInstallManifest;
}

async function runVoiceModelInstallJob(job, engine = voiceNeuralEngineId) {
  const manifest = voiceInstallManifest(engine);
  await runVoiceJob(job, [
    { status: "preprocessing", progress: 5, message: "Preparing neural model setup", delay: 80 },
    {
      status: "running",
      progress: 25,
        message: engine === voicePreparationEngineId
          ? "Installing local Voice Preparation runtime"
          : engine === gptSoVitsEngineId
        ? "Installing GPT-SoVITS local model package"
        : engine === seedVcEngineId
          ? "Installing Demucs + Seed-VC high-quality VTV runtime"
          : "Installing OpenVoice V2 local model package",
      delay: 80,
      run: async () => {
        const modelDir = voiceEngineModelDir(engine);
        const downloadsDir = path.join(modelDir, "downloads");
        await fs.mkdir(downloadsDir, { recursive: true });
        const startedAt = new Date().toISOString();

        if (process.env.MAGIC_BOX_VOICE_ENGINE_FAKE === "1") {
          const readyState = {
            engine,
            modelVersion: voiceEngineModelVersion(engine),
            installed: true,
            runtimeReady: true,
            workerSource: "fake",
            fake: true,
            artifacts: manifest.artifacts.map((artifact) => ({
              id: artifact.id,
              fileName: artifact.fileName,
              verified: true
            })),
            modelDir,
            runtimeDir: voiceEngineRuntimeDir(engine),
            startedAt,
            finishedAt: new Date().toISOString(),
            warnings: ["Using fake neural worker for automated tests."]
          };
          await fs.writeFile(path.join(modelDir, ".ready.json"), JSON.stringify(readyState, null, 2), "utf8");
          const installState = await writeVoiceEngineInstallState(readyState, engine);
          job.result = { installState };
          return;
        }

        if (engine === gptSoVitsEngineId || engine === seedVcEngineId || engine === voicePreparationEngineId || engine === cosyVoiceStreamingEngineId || engine === whisperTurboStreamingEngineId) {
          const isSeedVcInstall = engine === seedVcEngineId;
          const isPreparationInstall = engine === voicePreparationEngineId;
          const isStreamingInstall = engine === cosyVoiceStreamingEngineId || engine === whisperTurboStreamingEngineId;
          const engineLabel = isStreamingInstall ? "multilingual streaming voice" : isPreparationInstall ? "Voice Preparation" : isSeedVcInstall ? "high-quality VTV" : "GPT-SoVITS";
          const scriptPath = path.join(rootDir, "scripts", isStreamingInstall ? "install-voice-streaming.ps1" : isPreparationInstall ? "install-voice-preparation.ps1" : isSeedVcInstall ? "install-voice-seed-vc.ps1" : "install-voice-gpt-sovits.ps1");
          if (!await pathExists(scriptPath)) {
            throw new Error(`${engineLabel} installer was not found at ${scriptPath}. Rebuild the packaged app or run the repo script manually.`);
          }
          updateVoiceJob(job, { message: `Running ${engineLabel} installer`, progress: 35 });
          const powerShell = process.env.SystemRoot
            ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
            : "powershell.exe";
          await execFileAsync(powerShell, [
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", scriptPath,
            "-VoiceEngineRoot", voiceEngineRootDir()
          ], {
            windowsHide: true,
            timeout: isStreamingInstall ? 3 * 60 * 60 * 1000 : isSeedVcInstall ? 3 * 60 * 60 * 1000 : isPreparationInstall ? 90 * 60 * 1000 : 2 * 60 * 60 * 1000,
            maxBuffer: 8 * 1024 * 1024
          });
          const readyState = await readJsonFileIfExists(path.join(modelDir, ".ready.json"));
          const installState = await writeVoiceEngineInstallState({
            ...(readyState || {}),
            engine,
            modelVersion: voiceEngineModelVersion(engine),
            installed: true,
            runtimeReady: await voiceEngineRuntimeReady(engine),
            workerSource: voiceEngineWorkerCommand(engine).source,
            modelDir,
            runtimeDir: voiceEngineRuntimeDir(engine),
            startedAt,
            finishedAt: new Date().toISOString()
          }, engine);
          if (isStreamingInstall) {
            const pairedEngine = engine === cosyVoiceStreamingEngineId ? whisperTurboStreamingEngineId : cosyVoiceStreamingEngineId;
            const pairedReadyState = await readJsonFileIfExists(path.join(voiceEngineModelDir(pairedEngine), ".ready.json"));
            await writeVoiceEngineInstallState({
              ...(pairedReadyState || {}),
              engine: pairedEngine,
              modelVersion: voiceEngineModelVersion(pairedEngine),
              installed: true,
              runtimeReady: await voiceEngineRuntimeReady(pairedEngine),
              workerSource: voiceEngineWorkerCommand(pairedEngine).source,
              modelDir: voiceEngineModelDir(pairedEngine),
              runtimeDir: voiceEngineRuntimeDir(pairedEngine),
              startedAt,
              finishedAt: new Date().toISOString()
            }, pairedEngine);
          }
          job.result = { installState };
          return;
        }

        const artifacts = [];
        const warnings = [];
        for (const [index, artifact] of manifest.artifacts.entries()) {
          throwIfVoiceJobCancelled(job);
          const targetPath = artifact.targetPath
            ? path.join(modelDir, artifact.targetPath)
            : path.join(downloadsDir, artifact.fileName || `${artifact.id}.bin`);
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          const downloadBaseProgress = 25 + Math.round(index * (50 / manifest.artifacts.length));
          const downloadMaxProgress = 25 + Math.round((index + 1) * (50 / manifest.artifacts.length));
          updateVoiceJob(job, {
            progress: downloadBaseProgress,
            message: `Downloading ${artifact.id}`
          });
          try {
            await downloadVoiceArtifact(artifact, targetPath, {
              onProgress: ({ receivedBytes, totalBytes }) => {
                if (!totalBytes) {
                  return;
                }
                const ratio = Math.min(1, receivedBytes / totalBytes);
                updateVoiceJob(job, {
                  progress: Math.min(downloadMaxProgress, downloadBaseProgress + Math.round(ratio * (downloadMaxProgress - downloadBaseProgress))),
                  message: `Downloading ${artifact.id} (${Math.round(ratio * 100)}%)`
                });
              }
            });
          } catch (error) {
            if (artifact.required === false) {
              warnings.push(`Optional artifact ${artifact.id} was skipped: ${error.message}`);
              artifacts.push({
                id: artifact.id,
                fileName: artifact.fileName,
                path: targetPath,
                extractedPath: null,
                sha256: "",
                verified: false,
                optional: true,
                skipped: true
              });
              continue;
            }
            throw error;
          }

          let sha256 = "";
          let verified = false;
          if (artifact.sha256) {
            updateVoiceJob(job, { message: `Verifying ${artifact.id}`, progress: Math.min(82, downloadMaxProgress + 4) });
            sha256 = await sha256File(targetPath);
            if (sha256.toLowerCase() !== artifact.sha256.toLowerCase()) {
              throw new Error(`SHA256 mismatch for ${artifact.id}.`);
            }
            verified = true;
          }
          updateVoiceJob(job, { message: `Extracting ${artifact.id}`, progress: Math.min(90, downloadMaxProgress + 8) });
          const extractedPath = await expandVoiceArtifactIfNeeded(artifact, targetPath, modelDir);
          artifacts.push({
            id: artifact.id,
            fileName: artifact.fileName,
            path: targetPath,
            extractedPath,
            sha256,
            verified: verified || !artifact.sha256
          });
        }

        const runtimeReady = await voiceEngineRuntimeReady(engine);
        const workerSource = voiceEngineWorkerCommand(engine).source;
        const readyState = {
          engine,
          modelVersion: voiceEngineModelVersion(engine),
          installed: true,
          runtimeReady,
          workerSource,
          artifacts,
          modelDir,
          runtimeDir: voiceEngineRuntimeDir(engine),
          startedAt,
          finishedAt: new Date().toISOString(),
          warnings: runtimeReady ? warnings : [
            ...warnings,
            "Model files are installed, but the managed Python OpenVoice worker is not ready yet."
          ]
        };
        await fs.writeFile(path.join(modelDir, ".ready.json"), JSON.stringify(readyState, null, 2), "utf8");
        const installState = await writeVoiceEngineInstallState(readyState, engine);
        job.result = { installState };
      }
    }
  ]);
}

async function runVoiceAnalyzeJob(job, profileId) {
  await runVoiceJob(job, [
    { status: "preprocessing", progress: 12, message: "Reading samples", delay: 120 },
    {
      status: "running",
      progress: 60,
      message: "Scoring sample quality",
      delay: 180,
      run: async () => {
        const snapshotDb = await readVoiceDb();
        const snapshotProfile = getVoiceProfile(snapshotDb, profileId);
        if (!snapshotProfile) {
          throw new Error("Voice profile was not found.");
        }
        const snapshots = snapshotDb.samples
          .filter((sample) => sample.profileId === profileId)
          .map((sample) => ({ originalUpdatedAt: sample.updatedAt, analyzed: cloneVoiceRecord(sample) }));
        for (const snapshot of snapshots) {
          await reanalyzeVoiceSample(snapshotProfile, snapshot.analyzed);
        }
        await withVoiceProfileMutationLock(profileId, async () => {
          const db = await readVoiceDb();
          const profile = getVoiceProfile(db, profileId);
          if (!profile) {
            throw new Error("Voice profile was deleted before analysis finished.");
          }
          const analysisFields = [
            "durationSeconds", "speechSeconds", "sampleRate", "channels", "format",
            "noiseScore", "clippingDetected", "silenceRatio", "qualityScore", "warnings"
          ];
          for (const snapshot of snapshots) {
            const current = db.samples.find((sample) => sample.id === snapshot.analyzed.id && sample.profileId === profileId);
            if (!current || current.updatedAt !== snapshot.originalUpdatedAt) {
              continue;
            }
            for (const field of analysisFields) {
              const value = snapshot.analyzed[field];
              current[field] = value && typeof value === "object" ? cloneVoiceRecord(value) : value;
            }
            current.updatedAt = snapshot.analyzed.updatedAt;
          }
          const samples = db.samples.filter((sample) => sample.profileId === profileId);
          const aggregate = aggregateVoiceSampleQuality(samples);
          Object.assign(profile, {
            status: profile.voiceModel?.engine ? "ready" : samples.length ? "analyzed" : "draft",
            totalSpeechSeconds: aggregate.totalSpeechSeconds,
            qualityScore: aggregate.qualityScore,
            analysisWarnings: aggregate.warnings,
            updatedAt: new Date().toISOString()
          });
          job.result = {
            profile: publicVoiceProfile(profile, samples),
            warnings: aggregate.warnings
          };
          await writeVoiceDb(db);
        });
      }
    }
  ]);
}

function preparationResultPath(candidateDir, finalDir, value) {
  if (!value || !pathIsInside(candidateDir, value)) {
    return "";
  }
  return path.join(finalDir, path.relative(candidateDir, value));
}

function normalizePreparedTrainingClip(profile, sample, segment, index, candidateDir, finalDir) {
  const durationSeconds = Math.max(0, Number(segment?.durationSeconds) || 0);
  const startSeconds = Math.max(0, Number(segment?.startSeconds) || 0);
  const endSeconds = Math.max(startSeconds, Number(segment?.endSeconds) || (startSeconds + durationSeconds));
  const transcript = normalizeVoiceTranscript(segment?.transcript);
  const speechConfidence = Math.max(0, Math.min(1, Number(segment?.speechConfidence) || 0));
  const transcriptConfidence = Math.max(0, Math.min(1, Number(segment?.transcriptConfidence) || 0));
  const boundary = segment?.boundary === "complete" ? "complete" : "uncertain";
  const boundaryConfidence = Math.max(0, Math.min(1, Number(segment?.boundaryConfidence) || (boundary === "complete" ? 1 : 0)));
  const audioPath = preparationResultPath(candidateDir, finalDir, segment?.audioPath);
  const reasons = Array.isArray(segment?.exclusionReasons)
    ? segment.exclusionReasons.map((reason) => sanitizeUnicodeText(reason)).filter(Boolean).slice(0, 12)
    : [];
  if (!transcript && !reasons.includes("no_speech_detected")) {
    reasons.push("no_speech_detected");
  }
  if (durationSeconds < 2.5 && !reasons.includes("clip_too_short")) {
    reasons.push("clip_too_short");
  }
  if (durationSeconds > 10 && !reasons.includes("sentence_too_long")) {
    reasons.push("sentence_too_long");
  }
  if (speechConfidence < 0.65 && !reasons.includes("speech_confidence_low")) {
    reasons.push("speech_confidence_low");
  }
  if (transcriptConfidence < 0.82 && !reasons.includes("transcript_confidence_low")) {
    reasons.push("transcript_confidence_low");
  }
  if ((boundary !== "complete" || boundaryConfidence < 0.85) && !reasons.includes("uncertain_sentence_boundary")) {
    reasons.push("uncertain_sentence_boundary");
  }
  const eligible = Boolean(
    audioPath
    && transcript
    && durationSeconds >= 2.5
    && durationSeconds <= 10
    && speechConfidence >= 0.65
    && transcriptConfidence >= 0.82
    && boundary === "complete"
    && boundaryConfidence >= 0.85
    && !reasons.length
  );
  const rejected = reasons.includes("no_speech_detected") || !audioPath;
  return {
    id: makeVoiceId("voice-segment"),
    sampleId: sample.id,
    profileId: profile.id,
    index,
    audioPath,
    startSeconds: Number(startSeconds.toFixed(3)),
    endSeconds: Number(endSeconds.toFixed(3)),
    durationSeconds: Number(durationSeconds.toFixed(3)),
    transcript,
    transcriptLanguage: normalizeTranscriptLanguage(segment?.transcriptLanguage, profile.language),
    speechConfidence: Number(speechConfidence.toFixed(3)),
    transcriptConfidence: Number(transcriptConfidence.toFixed(3)),
    boundary,
    boundaryConfidence: Number(boundaryConfidence.toFixed(3)),
    qualityVerdict: eligible ? "eligible" : rejected ? "rejected" : "needs-review",
    exclusionReasons: Array.from(new Set(reasons)),
    includeInTraining: eligible,
    preferredPrompt: Boolean(segment?.preferredPrompt && eligible),
    createdAt: new Date().toISOString()
  };
}

async function markVoicePreparationNeedsAttention(profileId, sampleId, revision, message) {
  return withVoiceProfileMutationLock(profileId, async () => {
    const db = await readVoiceDb();
    const profile = getVoiceProfile(db, profileId);
    const sample = db.samples.find((item) => item.profileId === profileId && item.id === sampleId);
    if (!profile || !sample || normalizedVoicePreparation(sample).revision !== revision) {
      return null;
    }
    const preparation = normalizedVoicePreparation(sample);
    const failureMessage = sanitizeUnicodeText(message || "Voice Preparation did not complete.").slice(0, 600);
    sample.preparation = {
      ...preparation,
      status: "needs-attention",
      failureMessage,
      failureDismissedAt: "",
      warnings: Array.from(new Set([
        ...(preparation.warnings || []).filter((warning) => warning !== preparation.failureMessage),
        failureMessage
      ])).slice(0, 20)
    };
    sample.updatedAt = new Date().toISOString();
    const aggregate = aggregateVoiceSampleQuality(db.samples.filter((item) => item.profileId === profileId));
    Object.assign(profile, {
      status: profile.voiceModel?.engine ? "ready" : "draft",
      totalSpeechSeconds: aggregate.totalSpeechSeconds,
      qualityScore: aggregate.qualityScore,
      analysisWarnings: aggregate.warnings,
      updatedAt: new Date().toISOString()
    });
    await writeVoiceDb(db);
    return {
      profile: publicVoiceProfile(profile, db.samples),
      sample: publicVoiceSample(sample, profile.language)
    };
  });
}

async function dismissVoicePreparationFailure(profileId, sampleId, revision) {
  return withVoiceProfileMutationLock(profileId, async () => {
    const db = await readVoiceDb();
    const profile = getVoiceProfile(db, profileId);
    const sample = db.samples.find((item) => item.profileId === profileId && item.id === sampleId);
    if (!profile || !sample) {
      return null;
    }
    const preparation = normalizedVoicePreparation(sample);
    if (revision && preparation.revision !== revision) {
      return null;
    }
    const failureMessage = preparation.failureMessage;
    sample.preparation = {
      ...preparation,
      failureMessage: "",
      failureDismissedAt: new Date().toISOString(),
      warnings: (preparation.warnings || []).filter((warning) => warning !== failureMessage)
    };
    sample.updatedAt = new Date().toISOString();
    profile.updatedAt = new Date().toISOString();
    await writeVoiceDb(db);
    return {
      profile: publicVoiceProfile(profile, db.samples),
      sample: publicVoiceSample(sample, profile.language)
    };
  });
}

async function runVoiceProfilePreparationJob(job, profileId, sampleId, preparationRevision, { reusePreparedVocal = false } = {}) {
  const revision = Math.max(1, Math.round(Number(preparationRevision) || 1));
  return runVoiceJob(job, [
    { status: "preprocessing", progress: 8, message: "Checking local Voice Preparation", delay: 20 },
    {
      status: "preparing",
      progress: 18,
      message: "Separating vocal from background music",
      run: async () => {
        const candidateDir = voicePreparationCandidateFolder(profileId, sampleId, revision, job.id);
        try {
          await withVoicePreparationLock(profileId, sampleId, async () => {
            const preparationInput = await withVoiceProfileMutationLock(profileId, async () => {
              throwIfVoiceJobCancelled(job);
              const startingDb = await readVoiceDb();
              const startingProfile = getVoiceProfile(startingDb, profileId);
              const startingSample = startingDb.samples.find((item) => item.profileId === profileId && item.id === sampleId);
              if (!startingProfile || !startingSample) {
                throw new Error("Voice source was not found.");
              }
              if (normalizedVoicePreparation(startingSample).revision !== revision) {
                job.result = { stale: true, sampleId, preparationRevision: revision };
                return null;
              }
              const startingPreparation = normalizedVoicePreparation(startingSample);
              const trimScope = voiceSampleTrimScope(startingSample);
              const canReusePreparedVocal = Boolean(
                reusePreparedVocal
                && preparedVoiceAudioMatchesTrim(startingSample, startingPreparation)
                && startingPreparation.vocalPath
                && startingPreparation.accompanimentPath
                && pathIsInside(voiceDataRootDir(), startingPreparation.vocalPath)
                && pathIsInside(voiceDataRootDir(), startingPreparation.accompanimentPath)
                && await pathExists(startingPreparation.vocalPath)
                && await pathExists(startingPreparation.accompanimentPath)
              );
              startingSample.preparation = {
                ...startingPreparation,
                status: "preparing",
                warnings: [],
                failureMessage: "",
                failureDismissedAt: ""
              };
              startingSample.updatedAt = new Date().toISOString();
              startingProfile.updatedAt = new Date().toISOString();
              await writeVoiceDb(startingDb);
              return {
                profile: {
                  id: startingProfile.id,
                  language: startingProfile.language
                },
                sample: {
                  id: startingSample.id,
                  profileId: startingSample.profileId,
                  storedPath: startingSample.storedPath,
                  durationSeconds: startingSample.durationSeconds,
                  trimApplied: trimScope.applied,
                  trimStartSeconds: trimScope.start,
                  trimEndSeconds: trimScope.end,
                  transcript: startingSample.transcript,
                  preparedVocalPath: canReusePreparedVocal ? startingPreparation.vocalPath : "",
                  preparedAccompanimentPath: canReusePreparedVocal ? startingPreparation.accompanimentPath : ""
                }
              };
            });
            if (!preparationInput) {
              return;
            }

            const preparationHealth = await assertVoicePreparationReady();
            const preparationDevice = preparationHealth.engines?.voicePreparationLocal?.device || "cpu";
            throwIfVoiceJobCancelled(job);
            await fs.rm(candidateDir, { recursive: true, force: true }).catch(() => {});
            await fs.mkdir(candidateDir, { recursive: true });
            const result = await callVoiceEngineWorker({
              action: "prepare-profile-source",
              profileId,
              sampleId,
              revision,
              sourceAudioPath: preparationInput.sample.storedPath,
              sourceDurationSeconds: preparationInput.sample.durationSeconds,
              trimApplied: preparationInput.sample.trimApplied,
              trimStartSeconds: preparationInput.sample.trimStartSeconds,
              trimEndSeconds: preparationInput.sample.trimEndSeconds,
              fixtureTranscript: normalizeVoiceTranscript(preparationInput.sample.transcript),
              preparedVocalPath: preparationInput.sample.preparedVocalPath,
              preparedAccompanimentPath: preparationInput.sample.preparedAccompanimentPath,
              outputDir: candidateDir,
              language: normalizeVoiceLanguage(preparationInput.profile.language),
              minClipSeconds: 2.5,
              maxClipSeconds: 10,
              minimumSpeechConfidence: 0.65,
              minimumTranscriptConfidence: 0.82,
              minimumBoundaryConfidence: 0.85
            }, {
              engine: voicePreparationEngineId,
              ...voicePreparationWorkerTimeoutOptions(preparationInput.sample.durationSeconds, preparationDevice),
              signal: job.abortController?.signal,
              onProgress: (event) => {
                updateVoiceJob(job, {
                  status: event.stage || "preparing",
                  progress: Math.max(18, Math.min(94, Number(event.progress) || 18)),
                  message: event.message || job.message
                });
              }
            });
            throwIfVoiceJobCancelled(job);

            const vocalPath = await normalizeVoicePreparationArtifactPath(candidateDir, result?.vocalPath);
            const accompanimentPath = await normalizeVoicePreparationArtifactPath(candidateDir, result?.accompanimentPath);
            if (!vocalPath || !accompanimentPath) {
              throw new Error("Voice Preparation returned an invalid derived-audio location.");
            }
            if (!await pathExists(vocalPath) || !await pathExists(accompanimentPath)) {
              throw new Error("Voice Preparation did not produce both vocal and accompaniment artifacts.");
            }
            const finalDir = voicePreparationRevisionFolder(profileId, sampleId, revision);
            // Keep every sentence returned for normal long-form sources. The
            // previous 80-item slice silently discarded the remainder of a
            // transcript and left long recordings represented by only their
            // opening minutes.
            const workerSegments = voicePreparationSegments(result?.segments);
            const rawSegments = await Promise.all(workerSegments.map(async (segment) => ({
              ...segment,
              audioPath: segment?.audioPath
                ? await normalizeVoicePreparationArtifactPath(candidateDir, segment.audioPath)
                : ""
            })));
            const preparedSegments = rawSegments.map((segment, index) => normalizePreparedTrainingClip(preparationInput.profile, preparationInput.sample, segment, index, candidateDir, finalDir));
            for (const segment of preparedSegments.filter((segment) => segment.qualityVerdict === "eligible")) {
              const candidateSegmentPath = segment.audioPath ? path.join(candidateDir, path.relative(finalDir, segment.audioPath)) : "";
              if (!candidateSegmentPath || !pathIsInside(candidateDir, candidateSegmentPath) || !await pathExists(candidateSegmentPath)) {
                throw new Error("Voice Preparation returned an eligible clip without a durable prepared-vocal artifact.");
              }
            }

            const committed = await withVoiceProfileMutationLock(profileId, async () => {
              throwIfVoiceJobCancelled(job);
              const commitDb = await readVoiceDb();
              const commitProfile = getVoiceProfile(commitDb, profileId);
              const commitSample = commitDb.samples.find((item) => item.profileId === profileId && item.id === sampleId);
              if (!commitProfile || !commitSample || normalizedVoicePreparation(commitSample).revision !== revision || normalizedVoicePreparation(commitSample).status !== "preparing") {
                job.result = { stale: true, sampleId, preparationRevision: revision };
                return false;
              }
              const profileBeforeCommit = cloneVoiceRecord(commitProfile);
              const sampleBeforeCommit = cloneVoiceRecord(commitSample);
              let candidateMoved = false;
              await fs.mkdir(path.dirname(finalDir), { recursive: true });
              throwIfVoiceJobCancelled(job);
              if (await pathExists(finalDir)) {
                throw new Error("Voice Preparation revision already has a committed artifact directory. Reprocess the source to create a new revision.");
              }
              try {
                await fs.rename(candidateDir, finalDir);
                candidateMoved = true;
                throwIfVoiceJobCancelled(job);
                const eligibleClipCount = preparedSegments.filter((segment) => segment.qualityVerdict === "eligible").length;
                const warnings = Array.isArray(result?.warnings)
                  ? result.warnings.map((warning) => sanitizeUnicodeText(warning)).slice(0, 20)
                  : [];
                if (!eligibleClipCount) {
                  warnings.push("No sentence clip passed the local training-quality gate. Review the rejected or uncertain clips, then reprocess this source.");
                }
                commitSample.preparation = {
                  revision,
                  status: eligibleClipCount ? "ready" : "needs-attention",
                  vocalPath: preparationResultPath(candidateDir, finalDir, vocalPath),
                  accompanimentPath: preparationResultPath(candidateDir, finalDir, accompanimentPath),
                  runtime: sanitizeStructuredText(result?.runtime || { engine: voicePreparationEngineId, modelVersion: voicePreparationModelVersion }),
                  warnings: Array.from(new Set(warnings)),
                  failureMessage: "",
                  failureDismissedAt: "",
                  completedAt: new Date().toISOString()
                };
                commitSample.segments = preparedSegments;
                commitSample.updatedAt = new Date().toISOString();
                const aggregate = aggregateVoiceSampleQuality(commitDb.samples.filter((item) => item.profileId === profileId));
                Object.assign(commitProfile, {
                  status: commitProfile.voiceModel?.engine ? "ready" : "analyzed",
                  totalSpeechSeconds: aggregate.totalSpeechSeconds,
                  qualityScore: aggregate.qualityScore,
                  analysisWarnings: aggregate.warnings,
                  updatedAt: new Date().toISOString()
                });
                throwIfVoiceJobCancelled(job);
                await writeVoiceDb(commitDb);
                throwIfVoiceJobCancelled(job);
                // The profile API owns full, editable transcript data. A job
                // snapshot is a diagnostic/progress surface, so keep it to
                // bounded preparation status rather than echoing raw audio
                // paths or the source's full transcript.
                job.result = voicePreparationJobResult(commitSample, revision, eligibleClipCount);
                return true;
              } catch (error) {
                restoreVoiceRecord(commitProfile, profileBeforeCommit);
                restoreVoiceRecord(commitSample, sampleBeforeCommit);
                await writeVoiceDb(commitDb).catch(() => {});
                if (candidateMoved) {
                  await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
                }
                throw error;
              }
            });
            if (!committed) {
              await fs.rm(candidateDir, { recursive: true, force: true }).catch(() => {});
            }
          });
        } catch (error) {
          await fs.rm(candidateDir, { recursive: true, force: true }).catch(() => {});
          await markVoicePreparationNeedsAttention(
            profileId,
            sampleId,
            revision,
            voicePreparationFailureWarning(error)
          ).catch(() => {});
          throw error;
        }
      }
    }
  ]);
}

function voiceProfileTrainingInputFingerprint(profile, samples) {
  const normalizedSamples = (Array.isArray(samples) ? samples : [])
    .map((sample) => ({
      id: sample.id,
      updatedAt: sample.updatedAt || "",
      transcript: normalizeVoiceTranscript(sample.transcript),
      transcriptLanguage: normalizeTranscriptLanguage(sample.transcriptLanguage, profile?.language),
      trimStartSeconds: sample.trimStartSeconds ?? null,
      trimEndSeconds: sample.trimEndSeconds ?? null,
      preparation: normalizedVoicePreparation(sample),
      segments: (Array.isArray(sample.segments) ? sample.segments : [])
        .map((segment) => ({
          id: segment.id,
          audioPath: segment.audioPath || "",
          transcript: normalizeVoiceTranscript(segment.transcript),
          transcriptLanguage: normalizeTranscriptLanguage(segment.transcriptLanguage, profile?.language),
          qualityVerdict: segment.qualityVerdict || "",
          boundary: segment.boundary || "",
          includeInTraining: segment.includeInTraining !== false,
          preferredPrompt: Boolean(segment.preferredPrompt),
          updatedAt: segment.updatedAt || ""
        }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return createHash("sha256").update(JSON.stringify({
    profile: {
      id: profile?.id || "",
      language: profile?.language || "",
      updatedAt: profile?.updatedAt || "",
      activeModelVersionId: profile?.activeModelVersionId || "",
      voiceModel: {
        engine: profile?.voiceModel?.engine || "",
        versionId: profile?.voiceModel?.versionId || "",
        gptWeightsPath: profile?.voiceModel?.gptWeightsPath || "",
        sovitsWeightsPath: profile?.voiceModel?.sovitsWeightsPath || ""
      }
    },
    samples: normalizedSamples
  }), "utf8").digest("hex");
}

async function runVoiceBuildJob(job, profileId, qualityMode, engine, { acquireFineTrainingResources = null } = {}) {
  const isGptSoVitsFine = engine === gptSoVitsEngineId && qualityMode === "fine";
  await runVoiceJob(job, [
    { status: "preprocessing", progress: 15, message: engine === gptSoVitsEngineId ? (isGptSoVitsFine ? "Preparing GPT-SoVITS training clips" : "Preparing GPT-SoVITS prompt audio") : "Preparing OpenVoice V2 reference audio", delay: 120 },
    {
      status: "running",
      progress: isGptSoVitsFine ? 30 : 72,
      message: isGptSoVitsFine ? "Starting GPT-SoVITS Fine Clone training" : "Building neural voice profile",
      delay: 220,
      run: async () => {
        const db = await readVoiceDb();
        const profile = getVoiceProfile(db, profileId);
        if (!profile) {
          throw new Error("Voice profile was not found.");
        }
        const samples = db.samples.filter((sample) => sample.profileId === profileId);
        if (!samples.length) {
          throw new Error("Upload at least one voice sample before building a profile.");
        }
        const selectedEngine = normalizeVoiceEngine(engine || profile.engine, { language: profile.language });
        const datasetSnapshotHash = voiceDatasetSnapshotHash(profile, samples, selectedEngine);
        if (qualityMode === "fine" && selectedEngine === gptSoVitsEngineId && process.env.MAGIC_BOX_VOICE_ENGINE_FAKE !== "1") {
          const datasetGate = validateFineDataset(samples);
          if (!datasetGate.valid) {
            const error = new Error(`Fine Clone dataset is not ready: ${datasetGate.missing.join("; ")}.`);
            error.code = voiceCloneErrorCodes.fineDatasetInsufficient;
            error.details = datasetGate;
            throw error;
          }
        }
        const modelBuildId = makeVoiceId("voice-model");
        const trainingInputFingerprint = voiceProfileTrainingInputFingerprint(profile, samples);
        throwIfVoiceJobCancelled(job);
        let fineTrainingResources = null;
        let builtProfileModel = null;
        try {
          if (qualityMode === "fine" && selectedEngine === gptSoVitsEngineId && acquireFineTrainingResources) {
            updateVoiceJob(job, {
              status: "running",
              progress: 30,
              message: "Waiting for exclusive GPU access for Fine Training"
            });
            fineTrainingResources = await acquireFineTrainingResources({ job, signal: job.abortController?.signal });
            job.diagnostics = {
              ...(job.diagnostics || {}),
              resourceCoordination: fineTrainingResources.diagnostics || {}
            };
          }
          builtProfileModel = await buildVoiceProfileModel(profile, samples, {
            qualityMode,
            engine: selectedEngine,
            modelBuildId,
            signal: job.abortController?.signal,
            onProgress: (event) => {
              const progress = Math.max(30, Math.min(96, Math.round(Number(event.progress) || job.progress || 30)));
              updateVoiceJob(job, {
                status: "running",
                progress,
                message: event.message || job.message,
                diagnostics: event.trainingProgress ? {
                  ...(job.diagnostics || {}),
                  resourceCoordination: job.diagnostics?.resourceCoordination || {},
                  trainingProgress: event.trainingProgress
                } : job.diagnostics
              });
            }
          });
        } finally {
          await fineTrainingResources?.release?.();
        }
        const { voiceModel, aggregate, warnings } = builtProfileModel;
        throwIfVoiceJobCancelled(job);
        await withVoiceProfileMutationLock(profileId, async () => {
          throwIfVoiceJobCancelled(job);
          const commitDb = await readVoiceDb();
          const commitProfile = getVoiceProfile(commitDb, profileId);
          const commitSamples = commitDb.samples.filter((sample) => sample.profileId === profileId);
          if (!commitProfile || voiceProfileTrainingInputFingerprint(commitProfile, commitSamples) !== trainingInputFingerprint) {
            throw new Error("Profile sources changed while this model was building. The stale build was not activated; review the latest clips and start the build again.");
          }
          const profileBeforeCommit = cloneVoiceRecord(commitProfile);
          try {
            throwIfVoiceJobCancelled(job);
          const savedVersion = createVoiceModelVersion(commitProfile, voiceModel, modelBuildId);
          const previousVersions = normalizeVoiceModelVersions(commitProfile);
          const modelVersions = [
            savedVersion,
            ...previousVersions.filter((version) => version.id !== savedVersion.id)
          ].slice(0, 30).map((version) => ({
            ...version,
            active: version.id === savedVersion.id
          }));
          Object.assign(commitProfile, {
            status: "ready",
            engine: selectedEngine,
            qualityMode,
            voiceModel: {
              ...voiceModel,
              datasetSnapshotHash,
              datasetSnapshot: {
                schemaVersion: "voice-clone-pipeline-v2",
                hash: datasetSnapshotHash,
                profileId,
                capturedAt: new Date().toISOString()
              },
              versionId: savedVersion.id
            },
            modelVersion: voiceEngineModelVersion(selectedEngine),
            activeModelVersionId: savedVersion.id,
            modelVersions,
            totalSpeechSeconds: aggregate.totalSpeechSeconds,
            qualityScore: aggregate.qualityScore,
            analysisWarnings: warnings,
            updatedAt: new Date().toISOString()
          });
          if (commitProfile.voiceModel?.referencePack) {
            commitDb.referencePacks = [
              {
                ...sanitizeStructuredText(commitProfile.voiceModel.referencePack),
                profileId,
                modelVersionId: savedVersion.id,
                datasetSnapshotHash,
                updatedAt: new Date().toISOString()
              },
              ...(Array.isArray(commitDb.referencePacks) ? commitDb.referencePacks : [])
                .filter((pack) => pack.profileId !== profileId || pack.modelVersionId !== savedVersion.id)
            ].slice(0, 200);
          }
          throwIfVoiceJobCancelled(job);
          await writeVoiceDb(commitDb);
          throwIfVoiceJobCancelled(job);
          job.result = {
            profile: publicVoiceProfile(commitProfile, commitSamples),
            warnings
          };
          } catch (error) {
            restoreVoiceRecord(commitProfile, profileBeforeCommit);
            await writeVoiceDb(commitDb).catch(() => {});
            throw error;
          }
        });
      }
    }
  ]);
}

async function runVoiceTtsJob(job, defaultDownloadDir, payload, runtime = {}) {
  const conversationMode = payload.settings?.conversationMode === true;
  await runVoiceJob(job, [
    { status: "preprocessing", progress: 12, message: "Parsing emotion tags", delay: conversationMode ? 0 : 120 },
    {
      status: "running",
      progress: 68,
      message: "Generating local speech output",
      delay: conversationMode ? 0 : 280,
      run: async () => {
        const db = await readVoiceDb();
        const profile = getVoiceProfile(db, payload.profileId);
        if (!profile) {
          throw new Error("Voice profile was not found.");
        }
        if (profile.status !== "ready" || !profile.voiceModel?.engine) {
          throw new Error("Build this Target Voice Profile with a local neural engine before generating audio.");
        }
        const lineageCheck = await validateVoiceGenerationLineage(
          profile,
          db.samples.filter((sample) => sample.profileId === profile.id),
          payload.settings
        );
        const parsed = parseEmotionSegments(payload.text);
        if (!parsed.segments.length) {
          throw new Error("Enter text to generate.");
        }
        const speechText = speechTextFromSegments(parsed.segments);
        throwIfVoiceJobCancelled(job);
        const synthesized = await synthesizeVoiceSpeech({
          text: speechText,
          language: payload.language,
          profile,
          settings: payload.settings,
          parsedSegments: parsed.segments,
          onProgress: (event) => updateVoiceJob(job, {
            status: "running",
            progress: Math.max(68, Math.min(96, Math.round(Number(event.progress) || 68))),
            message: event.message || job.message
          }),
          signal: job.abortController?.signal,
          acquireSeedVcResources: runtime.acquireSeedVcResources
        });
        throwIfVoiceJobCancelled(job);
        const synthesisWarnings = [...lineageCheck.warnings, ...(synthesized.warnings || [])];
        const effectiveLanguage = synthesized.language || resolveVoiceLanguage({
          requestedLanguage: payload.language,
          profileLanguage: profile.language,
          text: speechText
        });
        const output = await writeVoiceOutputForJob(job, {
          db,
          defaultDownloadDir,
          outputDir: payload.outputDir,
          mode: "tts",
          profile,
          language: effectiveLanguage,
          inputSummary: textPreview(payload.text, 140),
          durationSeconds: synthesized.durationSeconds,
          audioBuffer: synthesized.buffer,
          engine: synthesized.engine,
          settings: {
            ...payload.settings,
            modelVersion: synthesized.modelVersion,
            requestedLanguage: payload.language,
            effectiveLanguage,
            parserWarningCount: parsed.warnings.length,
            synthesisWarningCount: synthesisWarnings.length,
            qualityMode: lineageCheck.qualityMode,
            pipeline: synthesized.pipeline || (lineageCheck.flags.pipelineV2 ? "pipeline_v2" : "legacy"),
            generationPath: synthesized.generationPath || "gpt_direct",
            eligibleForPromotion: lineageCheck.eligibleForPromotion && synthesized.eligibleForPromotion !== false,
            datasetSnapshotHash: lineageCheck.lineage.modelSnapshotHash || lineageCheck.lineage.currentSnapshotHash,
            modelState: lineageCheck.lineage.modelState,
            lineage: {
              datasetSnapshotHash: lineageCheck.lineage.modelSnapshotHash || lineageCheck.lineage.currentSnapshotHash,
              modelState: lineageCheck.lineage.modelState,
              modelVersionId: profile.voiceModel?.versionId || "",
              checkpointHash: profile.voiceModel?.checkpointHash || profile.voiceModel?.modelHash || "",
              referencePackId: profile.voiceModel?.referencePacks?.seedInference?.referencePackId
                || profile.voiceModel?.referencePack?.referencePackId
                || "",
              referencePackHash: profile.voiceModel?.referencePacks?.seedInference?.sha256
                || profile.voiceModel?.referencePack?.sha256
                || "",
              referenceState: lineageCheck.eligibleForPromotion ? "complete" : "degraded",
              qualityPolicyVersion: synthesized.qualityReport?.policyVersion || voiceQualityPolicyVersion
            },
            qualityReport: synthesized.qualityReport || createVoiceQualityReport({
              qualityMode: lineageCheck.qualityMode,
              flags: lineageCheck.flags,
              content: evaluateContentPolicy({
                primaryAsr: { coverage: Number(synthesized.synthesisIntegrity?.coverage) || 0 },
                expectedText: speechText,
                qualityMode: lineageCheck.qualityMode
              }),
              identity: evaluateIdentityPolicy({ required: lineageCheck.flags.dualSpeakerGate === true, qualityMode: lineageCheck.qualityMode }),
              perceptual: evaluatePerceptualPolicy({}, { required: lineageCheck.flags.perceptualGate === true, qualityMode: lineageCheck.qualityMode }),
              artifacts: evaluateArtifactPolicy(synthesized.synthesisIntegrity?.waveformHealth, { qualityMode: lineageCheck.qualityMode })
            }),
            ...(synthesized.synthesisIntegrity ? { synthesisIntegrity: synthesized.synthesisIntegrity } : {}),
            ...(synthesized.gptSoVitsRequest ? { gptSoVitsRequest: synthesized.gptSoVitsRequest } : {})
          }
        });
        job.outputId = output.id;
        job.result = {
          output,
          warnings: [...parsed.warnings, ...synthesisWarnings]
        };
      }
    }
  ]);
}

async function runVoiceV2vJob(job, defaultDownloadDir, payload) {
  const conversionEngine = normalizeV2vEngine(payload.settings?.conversionEngine || payload.settings?.conversion_engine);
  const highQualityV2v = conversionEngine === seedVcEngineId;
  const vtvPipelineEnabled = voiceCloneFeatureFlags(process.env).vtvPipelineV2 !== false;
  await runVoiceJob(job, [
    { status: "preprocessing", progress: 16, message: "Preparing source audio", delay: 120 },
    {
      status: "running",
      progress: 70,
      message: highQualityV2v ? "Converting with Seed-VC while preserving pitch and timing" : "Converting with OpenVoice V2",
      delay: 280,
      run: async () => {
        const db = await readVoiceDb();
        const profile = getVoiceProfile(db, payload.profileId);
        if (!profile) {
          throw new Error("Voice profile was not found.");
        }
        const conversionWarnings = [...(payload.warnings || [])];
        const resolved = highQualityV2v
          ? resolveVoiceProfileForSeedV2v(profile, payload.modelVersionId)
          : resolveVoiceProfileForV2v(profile, payload.modelVersionId);
        const conversionProfile = resolved.profile;
        const conversionVersion = resolved.version;
        let converted = highQualityV2v
          ? null
          : await convertOpenVoiceSpeech({
              sourceAudioPath: payload.sourceAudioPath,
              sourceDurationSeconds: payload.durationSeconds,
              language: payload.language,
              profile: conversionProfile,
              settings: payload.settings,
              signal: job.abortController?.signal
            });
        if (highQualityV2v && vtvPipelineEnabled) {
          const vtvSettings = normalizeVtvSettings(payload.settings, { mode: "speech" });
          const workingDir = path.join(os.tmpdir(), makeVoiceId("voice-vtv-speech"));
          await fs.mkdir(workingDir, { recursive: true });
          try {
            const sourceSha256 = await sha256File(payload.sourceAudioPath);
            const vtvInference = await resolveVtvInferenceArtifacts(payload.settings);
            const referencePack = buildRuntimeVtvReferencePack(
               conversionProfile,
               conversionVersion?.id || conversionProfile.voiceModel?.versionId || "",
               "speech",
               vtvSettings
             );
            const lineage = createVtvLineage({
              mode: "speech",
              sourceSha256,
               referencePackId: referencePack.packId,
              referencePackSha256: referencePack.sha256,
              modelArtifactId: conversionProfile.voiceModel?.versionId || conversionVersion?.id,
              modelCheckpointSha256: vtvInference.checkpointSha256
                || conversionProfile.voiceModel?.vtvCheckpointSha256
                || conversionProfile.voiceModel?.checkpointHash
                || conversionProfile.voiceModel?.modelHash,
              runtimeManifestHash: conversionProfile.voiceModel?.runtimeManifestHash || await seedVcRuntimeManifestHash(),
              normalizedSettings: {
                ...vtvSettings,
                modelConfigSha256: vtvInference.configSha256
              }
            });
            const jobBaseSeed = deriveVtvJobSeed({
              sourceSha256,
              referencePackSha256: lineage.referencePackSha256,
              modelCheckpointSha256: lineage.modelCheckpointSha256,
              normalizedSettings: vtvSettings
            });
            const candidates = planVtvCandidates({
              jobBaseSeed,
              candidateBudget: vtvSettings.candidateBudget,
              presetId: vtvSettings.presetId,
              kind: "speech"
            });
             const packReferencePaths = referencePack.artifacts.map((artifact) => {
               try { return resolveManagedArtifactPath(voiceDataRootDir(), artifact.relativePath); } catch { return ""; }
             }).filter(Boolean).filter((audioPath) => pathIsInside(voiceDataRootDir(), audioPath));
             const referencePaths = Array.from(new Set([
               ...packReferencePaths,
               ...voiceProfileIdentityEvaluationAudioPaths(conversionProfile)
             ])).slice(0, 16);
            const candidateResults = [];
            let lastConversionError = null;
            for (const candidatePlan of candidates) {
              try {
                const candidate = await convertSeedVcSpeech({
                  sourceAudioPath: payload.sourceAudioPath,
                  sourceDurationSeconds: payload.durationSeconds,
                  targetReferenceAudioPath: resolved.referenceAudioPath,
                  settings: {
                     ...payload.settings,
                     ...vtvSettings,
                     ...vtvInference.settings,
                     seed: candidatePlan.seed,
                    nativeSampleRate: VTV_SPEECH_SAMPLE_RATE,
                    inferenceCfgRate: 0.5
                  },
                  signal: job.abortController?.signal,
                  onProgress: (event) => updateVoiceJob(job, {
                    progress: Math.max(70, Math.min(94, 70 + Math.round((Number(event.progress) || 0) * 0.24))),
                    message: `Converting speech with deterministic target-voice candidate ${candidatePlan.candidateIndex + 1}/${candidates.length}`
                  })
                });
                candidateResults.push(await validateVtvSpeechCandidate({
                  sourceAudioPath: payload.sourceAudioPath,
                  converted: candidate,
                  referenceAudioPath: resolved.referenceAudioPath,
                  referenceAudioPaths: referencePaths,
                  workingDir,
                   candidateId: candidatePlan.candidateId,
                   settings: { ...payload.settings, ...vtvSettings },
                   validateContent: false,
                   signal: job.abortController?.signal
                 }));
              } catch (error) {
                if (job.abortController?.signal?.aborted) throw error;
                lastConversionError = error;
             }
            }
            if (!candidateResults.length) throw lastConversionError || new Error("Speech VTV produced no candidate that passed the target identity and timing gates.");
            const contentValidation = await validateVtvSpeechContentBatch({
              candidates: candidateResults,
              settings: { ...payload.settings, ...vtvSettings },
              signal: job.abortController?.signal
            });
            for (const candidateResult of candidateResults) {
              candidateResult.sourceTranscriptTokenCount = contentValidation.sourceTranscriptTokenCount;
              candidateResult.observedTranscriptTokenCount = contentValidation.observedTranscriptTokenCount;
            }
            const qualityEvaluated = await evaluateSeedSpeechQualityCandidates({
              candidates: candidateResults,
              targetReferenceAudioPath: resolved.referenceAudioPath,
              targetReferenceAudioPaths: referencePaths,
              signal: job.abortController?.signal
            });
            const ranked = rankVtvSpeechCandidates(qualityEvaluated, { allowNeedsReview: vtvSettings.allowNeedsReview === true });
            if (!ranked.selected) {
              const error = new Error("Speech VTV candidates did not pass dual identity and perceptual quality gates.");
              error.voiceOutcomeStatus = "rejected";
              error.voiceJobDiagnostics = {
                vtvQuality: {
                  candidates: ranked.candidates.map((candidate) => candidate.vtvQuality),
                  rejectedCandidateIds: ranked.rejectedCandidateIds
                }
              };
              throw error;
            }
            const selectedCandidate = ranked.selected;
            candidateResults.splice(0, candidateResults.length, ...ranked.candidates);
            const persistedVtvCandidates = ranked.candidates.map((candidate) => ({
              id: String(candidate.vtvCandidateId || candidate.id || ""),
              seed: candidates.find((item) => item.candidateId === (candidate.vtvCandidateId || candidate.id))?.seed,
              score: candidate.vtvQuality?.score,
              hardPassed: candidate.vtvQuality?.hardPassed === true,
              needsReview: candidate.vtvQuality?.needsReview === true,
              reasons: candidate.vtvQuality?.reasons || [],
              audioPath: candidate.vtvCandidatePath || candidate.audioPath
            })).filter((candidate) => candidate.id && candidate.audioPath);
            converted = {
              ...selectedCandidate,
              conversionAttemptCount: candidateResults.length,
              targetBlendRatio: 0,
              vtvPipelineVersion: VTV_PIPELINE_VERSION,
              vtvLineage: lineage,
               vtvReferencePack: referencePack,
               vtvCandidateSeed: candidates.find((item) => item.candidateId === selectedCandidate.vtvCandidateId)?.seed || null,
               vtvCandidates: persistedVtvCandidates,
               vtvModelCheckpointSha256: lineage.modelCheckpointSha256,
               vtvModelConfigSha256: vtvInference.configSha256
             };
            if (selectedCandidate.vtvQuality?.needsReview) {
              converted.conversionStrictValidationAccepted = false;
              converted.conversionNeedsReview = true;
            }
            conversionWarnings.push("Speech VTV selected a complete target-voice conversion candidate; source waveform blending is disabled in VTV Pipeline V2.");
          } finally {
            await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
          }
        }
        if (highQualityV2v && !vtvPipelineEnabled) {
          const legacyCandidate = await convertSeedVcSpeech({
            sourceAudioPath: payload.sourceAudioPath,
            sourceDurationSeconds: payload.durationSeconds,
            targetReferenceAudioPath: resolved.referenceAudioPath,
            settings: payload.settings,
            signal: job.abortController?.signal
          });
          const legacy = await selectCoverageSafeSeedVoiceBlend({
            sourceAudioPath: payload.sourceAudioPath,
            convertedBuffer: legacyCandidate.buffer,
            language: normalizeVoiceLanguage(payload.language),
            referenceAudioPath: resolved.referenceAudioPath,
            baselineAudioPaths: voiceModelValidationBaselineAudioPaths(conversionProfile),
            settings: payload.settings,
            signal: job.abortController?.signal
          });
          converted = {
            ...legacyCandidate,
            buffer: legacy.buffer,
            targetBlendRatio: legacy.targetBlendRatio,
            conversionCoverage: legacy.coverage,
            conversionStrictValidationAccepted: legacy.strictValidationAccepted,
            sourceTranscriptTokenCount: legacy.sourceTranscriptTokenCount,
            sourceDurationSeconds: legacy.sourceDurationSeconds,
            convertedDurationSeconds: legacy.convertedDurationSeconds,
            conversionOnsetLagMs: legacy.onsetLagMs
          };
          conversionWarnings.push("Legacy VTV fallback is enabled; source waveform blending is retained for rollback compatibility.");
        }
        const effectiveLanguage = converted.language || resolveVoiceLanguage({
          requestedLanguage: payload.language,
          profileLanguage: conversionProfile.language
        });
        conversionWarnings.push(...(converted.warnings || []));
        throwIfVoiceJobCancelled(job);
        const output = await writeVoiceOutputForJob(job, {
          db,
          defaultDownloadDir,
          outputDir: payload.outputDir,
          mode: "v2v",
          profile: conversionProfile,
          language: effectiveLanguage,
          inputSummary: `Source audio: ${payload.sourceAudioName}`,
          sourceAudioName: payload.sourceAudioName,
          durationSeconds: converted.durationSeconds,
          audioBuffer: converted.buffer,
          engine: converted.engine,
          settings: {
            ...payload.settings,
            modelVersion: converted.modelVersion,
            modelVersionId: conversionVersion?.id || conversionProfile.voiceModel?.versionId || "",
            conversionEngine,
            conversionStrategy: converted.conversionStrategy || "openvoice-v2-raw",
            conversionDevice: converted.device || "",
            targetBlendRatio: converted.targetBlendRatio || 0,
            conversionAttemptCount: converted.conversionAttemptCount,
            inferenceCfgRate: converted.inferenceCfgRate,
            conversionCoverage: converted.conversionCoverage,
            conversionStrictValidationAccepted: converted.conversionStrictValidationAccepted,
             vtvPipelineVersion: converted.vtvPipelineVersion || (highQualityV2v ? VTV_PIPELINE_VERSION : ""),
             vtvReferencePack: converted.vtvReferencePack || null,
             vtvQuality: converted.vtvQuality || null,
             conversionNeedsReview: converted.conversionNeedsReview === true,
               vtvCandidateSeed: converted.vtvCandidateSeed,
               vtvCandidates: converted.vtvCandidates || [],
              vtvModelCheckpointSha256: converted.vtvModelCheckpointSha256 || "",
              vtvModelConfigSha256: converted.vtvModelConfigSha256 || "",
              vtvLineage: converted.vtvLineage || null,
            conversionAdvisoryAmplitudeWarning: converted.conversionAdvisoryAmplitudeWarning,
            sourceTranscriptTokenCount: converted.sourceTranscriptTokenCount,
            sourceDurationSeconds: converted.sourceDurationSeconds,
            convertedDurationSeconds: converted.convertedDurationSeconds,
            conversionOnsetLagMs: converted.conversionOnsetLagMs,
            requestedLanguage: payload.language,
            effectiveLanguage,
            conversionWarnings
          }
        });
        if (converted.conversionNeedsReview === true) {
          job.terminalStatus = "needs-review";
        }
        job.outputId = output.id;
        job.result = {
          output,
          warnings: conversionWarnings
        };
      }
    }
  ]);
}

async function buildYingMusicReferenceFromProfile({ profile, samples = [], profileVersionId = "", artifactId = `ying-ref-${Date.now()}`, signal = null } = {}) {
  const enrichedSamples = await Promise.all(samples.map(async (sample) => {
    if (sample?.profileId !== profile?.id || !Array.isArray(sample.segments)) return sample;
    const segments = await Promise.all(sample.segments.map(async (segment) => {
      if (!segment?.audioPath || segment.qualityVerdict !== "eligible") return segment;
      const inspection = await inspectYingMusicReferenceSource(segment.audioPath).catch(() => null);
      return inspection ? { ...segment, voicedDurationSeconds: inspection.voicedDurationSec } : segment;
    }));
    return { ...sample, segments };
  }));
  const selection = selectYingMusicProfileReferenceSources(enrichedSamples, profile?.id);
  if (!selection.ready) {
    const error = new Error(`YingMusic-SVC needs 20–25 seconds of valid voiced audio from 3–6 eligible clips. This profile currently provides about ${selection.voicedDurationSeconds.toFixed(1)} voiced seconds.`);
    error.code = "YINGMUSIC_REFERENCE_TOO_SHORT";
    error.action = "Prepare and approve more clean single-speaker clips, then build the YingMusic reference again.";
    throw error;
  }
  const buildId = makeVoiceId("ying-reference-build");
  const buildRoot = path.join(voiceDataRootDir(), "jobs", buildId, "engines", vtvYingMusicEngineId);
  const outputDir = path.join(voiceDataRootDir(), "profiles", String(profile.id), "vtv-targets", vtvYingMusicEngineId, String(artifactId));
  const normalizedPaths = [];
  let completed = false;
  try {
    await fs.mkdir(buildRoot, { recursive: true });
    for (let index = 0; index < selection.clips.length; index += 1) {
      const clip = selection.clips[index];
      if (!(await pathExists(clip.audioPath))) {
        const error = new Error("A selected YingMusic reference clip is missing from local storage.");
        error.code = "TARGET_REFERENCE_INVALID";
        error.action = "Reprocess the affected profile source before rebuilding the reference.";
        throw error;
      }
      const normalizedPath = path.join(buildRoot, `reference-${String(index + 1).padStart(2, "0")}.wav`);
      await runFfmpegVoiceCommand([
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", clip.audioPath,
        "-t", String(Number(clip.contributionSeconds.toFixed(4))),
        "-vn", "-af", "highpass=f=60,loudnorm=I=-20:TP=-2:LRA=11",
        "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le",
        normalizedPath
      ], { timeoutMs: voiceEngineRequestTimeoutMs, signal });
      normalizedPaths.push(normalizedPath);
    }
    const artifact = await buildYingMusicReferenceArtifact({
      sourcePaths: normalizedPaths,
      outputDir,
      profileId: profile.id,
      profileVersionId: profileVersionId || profile.activeModelVersionId || profile.voiceModel?.versionId || "",
      artifactId
    });
    completed = true;
    return artifact;
  } finally {
    await fs.rm(path.join(voiceDataRootDir(), "jobs", buildId), { recursive: true, force: true }).catch(() => {});
    if (!completed) await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function validateAndFinalizeRvcBundle({ imported, smokeInputPath, service = null, signal = null } = {}) {
  let ownedService = null;
  const activeService = service || (ownedService = await createVtvEngineService({ dataRoot: voiceDataRootDir() }));
  try {
    const worker = activeService.workers.rvc;
    if (!worker) throw Object.assign(new Error("RVC v2 runtime is not installed or activated."), { code: "ENGINE_RUNTIME_UNHEALTHY" });
    if (!smokeInputPath || !(await pathExists(smokeInputPath))) {
      throw Object.assign(new Error("No approved Profile clip is available for automatic RVC validation."), {
        code: "RVC_TRAINING_DATA_INSUFFICIENT",
        action: "Prepare and approve at least one Profile transcript clip."
      });
    }
    const inspection = await worker.request({ command: "inspect_model", model: { modelPath: imported.modelPath } }, { signal });
    const smokeOutputPath = path.join(imported.directory, "rvc-model-validation.wav");
    await worker.request({ command: "load_model", model: imported }, { signal });
    const smoke = await worker.request({
      command: "infer",
      inputPath: path.resolve(String(smokeInputPath)),
      outputPath: smokeOutputPath,
      settings: { f0Method: "rmvpe", indexRate: 0.65, rmsMixRate: 0.25, protect: 0.33, pitchShiftSemitones: 0 },
      seed: 0
    }, { signal });
    imported.inspection = { status: "passed", metadataSource: "rvc-worker", metadata: inspection.inspection || {} };
    imported.smokeTest = {
      passed: true,
      source: "approved-profile-clip",
      validationScope: "same-speaker-runtime-only",
      crossSpeakerSongQualityValidated: false,
      fixtureHash: createHash("sha256").update(await fs.readFile(smokeInputPath)).digest("hex"),
      outputHash: smoke.outputHash || createHash("sha256").update(await fs.readFile(smokeOutputPath)).digest("hex"),
      completedAt: new Date().toISOString()
    };
    imported.manifestPath = path.join(imported.directory, "model-manifest.json");
    await fs.writeFile(imported.manifestPath, JSON.stringify(imported, null, 2), "utf8");
    await fs.rm(smokeOutputPath, { recursive: false, force: true }).catch(() => {});
    return imported;
  } finally {
    if (ownedService) await ownedService.close().catch(() => {});
  }
}

async function runRvcProfileTrainingJob(job, profileId, { epochs = 200, acquireTrainingResources = null } = {}) {
  await runVoiceJob(job, [{
    status: "preprocessing",
    progress: 3,
    message: "Creating an immutable RVC dataset snapshot from approved Profile clips",
    run: async () => {
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, profileId);
      if (!profile) throw Object.assign(new Error("Voice profile was not found."), { code: "TARGET_REFERENCE_INVALID" });
      const sources = selectRvcProfileTrainingSources(db.samples, profile.id);
      const readiness = assessRvcTrainingReadiness({
        voicedDurationSec: sources.reduce((total, source) => total + source.voicedDurationSec, 0),
        singingDurationSec: sources.reduce((total, source) => total + source.singingDurationSec, 0)
      });
      if (!readiness.ready) {
        throw Object.assign(new Error(`RVC training needs at least 10 minutes of approved voice. Add or approve ${readiness.missingVoicedDurationSec.toFixed(1)} more seconds.`), {
          code: "RVC_TRAINING_DATA_INSUFFICIENT",
          action: "Open TTV Profiles, add voice sources, and verify their transcript clips.",
          details: readiness
        });
      }
      throwIfVoiceJobCancelled(job);
      const modelId = makeVoiceId("rvc-model");
      const datasetDir = path.join(voiceDataRootDir(), "profiles", String(profile.id), "vtv-targets", vtvRvcEngineId, "datasets", job.id);
      const snapshot = await createRvcDatasetSnapshot({ profileId: profile.id, sourceFiles: sources, outputDir: datasetDir });
      const workspaceRoot = path.join(voiceDataRootDir(), "jobs", job.id, "engines", vtvRvcEngineId);
      job.inputDir = path.join(voiceDataRootDir(), "jobs", job.id);
      let trainingResources = null;
      let service = null;
      let imported = null;
      try {
        if (acquireTrainingResources) {
          updateVoiceJob(job, {
            status: "running",
            progress: 5,
            message: "Waiting for exclusive GPU access for RVC training"
          });
          trainingResources = await acquireTrainingResources({
            job,
            signal: job.abortController?.signal,
            workload: "RVC training",
            schedulerKind: "rvc-training"
          });
          job.diagnostics = {
            ...(job.diagnostics || {}),
            resourceCoordination: trainingResources.diagnostics || {}
          };
        }
        service = await createVtvEngineService({ dataRoot: voiceDataRootDir() });
        const install = await service.registry.require(vtvRvcEngineId).getInstallState();
        if (!install.installed || !install.manifest) {
          throw Object.assign(new Error("The pinned RVC v2 runtime is not installed."), { code: "ENGINE_NOT_INSTALLED", action: "Install or repair the RVC v2 runtime." });
        }
        const trained = await runRvcTrainingPipeline({
          runtimeManifest: install.manifest,
          snapshot,
          workspaceRoot,
          profileId: profile.id,
          profileVersionId: profile.activeModelVersionId || profile.voiceModel?.versionId || "",
          modelId,
          parameters: { epochs },
          signal: job.abortController?.signal,
          onProgress: (event) => updateVoiceJob(job, {
            status: "running",
            progress: Math.max(3, Math.min(99, Number(event.progress) || job.progress || 3)),
            message: event.message || job.message
          })
        });
        throwIfVoiceJobCancelled(job);
        imported = await importRvcModelBundle({
          modelPath: trained.modelPath,
          indexPath: trained.indexPath,
          profileId: profile.id,
          profileVersionId: profile.activeModelVersionId || profile.voiceModel?.versionId || "",
          modelId,
          destinationDir: path.join(voiceDataRootDir(), "profiles", String(profile.id), "vtv-targets", vtvRvcEngineId, modelId),
          runtimeRevision: install.manifest.sourceRevision || "8f2fdbf",
          inspection: { sampleRate: 48000, usesF0: true, speakerId: 0 },
          training: {
            datasetHash: snapshot.datasetHash,
            voicedDurationSec: readiness.voicedDurationSec,
            speechDurationSec: Math.max(0, readiness.voicedDurationSec - readiness.singingDurationSec),
            singingDurationSec: readiness.singingDurationSec,
            sourceProfileId: profile.id,
            runtimeRevision: install.manifest.sourceRevision || "8f2fdbf",
            parameters: trained.parameters,
            reportHash: trained.trainingReport.reportHash
          }
        });
        await fs.writeFile(path.join(imported.directory, "training-report.json"), JSON.stringify(trained.trainingReport, null, 2), "utf8");
        await validateAndFinalizeRvcBundle({ imported, smokeInputPath: sources[0]?.path, service, signal: job.abortController?.signal });
        job.result = {
          artifact: publicProfileTargetArtifact(imported, vtvRvcEngineId),
          training: {
            datasetHash: snapshot.datasetHash,
            voicedDurationSec: readiness.voicedDurationSec,
            category: readiness.category,
            speechOnly: readiness.speechOnly,
            songCapable: readiness.songCapable,
            completedStages: trained.trainingReport.completedStages
          }
        };
      } catch (error) {
        if (imported?.directory) await fs.rm(imported.directory, { recursive: true, force: true }).catch(() => {});
        throw error;
      } finally {
        await service?.close().catch(() => {});
        await trainingResources?.release?.();
      }
    }
  }]);
}

async function profileVtvTargetState(profile, { samples = [], rvcModelId = "", yingReferenceArtifactId = "" } = {}) {
  const service = await createVtvEngineService({ dataRoot: voiceDataRootDir() });
  try {
    const states = { [vtvSeedEngineId]: createSeedProfileTargetState(publicVoiceProfile(profile, samples)) };
    for (const engineId of [vtvRvcEngineId, vtvYingMusicEngineId]) {
      const targets = await listProfileTargetArtifacts({ resolver: service.resolver, profileId: profile.id, engineId });
      const requestedId = engineId === vtvRvcEngineId ? rvcModelId : yingReferenceArtifactId;
      const targetStates = await Promise.all(targets.map(async (target) => {
        const preflight = await service.registry.require(engineId).preflight({ profileId: profile.id, target });
        return {
          ...publicProfileTargetArtifact(target, engineId),
          ready: preflight.ready === true,
          errors: preflight.errors || [],
          warnings: preflight.warnings || [],
          action: preflight.action || ""
        };
      }));
      const selectedTarget = targetStates.find((target) => target.artifactId === requestedId)
        || targetStates.find((target) => target.ready)
        || targetStates[0]
        || null;
      const emptyPreflight = selectedTarget ? null : await service.registry.require(engineId).preflight({ profileId: profile.id, target: null });
      states[engineId] = {
        ready: selectedTarget?.ready === true,
        selectedTarget,
        targets: targetStates,
        errors: selectedTarget?.errors || emptyPreflight?.errors || [],
        warnings: selectedTarget?.warnings || emptyPreflight?.warnings || [],
        action: selectedTarget?.action || emptyPreflight?.action || ""
      };
    }
    const rvcTrainingSources = selectRvcProfileTrainingSources(samples, profile.id);
    const rvcReadiness = assessRvcTrainingReadiness({
      voicedDurationSec: rvcTrainingSources.reduce((total, source) => total + source.voicedDurationSec, 0),
      singingDurationSec: rvcTrainingSources.reduce((total, source) => total + source.singingDurationSec, 0)
    });
    states[vtvRvcEngineId].migration = {
      status: states[vtvRvcEngineId].ready ? "ready" : "available",
      canImport: true,
      canTrain: rvcReadiness.ready,
      eligibleClipCount: rvcTrainingSources.length,
      trainingReadiness: rvcReadiness,
      note: rvcReadiness.ready
        ? "This profile has enough approved audio. MagicBox can train, validate, and bind its RVC model automatically."
        : `Approve more Profile clips before training RVC. ${rvcReadiness.missingVoicedDurationSec.toFixed(1)} more voiced seconds are required.`
    };
    const yingSelection = selectYingMusicProfileReferenceSources(samples, profile.id);
    states[vtvYingMusicEngineId].migration = {
      status: states[vtvYingMusicEngineId].ready ? "ready" : yingSelection.ready ? "available" : "blocked",
      canBuild: yingSelection.ready,
      eligibleClipCount: yingSelection.clips.length,
      availableDurationSec: yingSelection.durationSeconds,
      requiredDurationSec: { minimum: 20, maximum: 25 }
    };
    return { engines: states, summary: createProfileEngineSummary(states) };
  } finally {
    await service.close().catch(() => {});
  }
}

async function evaluateModernVtvConvertedVocal({ profile, shared, engineRun, converted, signal = null } = {}) {
  // Reuse quality models for one converted vocal, then free them before the
  // next SVC engine starts. Keep comparison engines from competing for VRAM.
  if (!/^(0|false|off)$/i.test(process.env.VOICE_CLONE_JOB_WORKER_REUSE_ENABLED || "1")) {
    return withVoiceJobWorkers(createVoiceEngineWorkerSession, () => evaluateModernVtvConvertedVocalMetrics({ profile, shared, engineRun, converted, signal }));
  }
  return evaluateModernVtvConvertedVocalMetrics({ profile, shared, engineRun, converted, signal });
}

async function evaluateModernVtvConvertedVocalMetrics({ profile, shared, engineRun, converted, signal = null } = {}) {
  if (engineRun?.engineId === vtvSeedEngineId && converted?.songIntegrity) {
    const songIntegrity = converted.songIntegrity;
    return {
      qualityStatus: songIntegrity.accepted ? "passed" : "needs-review",
      identity: songIntegrity.final?.metrics || {},
      pitch: songIntegrity.final?.metrics || {},
      quality: { humanReview: "not-run", songIntegrity }
    };
  }
  const referenceAudioPaths = voiceProfileIdentityEvaluationAudioPaths(profile)
    .filter((audioPath) => audioPath && pathIsInside(voiceDataRootDir(), audioPath));
  if (!referenceAudioPaths.length) {
    return {
      qualityStatus: "needs-review",
      quality: { humanReview: "not-run", evaluatorError: "Target identity reference pack is unavailable." }
    };
  }
  const engineSettings = {
    ...(engineRun?.settings || {}),
    ...((engineRun?.settings?.engineSettings || {})[engineRun.engineId] || {})
  };
  const effectivePitchShift = resolveSongPitchShift({ engineId: engineRun?.engineId, settings: engineRun?.settings, converted });
  try {
    const songIntegrity = await analyzeSeedSongCandidate({
      sourceAudioPath: shared.leadVocalPath,
      convertedAudioPath: converted.convertedVocalPath,
      durationSeconds: converted.durationSec || shared.durationSeconds,
      targetReference: {
        audioPath: referenceAudioPaths[0],
        validationAudioPaths: referenceAudioPaths,
        strategy: "profile-identity-evaluation-pack",
        clipCount: referenceAudioPaths.length
      },
      settings: { ...engineSettings, pitchShift: effectivePitchShift },
      attempt: 1,
      phase: `${engineRun.engineId}-post-conversion-quality`,
      signal
    });
    const [dualIdentityCandidate] = await analyzeSeedSpeechIdentityCandidates({
      sourceAudioPath: shared.leadVocalPath,
      candidates: [{ id: `${engineRun.engineId}-song-output`, audioPath: converted.convertedVocalPath }],
      targetReferenceAudioPath: referenceAudioPaths[0],
      targetReferenceAudioPaths: referenceAudioPaths,
      settings: { ...engineSettings, convertStyle: false },
      signal
    });
    const metrics = songIntegrity.metrics || {};
    const identity = dualIdentityCandidate?.identity || null;
    const encoderBComplete = Number.isFinite(Number(identity?.encoderB?.score))
      && Number.isFinite(Number(identity?.encoderB?.targetSimilarityFloor));
    const identityPassed = identity?.accepted === true && identity?.encoderB?.passed === true;
    const qualityStatus = !identity || !encoderBComplete
      ? "needs-review"
      : songIntegrity.accepted && identityPassed ? "passed" : "rejected";
    return {
      qualityStatus,
      identity,
      pitch: {
        expectedShiftSemitones: effectivePitchShift,
        medianPitchErrorCents: metrics.medianPitchErrorCents,
        pitchOver100CentsPercent: metrics.pitchOver100CentsPercent,
        voicedDropoutPercent: metrics.voicedDropoutPercent,
        abruptPitchJumpsPerMinute: metrics.abruptPitchJumpsPerMinute
      },
      quality: { humanReview: "not-run", songIntegrity, identity }
    };
  } catch (error) {
    throwIfVoiceAbortSignalAborted(signal);
    return {
      qualityStatus: "needs-review",
      quality: {
        humanReview: "not-run",
        evaluatorError: sanitizeUnicodeText(error?.message || "Song identity evaluator failed.").slice(0, 500)
      }
    };
  }
}

async function runModernVtvSongReplacementJob(job, defaultDownloadDir, payload, { acquireEngineResources = null } = {}) {
  const songSettings = normalizeSongReplacementSettings(payload.settings);
  const selection = normalizeVtvSongEngineSelection(songSettings);
  const featureFlags = voiceCloneFeatureFlags(process.env);
  if (!featureFlags.vtvMultiEngine) {
    const error = new Error("VTV multi-engine framework is disabled by VTV_MULTI_ENGINE_ENABLED=false.");
    error.code = "ENGINE_VERSION_INCOMPATIBLE";
    throw error;
  }
  if (selection.engineIds.includes(vtvRvcEngineId) && !featureFlags.vtvRvc) {
    const error = new Error("RVC v2 is disabled by VTV_RVC_ENABLED=false.");
    error.code = "ENGINE_VERSION_INCOMPATIBLE";
    throw error;
  }
  if (selection.engineIds.includes(vtvYingMusicEngineId) && !featureFlags.vtvYingMusic) {
    const error = new Error("YingMusic-SVC is disabled by VTV_YINGMUSIC_ENABLED=false.");
    error.code = "ENGINE_VERSION_INCOMPATIBLE";
    throw error;
  }
  if (selection.mode === "compare" && !featureFlags.vtvCompareMode) {
    const error = new Error("VTV compare mode is disabled by VTV_COMPARE_MODE_ENABLED=false.");
    error.code = "ENGINE_VERSION_INCOMPATIBLE";
    throw error;
  }
  await runVoiceJob(job, [
    { status: "preprocessing", progress: 8, message: "Preparing shared Song VTV artifacts" },
    {
      status: "running",
      progress: 18,
      message: "Separating one shared vocal stem",
      run: async () => {
        const db = await readVoiceDb();
        const profile = getVoiceProfile(db, payload.profileId);
        if (!profile) throw new Error("Voice profile was not found.");
        const workDir = path.join(os.tmpdir(), makeVoiceId("voice-vtv-multi-engine"));
        let service = null;
        try {
          await fs.mkdir(workDir, { recursive: true });
          const normalizedSourcePath = path.join(workDir, "source-native-44k1-f32-stereo.wav");
          await runFfmpegVoiceCommand(["-y", "-hide_banner", "-loglevel", "error", "-i", payload.sourceAudioPath, "-vn", "-ar", String(VTV_SONG_SAMPLE_RATE), "-ac", "2", "-c:a", "pcm_f32le", normalizedSourcePath], { signal: job.abortController?.signal });
          const separated = await separateSharedSongStems({
            sourceAudioPath: normalizedSourcePath,
            workingDir: workDir,
            settings: songSettings,
            signal: job.abortController?.signal,
            onProgress: (event) => updateVoiceJob(job, { progress: 18 + Math.round((Number(event.progress) || 0) * 0.2), message: event.message || "Separating shared song stems" })
          }, { demucs: separateSongStemsWithDemucs, roformer: separateSongStemsWithRoformer });
          const stemGate = await analyzeVtvSongStemGate({ sourceAudioPath: normalizedSourcePath, vocalPath: separated.vocalPath, accompanimentPath: separated.accompanimentPath });
          if (!stemGate.passed) {
            const error = new Error(`Shared Song VTV stem quality gate failed (${stemGate.reasons.join(", ")}).`);
            error.code = "SHARED_STEM_INVALID";
            error.voiceJobDiagnostics = { stemGate };
            throw error;
          }
          const [sourceBuffer, stemBuffer, accompanimentBuffer] = await Promise.all([
            fs.readFile(normalizedSourcePath),
            fs.readFile(separated.vocalPath),
            fs.readFile(separated.accompanimentPath)
          ]);
          const shared = {
            sourceSongPath: normalizedSourcePath,
            leadVocalPath: separated.vocalPath,
            accompanimentPath: separated.accompanimentPath,
            durationSeconds: Number(payload.durationSeconds) || Number(stemGate?.source?.durationSeconds) || 0,
            sourceHash: createHash("sha256").update(sourceBuffer).digest("hex"),
            stemHash: createHash("sha256").update(stemBuffer).digest("hex"),
            accompanimentHash: createHash("sha256").update(accompanimentBuffer).digest("hex"),
            stemGate,
            separator: separated.separator
          };
          service = await createVtvEngineService({
            dataRoot: voiceDataRootDir(),
            seedHealth: async () => {
              const health = await voiceEngineHealth();
              const state = health.engines?.seedVcSingingLocal;
              return { ready: Boolean(state?.installed && state?.runtimeReady && state?.workerReady && state?.conversionReady), ...state };
            },
            seed: {
              convert: async (context, signal) => {
                const resolved = resolveVoiceProfileForSeedV2v(profile, payload.modelVersionId);
                if (!resolved.referenceAudioPath) {
                  const error = new Error("Seed-VC Song Reference Pack is invalid or missing.");
                  error.code = "TARGET_REFERENCE_INVALID";
                  throw error;
                }
                const converted = await convertVerifiedSeedSong({
                  sourceAudioPath: shared.leadVocalPath,
                  sourceDurationSeconds: payload.durationSeconds,
                  profile: resolved.profile,
                  fallbackReferenceAudioPath: resolved.referenceAudioPath,
                  settings: { ...songSettings, sourceStem: "vocals", nativeSampleRate: VTV_SONG_SAMPLE_RATE, outputSampleRate: VTV_SONG_SAMPLE_RATE, pipelineVersion: VTV_PIPELINE_VERSION },
                  workingDir: workDir,
                  signal,
                  onProgress: (event) => updateVoiceJob(job, { progress: 40 + Math.round((Number(event.progress) || 0) * 0.25), message: event.message || "Converting with Seed-VC" })
                });
                const outputPath = path.join(service.resolver.tempDir(job.id, vtvSeedEngineId), "converted-vocal.wav");
                await fs.mkdir(path.dirname(outputPath), { recursive: true });
                await fs.writeFile(outputPath, converted.buffer);
                return { ...converted, convertedVocalPath: outputPath, sampleRate: converted.nativeSampleRate || VTV_SONG_SAMPLE_RATE, durationSec: converted.durationSeconds, lineage: converted.vtvLineage || {} };
              }
            }
          });
          const targetFor = async (engineId) => {
            const binding = songSettings.targetBindings?.[engineId] || {};
            if (engineId === vtvSeedEngineId) {
              const resolved = resolveVoiceProfileForSeedV2v(profile, payload.modelVersionId);
              return resolved.referenceAudioPath ? { type: "song-reference-pack", referenceAudioPath: resolved.referenceAudioPath, referencePackId: binding.referencePackId || "" } : null;
            }
            return resolveProfileTargetArtifact({ resolver: service.resolver, profileId: profile.id, engineId, binding });
          };
          const orchestrated = await runMultiEngineSongVtvJob({
            jobId: job.id,
            engineIds: selection.engineIds,
            registry: service.registry,
            shared,
            settings: songSettings,
            signal: job.abortController?.signal,
            gpuLeaseManager: acquireEngineResources
              ? {
                  acquire: ({ engineId, signal }) => acquireEngineResources({ job, engineId, signal })
                }
              : createGpuLeaseManager({ maxResidentGpuWorkers: 1 }),
            prepareEngineContext: async (engineId, engineRun) => ({
              ...engineRun,
              profileId: profile.id,
              target: await targetFor(engineId),
              settings: { ...songSettings, ...(songSettings.engineSettings?.[engineId] || {}) },
              seed: Number(songSettings.engineSettings?.[engineId]?.seed || 31002)
            }),
            mixFinal: async ({ engineRun, converted, signal }) => {
              const outputPath = path.join(workDir, `${engineRun.engineId}-final.wav`);
              const vocalPitchShiftSemitones = resolveSongPitchShift({ engineId: engineRun.engineId, settings: engineRun.settings, converted });
              const mixed = await mixConvertedSongWithFfmpeg({ accompanimentPath: shared.accompanimentPath, convertedVocalPath: converted.convertedVocalPath, outputPath, settings: songSettings, vocalPitchShiftSemitones, signal });
              const finalHash = createHash("sha256").update(mixed.buffer).digest("hex");
              return { ...mixed, finalMixPath: outputPath, finalAudioSha256: finalHash };
            },
            evaluateConverted: async ({ engineRun, converted }) => evaluateModernVtvConvertedVocal({
              profile,
              shared,
              engineRun,
              converted,
              signal: job.abortController?.signal
            }),
            evaluateFinal: async ({ mixed }) => {
              const finalMixGate = analyzeFinalSongMixGate(mixed.buffer);
              return { qualityStatus: finalMixGate.passed ? "passed" : "rejected", finalMixGate, quality: { humanReview: "not-run", finalMixGate, mixPitch: mixed.mixPitch } };
            },
            persistSuccess: async ({ engineRun, result, mixed, preflight, convertedQuality, finalQuality }) => {
              const resolved = engineRun.engineId === vtvSeedEngineId ? resolveVoiceProfileForSeedV2v(profile, payload.modelVersionId) : { profile, version: null };
              const output = await writeVoiceOutputForJob(job, {
                db,
                defaultDownloadDir,
                outputDir: payload.outputDir,
                mode: "song-v2v",
                profile: resolved.profile,
                language: payload.language || profile.language || "auto",
                inputSummary: `Song source: ${payload.sourceAudioName}`,
                sourceAudioName: payload.sourceAudioName,
                durationSeconds: mixed.durationSeconds || payload.durationSeconds,
                audioBuffer: mixed.buffer,
                engine: engineRun.engineId,
                settings: {
                  ...mixed.settings,
                  engineId: engineRun.engineId,
                  comparisonGroupId: engineRun.comparisonGroupId,
                  engineRunId: engineRun.engineRunId,
                  executionStatus: "succeeded",
                  qualityStatus: result.qualityStatus,
                  modelVersionId: resolved.version?.id || "",
                  conversionEngine: engineRun.engineId,
                  separationStrategy: shared.separator.strategy,
                  sharedArtifactHashes: { sourceHash: shared.sourceHash, stemHash: shared.stemHash, accompanimentHash: shared.accompanimentHash },
                  targetArtifact: preflight.resolvedTarget || {},
                  runtimeLineage: preflight.runtimeLineage || {},
                  finalMixGate: finalQuality.finalMixGate,
                  stemGate: shared.stemGate,
                  quality: result.quality || { humanReview: "not-run" },
                  songIntegrity: result.quality?.songIntegrity || null,
                  identityEvaluation: convertedQuality?.identity || result.quality?.identity || null,
                  pitchEvaluation: convertedQuality?.pitch || null,
                  vtvPipelineVersion: VTV_PIPELINE_VERSION,
                  nativeSampleRate: VTV_SONG_SAMPLE_RATE,
                  conversionWarnings: []
                }
              });
              const sidecar = buildEngineSidecar({ groupId: engineRun.comparisonGroupId, outputId: output.id, engineId: engineRun.engineId, result: { ...result, outputId: output.id }, source: shared, target: preflight.resolvedTarget, runtime: preflight.runtimeLineage, settings: songSettings, quality: result.quality, finalAudio: { path: output.outputPath, sha256: mixed.finalAudioSha256, sampleRate: VTV_SONG_SAMPLE_RATE, channels: 2, bitDepth: 16 } });
              await fs.writeFile(output.metadataPath, JSON.stringify({ ...sidecar, legacyOutput: JSON.parse(await fs.readFile(output.metadataPath, "utf8")) }, null, 2), "utf8");
              return { ...result, outputId: output.id, output, finalAudioSha256: mixed.finalAudioSha256 };
            },
            persistFailure: async ({ result }) => result,
            onProgress: (event) => updateVoiceJob(job, {
              progress: 40 + Math.round((Number(event.progress) || 0) * 0.55),
              message: event.elapsedSec > 0
                ? `${event.engineId}: ${event.stage} (${Math.round(event.elapsedSec)}s elapsed)`
                : `${event.engineId}: ${event.stage}`
            }),
            separator: shared.separator
          });
          job.result = {
            comparisonGroupId: orchestrated.comparisonGroupId,
            executionStatus: orchestrated.executionStatus,
            results: orchestrated.results.map((result) => publicVtvEngineResult(result, { mapOutput: publicVoiceOutput })),
            comparisonReport: orchestrated.report
          };
          job.terminalStatus = orchestrated.executionStatus;
          if (orchestrated.executionStatus === "failed") {
            const failures = orchestrated.results.filter((result) => result?.executionStatus === "failed");
            job.error = failures[0]?.error?.message || "Every selected VTV engine failed.";
            job.diagnostics = {
              comparisonGroupId: orchestrated.comparisonGroupId,
              engines: failures.map((result) => ({ engineId: result.engineId, error: result.error }))
            };
          }
          if (orchestrated.executionStatus === "partial") job.terminalQuality = { status: "partial", qualityStatus: "not-evaluated", reasons: ["one_or_more_engine_runs_failed"] };
        } finally {
          if (service) await service.close().catch(() => {});
          await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
          await fs.rm(path.join(voiceDataRootDir(), "jobs", String(job.id)), { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  ]);
}

async function runVoiceSongReplacementJob(job, defaultDownloadDir, payload, runtime = {}) {
  const modernSelection = payload.settings?.vtvEngineSelection;
  if (modernSelection) {
    return runModernVtvSongReplacementJob(job, defaultDownloadDir, payload, runtime);
  }
  const songSettings = normalizeSongReplacementSettings(payload.settings);
  const conversionEngine = normalizeV2vEngine(songSettings.conversionEngine || songSettings.conversion_engine);
  const highQualityV2v = conversionEngine === seedVcEngineId;
  await runVoiceJob(job, [
    { status: "preprocessing", progress: 12, message: "Preparing source song", delay: 120 },
    {
      status: "running",
      progress: 32,
      message: "Separating vocals and accompaniment",
      delay: 160,
      run: async () => {
        const db = await readVoiceDb();
        const profile = getVoiceProfile(db, payload.profileId);
        if (!profile) {
          throw new Error("Voice profile was not found.");
        }
        const warnings = [...(payload.warnings || [])];
        const resolved = highQualityV2v
          ? resolveVoiceProfileForSeedV2v(profile, payload.modelVersionId)
          : resolveVoiceProfileForV2v(profile, payload.modelVersionId);
        const conversionProfile = resolved.profile;
        const conversionVersion = resolved.version;
        const workDir = path.join(os.tmpdir(), makeVoiceId("voice-song-v2v"));
        try {
          await fs.mkdir(workDir, { recursive: true });
          const separationSourcePath = path.join(workDir, "source-native-44k1-f32-stereo.wav");
          if (highQualityV2v) {
            await runFfmpegVoiceCommand([
              "-y",
              "-hide_banner",
              "-loglevel", "error",
              "-i", payload.sourceAudioPath,
              "-vn",
              "-ar", String(VTV_SONG_SAMPLE_RATE),
              "-ac", "2",
              "-c:a", "pcm_f32le",
              separationSourcePath
            ], { signal: job.abortController?.signal });
          }
          const sourceForVtv = highQualityV2v ? separationSourcePath : payload.sourceAudioPath;
        const requestedSeparatorModel = String(songSettings.separationModel || songSettings.separation_model || "htdemucs").toLowerCase();
        const useRoformerSeparator = highQualityV2v && ["bs-roformer", "bs_roformer", "roformer", "band-roformer"].includes(requestedSeparatorModel);
        const separated = highQualityV2v
            ? (useRoformerSeparator
              ? await separateSongStemsWithRoformer({
                  sourceAudioPath: sourceForVtv,
                  workingDir: workDir,
                  settings: songSettings,
                  signal: job.abortController?.signal,
                  onProgress: (event) => updateVoiceJob(job, {
                    progress: Math.max(32, Math.min(60, 32 + Math.round((Number(event.progress) || 0) * 0.28))),
                    message: event.message || "Separating vocals with BS-RoFormer"
                  })
                })
              : await separateSongStemsWithDemucs({
                sourceAudioPath: sourceForVtv,
                workingDir: workDir,
                settings: songSettings,
                signal: job.abortController?.signal,
                onProgress: (event) => updateVoiceJob(job, {
                  progress: Math.max(32, Math.min(60, 32 + Math.round((Number(event.progress) || 0) * 0.28))),
                  message: event.message || "Separating vocals with Demucs"
                })
                }))
            : await separateSongStemsWithFfmpeg({
                sourceAudioPath: payload.sourceAudioPath,
                workingDir: workDir,
                sourceChannels: payload.channels,
                settings: songSettings
              });
          const stemGate = await analyzeVtvSongStemGate({
            sourceAudioPath: sourceForVtv,
            vocalPath: separated.vocalPath,
            accompanimentPath: separated.accompanimentPath
          });
          if (highQualityV2v && !stemGate.passed) {
            const error = new Error(`Song stem quality gate failed (${stemGate.reasons.join(", ")}). No defective output was saved.`);
            error.voiceOutcomeStatus = "rejected";
            error.voiceJobDiagnostics = { stemGate };
            throw error;
          }
          warnings.push(...separated.warnings);
          updateVoiceJob(job, {
            status: "running",
            progress: 62,
            message: "Converting isolated vocal stem"
          });
          const conversionSettings = {
            ...songSettings,
            sourceStem: "vocals",
            nativeSampleRate: VTV_SONG_SAMPLE_RATE,
            outputSampleRate: VTV_SONG_SAMPLE_RATE,
            pipelineVersion: VTV_PIPELINE_VERSION
          };
          const converted = highQualityV2v
            ? await convertVerifiedSeedSong({
                sourceAudioPath: separated.vocalPath,
                sourceDurationSeconds: payload.durationSeconds,
                profile: conversionProfile,
                fallbackReferenceAudioPath: resolved.referenceAudioPath,
                settings: conversionSettings,
                workingDir: workDir,
                signal: job.abortController?.signal,
                onProgress: (event) => updateVoiceJob(job, {
                  progress: Math.max(62, Math.min(83, 62 + Math.round((Number(event.progress) || 0) * 0.21))),
                  message: event.message || "Converting and verifying isolated vocals with Seed-VC"
                })
              })
            : await convertOpenVoiceSpeech({
                sourceAudioPath: separated.vocalPath,
                sourceDurationSeconds: payload.durationSeconds,
                language: payload.language,
                profile: conversionProfile,
                settings: conversionSettings,
                signal: job.abortController?.signal
              });
          warnings.push(...(converted.warnings || []));
          updateVoiceJob(job, {
            status: "running",
            progress: 84,
            message: "Mixing converted vocals with accompaniment"
          });
          const convertedVocalPath = path.join(workDir, "converted-vocals.wav");
          const mixedOutputPath = path.join(workDir, "song-output.wav");
          await fs.writeFile(convertedVocalPath, converted.buffer);
          const mixed = await mixConvertedSongWithFfmpeg({
            accompanimentPath: separated.accompanimentPath,
            convertedVocalPath,
            outputPath: mixedOutputPath,
            settings: songSettings,
            signal: job.abortController?.signal
          });
          const finalMixGate = analyzeFinalSongMixGate(mixed.buffer);
          if (!finalMixGate.passed) {
            const error = new Error(`Song final mix failed its hard gate (${finalMixGate.reasons.join(", ")}). No defective output was saved.`);
            error.voiceOutcomeStatus = "rejected";
            error.voiceJobDiagnostics = { finalMixGate, songIntegrity: converted.songIntegrity || null };
            throw error;
          }
          if (highQualityV2v && converted.songIntegrity && converted.songIntegrity.strictValidationAccepted !== true) {
            job.terminalStatus = "needs-review";
            job.terminalQuality = {
              status: "needs-review",
              strictValidationAccepted: false,
              finalMixGatePassed: true,
              reasons: converted.songIntegrity?.advisoryReasons || ["song_strict_validation_failed"]
            };
          }
          const effectiveLanguage = converted.language || resolveVoiceLanguage({
            requestedLanguage: payload.language,
            profileLanguage: conversionProfile.language
          });
          throwIfVoiceJobCancelled(job);
          const output = await writeVoiceOutputForJob(job, {
            db,
            defaultDownloadDir,
            outputDir: payload.outputDir,
            mode: "song-v2v",
            profile: conversionProfile,
            language: effectiveLanguage,
            inputSummary: `Song source: ${payload.sourceAudioName}`,
            sourceAudioName: payload.sourceAudioName,
            durationSeconds: mixed.durationSeconds || payload.durationSeconds || converted.durationSeconds,
            audioBuffer: mixed.buffer,
            engine: converted.engine,
            settings: {
              ...mixed.settings,
              modelVersion: converted.modelVersion,
              modelVersionId: conversionVersion?.id || conversionProfile.voiceModel?.versionId || "",
              conversionEngine,
              conversionStrategy: highQualityV2v
                ? `demucs-verified-${converted.conversionStrategy || "seed-vc-zero-shot-svc-f0"}`
                : "song-vocal-stem-openvoice-v2",
              conversionDevice: converted.device || "",
              diffusionSteps: converted.diffusionSteps || songSettings.diffusionSteps,
              inferenceCfgRate: converted.inferenceCfgRate ?? songSettings.inferenceCfgRate,
              chunkCrossfadeMs: converted.chunkCrossfadeMs || songSettings.chunkCrossfadeMs,
              chunkOverlapFrames: converted.chunkOverlapFrames || 0,
              separationStrategy: separated.separationStrategy,
              separatorModelSha256: separated.separatorModelSha256 || "",
              separatorSampleRate: separated.separatorSampleRate || VTV_SONG_SAMPLE_RATE,
              separationDevice: separated.separationDevice || "",
              separationOverlap: separated.separationOverlap || songSettings.separationOverlap,
              separationShifts: separated.separationShifts || 1,
              mixStrategy: mixed.mixStrategy,
              requestedLanguage: payload.language,
              effectiveLanguage,
              sourceDurationSeconds: payload.durationSeconds,
              sourceNativeSampleRate: highQualityV2v ? VTV_SONG_SAMPLE_RATE : (payload.sampleRate || 0),
              sourceNativeChannels: highQualityV2v ? 2 : (payload.channels || 0),
              sourceChannels: payload.channels || 0,
              ...(converted.songIntegrity ? { songIntegrity: { ...converted.songIntegrity, finalMixGate } } : {}),
               finalMixGate,
               stemGate,
               vtvPipelineVersion: VTV_PIPELINE_VERSION,
               nativeSampleRate: VTV_SONG_SAMPLE_RATE,
               vtvReferencePack: converted.vtvReferencePack || null,
               vtvCandidateSeed: converted.vtvCandidateSeed || null,
               vtvCandidates: converted.vtvCandidates || [],
               vtvModelCheckpointSha256: converted.vtvModelCheckpointSha256 || "",
               vtvModelConfigSha256: converted.vtvModelConfigSha256 || "",
               vtvLineage: converted.vtvLineage || null,
              conversionWarnings: warnings
            }
          });
          job.outputId = output.id;
          job.result = {
            output,
            warnings
          };
        } finally {
          await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  ]);
}

async function executableAvailable(name) {
  return Boolean(await resolveMediaTool(name));
}

function parseVoiceSettings(value) {
  if (!value) {
    return {};
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(String(value));
  } catch {
    throw voiceIngressError("invalid_field", "Voice settings were not valid JSON.", 400);
  }
}

function normalizeVoiceOutputFormat(settings) {
  const outputFormat = String(settings?.outputFormat || settings?.output_format || "wav").toLowerCase();
  if (outputFormat !== "wav") {
    throw new Error("Voice Clone currently exports WAV output only. MP3 export can be added after the neural runtime is stable.");
  }
  return {
    ...settings,
    outputFormat: "wav"
  };
}

async function decodeTextFileFromPath(file) {
  if (!file?.path || !file?.size) {
    throw voiceIngressError("invalid_media", "Choose a .txt file.", 400);
  }
  const extension = path.extname(file.originalname || "").toLowerCase();
  if (extension !== ".txt") {
    throw voiceIngressError("invalid_media", "Text to Voice file upload only accepts .txt files.", 400);
  }
  return (await fs.readFile(file.path)).toString("utf8").replace(/^\uFEFF/, "");
}

async function saveVoiceSourceAudioFromStagedFile(file, { jobId, maxDurationSeconds = maxVoiceSourceDurationSeconds } = {}) {
  if (!file?.path || !file?.size) {
    throw voiceIngressError("invalid_media", "Choose source audio.", 400);
  }
  const extension = validateVoiceExtension(file.originalname, "source audio");
  const folder = voiceJobInputsFolder(jobId);
  await fs.mkdir(folder, { recursive: true });
  const originalFileName = sanitizeFileName(normalizeUploadedFileName(file.originalname) || `source${extension}`);
  const storedPath = path.join(folder, `source-${originalFileName}`);
  await fs.rename(file.path, storedPath);
  try {
    const buffer = extension === ".wav" ? await fs.readFile(storedPath) : Buffer.alloc(0);
    const analysis = await analyzeVoiceAudioBuffer(buffer, extension, "auto", {}, storedPath);
    if (analysis.durationSeconds > maxDurationSeconds) {
      const maxMinutes = Math.max(1, Math.round(maxDurationSeconds / 60));
      throw voiceIngressError("invalid_media", `Source audio is longer than the ${maxMinutes} minute local limit.`, 400);
    }
    return {
      storedPath,
      inputDir: folder,
      originalFileName,
      durationSeconds: analysis.durationSeconds || 4,
      sampleRate: analysis.sampleRate || 0,
      channels: analysis.channels || 0,
      warnings: analysis.warnings
    };
  } catch (error) {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function videoDownloadItems(videos) {
  return videos.map((video, index) => ({
    video,
    index,
    outputIndex: video.listIndex || index + 1
  }));
}

function makeVideoDownloadJobId() {
  return `video-job-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function createVideoDownloadJob(videoUrls, outputDir) {
  const items = videoUrls.map((video, index) => {
    const bytesTotal = Number(video.bytes || 0);
    return {
      index,
      outputIndex: video.listIndex || index + 1,
      url: video.url,
      filename: video.filename || null,
      bytesDownloaded: 0,
      bytesTotal: Number.isFinite(bytesTotal) && bytesTotal > 0 ? bytesTotal : 0,
      progress: 0,
      status: "queued",
      error: null
    };
  });
  const job = {
    id: makeVideoDownloadJobId(),
    abortController: new AbortController(),
    status: "queued",
    outputDir,
    requested: videoUrls.length,
    downloaded: 0,
    failed: 0,
    completed: 0,
    bytesDownloaded: 0,
    bytesTotal: items.reduce((total, item) => total + item.bytesTotal, 0),
    progress: 0,
    percent: 0,
    items,
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date().toISOString()
  };
  recomputeVideoDownloadJob(job);
  return job;
}

function recomputeVideoDownloadJob(job) {
  job.bytesDownloaded = job.items.reduce((total, item) => total + (item.bytesDownloaded || 0), 0);
  job.bytesTotal = job.items.reduce((total, item) => total + (item.bytesTotal || 0), 0);
  const byteProgress = job.bytesTotal > 0 ? job.bytesDownloaded / job.bytesTotal : 0;
  const itemProgress = job.requested > 0
    ? job.items.reduce((total, item) => total + (item.progress || 0), 0) / job.requested
    : 0;
  job.progress = Math.max(0, Math.min(1, job.bytesTotal > 0 ? Math.max(byteProgress, itemProgress) : itemProgress));
  job.percent = Math.round(job.progress * 100);
  job.updatedAt = new Date().toISOString();
}

function videoDownloadJobSnapshot(job) {
  return {
    id: job.id,
    status: job.status,
    outputDir: job.outputDir,
    requested: job.requested,
    downloaded: job.downloaded,
    failed: job.failed,
    completed: job.completed,
    bytesDownloaded: job.bytesDownloaded,
    bytesTotal: job.bytesTotal,
    progress: job.progress,
    percent: job.percent,
    items: job.items.map((item) => ({ ...item })),
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    updatedAt: job.updatedAt
  };
}

function isVideoDownloadJobTerminal(job) {
  return job.status === "complete" || job.status === "failed" || job.status === "cancelled";
}

function cancelVideoDownloadJob(job) {
  if (!job || isVideoDownloadJobTerminal(job)) {
    return false;
  }

  job.status = "cancelled";
  job.error = "Video download cancelled.";
  job.finishedAt = new Date().toISOString();
  for (const item of job.items) {
    if (item.status === "queued" || item.status === "downloading") {
      item.status = "cancelled";
      item.error = "Video download cancelled.";
    }
  }
  job.abortController?.abort();
  recomputeVideoDownloadJob(job);
  return true;
}

function pruneVideoDownloadJobs(videoDownloadJobs) {
  const now = Date.now();
  for (const [id, job] of videoDownloadJobs.entries()) {
    if (!job.finishedAt) {
      continue;
    }
    if (now - new Date(job.finishedAt).getTime() > videoDownloadJobTtlMs) {
      videoDownloadJobs.delete(id);
    }
  }

  while (videoDownloadJobs.size > maxVideoDownloadJobs) {
    const oldestCompleted = Array.from(videoDownloadJobs.entries())
      .filter(([_id, job]) => job.finishedAt)
      .sort((left, right) => new Date(left[1].finishedAt).getTime() - new Date(right[1].finishedAt).getTime())[0];
    if (!oldestCompleted) {
      break;
    }
    videoDownloadJobs.delete(oldestCompleted[0]);
  }
}

async function resolveHlsMediaPlaylist(video) {
  const referer = video.referer || video.sourcePage || video.url;
  const customHeaders = normalizeVideoHttpHeaders(video.httpHeaders);
  const playlist = await requestTextResource(video.url, {
    headers: {
      ...videoRequestHeaders,
      ...customHeaders,
      Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,application/x-mpegurl,audio/mpegurl,video/*,*/*;q=0.8",
      Referer: referer
    },
    maxBytes: maxHlsPlaylistBytes
  });
  if (!/^#EXTM3U/m.test(playlist.text)) {
    const error = new Error("URL did not return an HLS playlist.");
    error.code = "NON_VIDEO_RESPONSE";
    throw error;
  }

  const variants = parseHlsMasterPlaylist(playlist.text, playlist.finalUrl);
  if (!variants.length) {
    return playlist;
  }

  const selected = variants
    .sort((left, right) => videoVariantRank(right) - videoVariantRank(left))[0];
  return requestTextResource(selected.url, {
    headers: {
      ...videoRequestHeaders,
      ...customHeaders,
      Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,application/x-mpegurl,audio/mpegurl,video/*,*/*;q=0.8",
      Referer: referer
    },
    maxBytes: maxHlsPlaylistBytes
  });
}

async function writeStreamChunk(output, chunk) {
  if (!output.write(chunk)) {
    await once(output, "drain");
  }
}

async function pipeHlsSegment(segmentUrl, output, video, state, emitProgress) {
  throwIfVideoDownloadCancelled(video.signal);
  const result = await requestVideoStream(segmentUrl, {
    maxBytes: maxSingleVideoBytes,
    timeout: 45000,
    signal: video.signal,
    headers: {
      ...videoRequestHeaders,
      ...normalizeVideoHttpHeaders(video.httpHeaders),
      Referer: video.referer || video.sourcePage || video.url,
      Accept: "video/mp2t,video/mp4,application/octet-stream,*/*;q=0.8"
    }
  });

  await new Promise((resolve, reject) => {
    const abortStream = () => {
      result.stream.destroy(videoDownloadCancelledError());
    };
    video.signal?.addEventListener("abort", abortStream, { once: true });
    const finish = (callback, value) => {
      video.signal?.removeEventListener("abort", abortStream);
      callback(value);
    };
    result.stream.on("data", async (chunk) => {
      result.stream.pause();
      try {
        throwIfVideoDownloadCancelled(video.signal);
        state.bytesWritten += chunk.length;
        if (state.bytesWritten > maxSingleVideoBytes) {
          const error = new Error("Video is larger than 4 GB.");
          error.code = "VIDEO_TOO_LARGE";
          result.stream.destroy(error);
          reject(error);
          return;
        }
        await writeStreamChunk(output, chunk);
        emitProgress();
        result.stream.resume();
      } catch (error) {
        result.stream.destroy(error);
        finish(reject, error);
      }
    });
    result.stream.once("end", () => finish(resolve));
    result.stream.once("error", (error) => finish(reject, error));
  });
}

async function downloadHlsVideoFile(video, outputDir, index, usedNames, options = {}) {
  const playlist = await resolveHlsMediaPlaylist(video);
  const media = parseHlsMediaPlaylist(playlist.text, playlist.finalUrl);
  if (media.encrypted) {
    const error = new Error("Encrypted HLS playlists are not supported.");
    error.code = "HLS_ENCRYPTED";
    throw error;
  }
  if (!media.segments.length) {
    const error = new Error("HLS playlist did not include media segments.");
    error.code = "NON_VIDEO_RESPONSE";
    throw error;
  }
  if (media.segments.length > maxHlsSegments) {
    const error = new Error(`HLS playlist has more than ${maxHlsSegments} segments.`);
    error.code = "VIDEO_TOO_LARGE";
    throw error;
  }

  const ffmpegTool = video.extractor === "missav-page" ? await resolveMediaTool("ffmpeg") : null;
  const remuxToMp4 = Boolean(ffmpegTool);
  const contentType = remuxToMp4 ? "video/mp4" : "video/mp2t";
  const preferredFilename = remuxToMp4
    ? video.filename
    : `${path.parse(video.filename || "video").name}.ts`;
  const filename = makePreferredVideoFilename(playlist.finalUrl, index, contentType, usedNames, preferredFilename);
  const filePath = path.join(outputDir, filename);
  const transportPath = remuxToMp4 ? `${filePath}.transport.ts` : filePath;
  const output = createWriteStream(transportPath, { flags: "wx" });
  const state = {
    bytesWritten: 0,
    lastProgressAt: 0
  };
  const emitProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - state.lastProgressAt < 250) {
      return;
    }
    state.lastProgressAt = now;
    options.onProgress?.({
      bytesWritten: state.bytesWritten,
      bytesTotal: video.bytes || 0,
      filename,
      filePath,
      contentType,
      finalUrl: playlist.finalUrl
    });
  };

  try {
    emitProgress(true);
    for (const segmentUrl of media.segments) {
      throwIfVideoDownloadCancelled(options.signal);
      await pipeHlsSegment(segmentUrl, output, { ...video, url: playlist.finalUrl, signal: options.signal }, state, emitProgress);
    }
    output.end();
    await once(output, "finish");
    if (remuxToMp4) {
      options.onProgress?.({
        progress: 0.97,
        bytesWritten: state.bytesWritten,
        bytesTotal: video.bytes || 0,
        filename,
        filePath,
        contentType,
        finalUrl: playlist.finalUrl
      });
      await execFileAsync(ffmpegTool.command, [
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-n",
        "-i", transportPath,
        "-map", "0:v:0?",
        "-map", "0:a:0?",
        "-c", "copy",
        "-movflags", "+faststart",
        filePath
      ], {
        windowsHide: true,
        timeout: 30 * 60 * 1000,
        signal: options.signal
      });
      await fs.rm(transportPath, { force: true });
    }
    emitProgress(true);
  } catch (error) {
    output.destroy();
    await fs.rm(filePath, { force: true }).catch(() => {});
    await fs.rm(transportPath, { force: true }).catch(() => {});
    throw error;
  }

  const stat = await fs.stat(filePath);

  return {
    url: playlist.finalUrl,
    sourceUrl: video.url,
    sourcePage: video.sourcePage || video.referer || null,
    referer: video.referer || null,
    poster: video.poster || null,
    listIndex: video.listIndex || null,
    filename,
    path: filePath,
    bytes: stat.size,
    contentType,
    outputIndex: index
  };
}

function ytDlpHeaderArgs(headers) {
  const normalized = normalizeVideoHttpHeaders(headers);
  if (!normalized) {
    return [];
  }

  return Object.entries(normalized).flatMap(([name, value]) => [
    "--add-headers",
    `${name}: ${value}`
  ]);
}

function ytDlpOutputTemplate(filePath) {
  return filePath.replace(/%/g, "%%");
}

function parseYtDlpProgressLine(line) {
  const percentMatch = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
  if (!percentMatch) {
    return null;
  }

  const percent = Number(percentMatch[1]);
  if (!Number.isFinite(percent)) {
    return null;
  }

  return Math.max(0, Math.min(1, percent / 100));
}

async function downloadYtDlpVideoFile(video, outputDir, index, usedNames, options = {}) {
  throwIfVideoDownloadCancelled(options.signal);
  const normalized = normalizeVideoRequestList([video], null)[0];
  const sourceUrl = normalized.pageUrl || normalized.sourcePage || normalized.referer || normalized.url;
  const formatSelector = normalized.formatSelector || normalized.formatId || "best[ext=mp4]/best";
  const contentType = videoContentTypeFromExtension(normalized.formatExt) ||
    normalized.contentType ||
    "video/*";
  const filename = makePreferredVideoFilename(normalized.url, index, contentType, usedNames, normalized.filename);
  const filePath = path.join(outputDir, filename);
  const ffmpegTool = await resolveMediaTool("ffmpeg");

  const args = [
    "--no-playlist",
    "--newline",
    "--no-warnings",
    "--no-check-certificate",
    "--no-overwrites",
    "--socket-timeout",
    "30",
    "--max-filesize",
    "4G",
    "-f",
    formatSelector,
    ...(normalized.impersonate ? ["--impersonate", normalized.impersonate] : []),
    ...(normalized.cookiesFile ? ["--cookies", normalized.cookiesFile]
      : normalized.cookiesFromBrowser ? ["--cookies-from-browser", normalized.cookiesFromBrowser] : []),
    ...(ffmpegTool ? ["--ffmpeg-location", path.dirname(ffmpegTool.command)] : []),
    "-o",
    ytDlpOutputTemplate(filePath),
    ...ytDlpHeaderArgs(normalized.httpHeaders),
    sourceUrl
  ];

  const child = await spawnYtDlp(args);
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const stderrLines = [];
  let childExited = false;
  let aborted = false;
  let lastProgress = 0;

  const emitProgress = (progress, force = false) => {
    const nextProgress = Math.max(lastProgress, Math.max(0, Math.min(1, progress)));
    if (!force && nextProgress === lastProgress) {
      return;
    }
    lastProgress = nextProgress;
    options.onProgress?.({
      progress: nextProgress,
      bytesWritten: 0,
      bytesTotal: normalized.bytes || 0,
      filename,
      filePath,
      contentType,
      finalUrl: sourceUrl
    });
  };

  const handleLine = (line) => {
    const progress = parseYtDlpProgressLine(line);
    if (progress != null) {
      emitProgress(progress);
    }
  };

  const handleStdout = (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    lines.forEach(handleLine);
  };

  const handleStderr = (chunk) => {
    stderrBuffer += chunk.toString("utf8");
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) {
        stderrLines.push(line.trim());
        if (stderrLines.length > 8) {
          stderrLines.shift();
        }
      }
      handleLine(line);
    }
  };

  const abortChild = () => {
    aborted = true;
    if (!childExited) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!childExited) {
          child.kill("SIGKILL");
        }
      }, 3000).unref?.();
    }
  };

  options.signal?.addEventListener("abort", abortChild, { once: true });
  emitProgress(0, true);

  try {
    await new Promise((resolve, reject) => {
      child.stdout?.on("data", handleStdout);
      child.stderr?.on("data", handleStderr);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        childExited = true;
        if (stdoutBuffer) {
          handleLine(stdoutBuffer);
        }
        if (stderrBuffer) {
          handleStderr(Buffer.from("\n"));
        }
        if (aborted || options.signal?.aborted) {
          reject(videoDownloadCancelledError());
          return;
        }
        if (code !== 0) {
          const message = stderrLines.length
            ? stderrLines.join(" ")
            : `yt-dlp exited with code ${code ?? signal ?? "unknown"}.`;
          const error = new Error(message);
          error.code = "YTDLP_FAILED";
          reject(error);
          return;
        }
        resolve();
      });
    });
    throwIfVideoDownloadCancelled(options.signal);

    const stat = await fs.stat(filePath);
    if (stat.size > maxSingleVideoBytes) {
      const error = new Error("Video is larger than 4 GB.");
      error.code = "VIDEO_TOO_LARGE";
      throw error;
    }
    emitProgress(1, true);

    return {
      url: normalized.url,
      sourceUrl,
      sourcePage: normalized.sourcePage || normalized.referer || normalized.pageUrl || null,
      referer: normalized.referer || null,
      poster: normalized.poster || null,
      listIndex: normalized.listIndex || null,
      filename,
      path: filePath,
      bytes: stat.size,
      contentType,
      outputIndex: index
    };
  } catch (error) {
    await fs.rm(filePath, { force: true }).catch(() => {});
    await fs.rm(`${filePath}.part`, { force: true }).catch(() => {});
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abortChild);
  }
}

async function downloadVideoResourceToPath(video, filePath, options = {}) {
  const urls = normalizeVideoUrlList([video.url, ...(video.fallbackUrls || [])], video.url);
  if (!urls.length) throw new Error("Video URL did not return a stream.");
  const retryableNetworkCodes = new Set([
    "ECONNRESET", "ECONNABORTED", "ECONNREFUSED", "ETIMEDOUT", "EPIPE",
    "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ERR_STREAM_PREMATURE_CLOSE"
  ]);
  // Prefer a different CDN after an interrupted transfer. When no unused
  // mirror remains, retry the original source, with three total attempts.
  const attempts = [urls[0], urls[1] || urls[0], urls[2] || urls[0]];
  for (let attempt = 0; attempt < attempts.length; attempt++) {
    throwIfVideoDownloadCancelled(options.signal);
    let created = false;
    try {
      let handle, result, meter, limiter, output, abortTransfer;
      try {
        // Own the destination before starting the request. A failed exclusive
        // open must never allow cleanup to remove somebody else's file.
        handle = await fs.open(filePath, "wx");
        created = true;
        throwIfVideoDownloadCancelled(options.signal);
        result = await requestVideoStream(attempts[attempt], {
          maxBytes: maxSingleVideoBytes,
          timeout: 45000,
          signal: options.signal,
          headers: {
            ...videoRequestHeaders,
            ...normalizeVideoHttpHeaders(video.httpHeaders),
            Referer: video.referer || video.sourcePage || video.url,
            Accept: normalizeVideoHttpHeaders(video.httpHeaders)?.Accept || "video/mp4,audio/mp4,video/*,audio/*,*/*;q=0.8"
          }
        });
        let bytesWritten = 0;
        meter = new Transform({
          transform(chunk, _encoding, callback) {
            bytesWritten += chunk.length;
            try {
              options.onProgress?.({ bytesWritten, bytesTotal: result.contentLength || Number(video.bytes || 0) || 0 });
              callback(null, chunk);
            } catch (error) { callback(error); }
          }
        });
        limiter = byteLimitStream(maxSingleVideoBytes, "Video is larger than 4 GB.", "VIDEO_TOO_LARGE");
        // Share ownership with the FileHandle so stream teardown and explicit
        // cleanup coordinate one close instead of closing the raw fd twice.
        output = handle.createWriteStream({ autoClose: true });
        const transferred = pipeline(result.stream, meter, limiter, output);
        abortTransfer = () => {
          const error = videoDownloadCancelledError();
          for (const stream of [result.stream, meter, limiter, output]) stream.destroy(error);
        };
        options.signal?.addEventListener("abort", abortTransfer, { once: true });
        if (options.signal?.aborted) abortTransfer();
        await transferred;
        throwIfVideoDownloadCancelled(options.signal);
        return {
          bytes: bytesWritten,
          bytesTotal: result.contentLength || Number(video.bytes || 0) || bytesWritten,
          finalUrl: result.finalUrl,
          contentType: result.contentType
        };
      } finally {
        if (abortTransfer) options.signal?.removeEventListener("abort", abortTransfer);
        for (const stream of [result?.stream, meter, limiter, output]) stream?.destroy();
        await handle?.close();
      }
    } catch (error) {
      let cleanupError;
      if (created) await fs.rm(filePath, { force: true }).catch((failure) => { cleanupError = failure; });
      throwIfVideoDownloadCancelled(options.signal);
      if (cleanupError) throw cleanupError;
      const status = Number(error.statusCode || 0);
      const hasDifferentMirror = attempt + 1 < attempts.length && attempts[attempt + 1] !== attempts[attempt];
      const retryable = error.name !== "AbortError" && error.code !== "ECANCELLED" && (
        retryableNetworkCodes.has(error.code) || status === 408 || status === 429 ||
        (status >= 500 && status <= 599) || (status === 403 && hasDifferentMirror)
      );
      if (!retryable || attempt === attempts.length - 1) throw error;
    }
  }
}

function makePreferredAudioFilename(index, usedNames, preferredFilename) {
  const preferred = sanitizeFileName(preferredFilename || `bilibili-audio-${index}.mp3`);
  const extension = path.extname(preferred);
  const stem = extension ? preferred.slice(0, -extension.length) : preferred;
  const baseName = `${stem || `bilibili-audio-${index}`}.mp3`;
  let filename = `${String(index).padStart(3, "0")}-${baseName}`;
  let attempt = 2;
  while (usedNames.has(filename.toLowerCase())) {
    filename = `${String(index).padStart(3, "0")}-${stem}-${attempt}.mp3`;
    attempt++;
  }
  usedNames.add(filename.toLowerCase());
  return filename;
}

async function downloadBilibiliAudioFile(video, outputDir, index, usedNames, options = {}) {
  throwIfVideoDownloadCancelled(options.signal);
  const normalized = normalizeVideoRequestList([video], null)[0];
  const ffmpegTool = await resolveMediaTool("ffmpeg");
  if (!ffmpegTool) {
    const error = new Error("FFmpeg is required to create a BiliBili MP3 file.");
    error.code = "FFMPEG_UNAVAILABLE";
    throw error;
  }

  const filename = makePreferredAudioFilename(index, usedNames, normalized.filename);
  const filePath = path.join(outputDir, filename);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "magic-box-bilibili-audio-"));
  const audioPath = path.join(workDir, "audio.m4s");
  const convertedPath = path.join(workDir, "converted.mp3");
  let published = false;
  let bytesWritten = 0;
  let bytesTotal = Number(normalized.bytes || 0) || 0;

  const emitProgress = (progress) => {
    options.onProgress?.({
      progress,
      bytesWritten,
      bytesTotal,
      filename,
      filePath,
      contentType: "audio/mpeg",
      finalUrl: normalized.url
    });
  };

  try {
    emitProgress(0);
    const downloaded = await downloadVideoResourceToPath(normalized, audioPath, {
      signal: options.signal,
      onProgress(event) {
        bytesWritten = event.bytesWritten;
        bytesTotal = event.bytesTotal || bytesTotal;
        const ratio = bytesTotal > 0 ? Math.min(1, bytesWritten / bytesTotal) : 0.05;
        emitProgress(ratio * 0.88);
      }
    });
    bytesWritten = downloaded.bytes;
    bytesTotal = downloaded.bytesTotal || bytesTotal;
    throwIfVideoDownloadCancelled(options.signal);
    emitProgress(0.9);

    await execFileAsync(ffmpegTool.command, [
      "-nostdin",
      "-hide_banner",
      "-loglevel", "error",
      "-n",
      "-i", audioPath,
      "-vn",
      "-codec:a", "libmp3lame",
      "-q:a", "2",
      convertedPath
    ], {
      windowsHide: true,
      timeout: 30 * 60 * 1000,
      signal: options.signal
    });
    throwIfVideoDownloadCancelled(options.signal);
    // Conversion owns only its private file. A concurrent download or user
    // file at the final name must never be overwritten or removed on failure.
    await fs.copyFile(convertedPath, filePath, fs.constants.COPYFILE_EXCL);
    published = true;
    throwIfVideoDownloadCancelled(options.signal);
    const stat = await fs.stat(filePath);
    emitProgress(1);
    return {
      url: normalized.url,
      sourceUrl: normalized.url,
      sourcePage: normalized.sourcePage || normalized.referer || normalized.pageUrl || null,
      referer: normalized.referer || null,
      poster: normalized.poster || null,
      listIndex: normalized.listIndex || null,
      filename,
      path: filePath,
      bytes: stat.size,
      contentType: "audio/mpeg",
      outputIndex: index
    };
  } catch (error) {
    if (published) await fs.rm(filePath, { force: true }).catch(() => {});
    if (options.signal?.aborted) {
      throw videoDownloadCancelledError();
    }
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function downloadBilibiliDashVideoFile(video, outputDir, index, usedNames, options = {}) {
  throwIfVideoDownloadCancelled(options.signal);
  const normalized = normalizeVideoRequestList([video], null)[0];
  if (!normalized.audioUrl) {
    const error = new Error("BiliBili DASH audio stream was not found.");
    error.code = "BILIBILI_AUDIO_MISSING";
    throw error;
  }

  const ffmpegTool = await resolveMediaTool("ffmpeg");
  if (!ffmpegTool) {
    const error = new Error("FFmpeg is required to combine BiliBili video and audio.");
    error.code = "FFMPEG_UNAVAILABLE";
    throw error;
  }

  const filename = makePreferredVideoFilename(
    normalized.url,
    index,
    "video/mp4",
    usedNames,
    normalized.filename
  );
  const filePath = path.join(outputDir, filename);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "magic-box-bilibili-"));
  const videoPath = path.join(workDir, "video.m4s");
  const audioPath = path.join(workDir, "audio.m4s");
  const mergedPath = path.join(workDir, "merged.mp4");
  let published = false;
  let videoBytes = 0;
  let audioBytes = 0;
  let videoTotal = Number(normalized.bytes || 0) || 0;
  let audioTotal = Number(normalized.audioBytes || 0) || 0;

  const emitProgress = (progress) => {
    options.onProgress?.({
      progress,
      bytesWritten: videoBytes + audioBytes,
      bytesTotal: videoTotal + audioTotal,
      filename,
      filePath,
      contentType: "video/mp4",
      finalUrl: normalized.url
    });
  };

  try {
    emitProgress(0);
    const downloadedVideo = await downloadVideoResourceToPath(normalized, videoPath, {
      signal: options.signal,
      onProgress(event) {
        videoBytes = event.bytesWritten;
        videoTotal = event.bytesTotal || videoTotal;
        const ratio = videoTotal > 0 ? Math.min(1, videoBytes / videoTotal) : 0.05;
        emitProgress(ratio * 0.72);
      }
    });
    videoBytes = downloadedVideo.bytes;
    videoTotal = downloadedVideo.bytesTotal || videoTotal;

    const audioVideo = {
      ...normalized,
      url: normalized.audioUrl,
      fallbackUrls: normalized.audioFallbackUrls,
      bytes: normalized.audioBytes,
      contentType: normalized.audioContentType || "audio/mp4"
    };
    const downloadedAudio = await downloadVideoResourceToPath(audioVideo, audioPath, {
      signal: options.signal,
      onProgress(event) {
        audioBytes = event.bytesWritten;
        audioTotal = event.bytesTotal || audioTotal;
        const ratio = audioTotal > 0 ? Math.min(1, audioBytes / audioTotal) : 0.05;
        emitProgress(0.72 + ratio * 0.23);
      }
    });
    audioBytes = downloadedAudio.bytes;
    audioTotal = downloadedAudio.bytesTotal || audioTotal;
    throwIfVideoDownloadCancelled(options.signal);
    emitProgress(0.96);

    await execFileAsync(ffmpegTool.command, [
      "-nostdin",
      "-hide_banner",
      "-loglevel", "error",
      "-n",
      "-i", videoPath,
      "-i", audioPath,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c", "copy",
      "-movflags", "+faststart",
      mergedPath
    ], {
      windowsHide: true,
      timeout: 30 * 60 * 1000,
      signal: options.signal
    });
    throwIfVideoDownloadCancelled(options.signal);
    // Publish exclusively after muxing, without claiming ownership of a file
    // another download or the user created at the final path in the meantime.
    await fs.copyFile(mergedPath, filePath, fs.constants.COPYFILE_EXCL);
    published = true;
    throwIfVideoDownloadCancelled(options.signal);
    const stat = await fs.stat(filePath);
    emitProgress(1);
    return {
      url: normalized.url,
      sourceUrl: normalized.url,
      sourcePage: normalized.sourcePage || normalized.referer || normalized.pageUrl || null,
      referer: normalized.referer || null,
      poster: normalized.poster || null,
      listIndex: normalized.listIndex || null,
      filename,
      path: filePath,
      bytes: stat.size,
      contentType: "video/mp4",
      outputIndex: index
    };
  } catch (error) {
    if (published) await fs.rm(filePath, { force: true }).catch(() => {});
    if (options.signal?.aborted) {
      throw videoDownloadCancelledError();
    }
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function downloadVideoFile(video, outputDir, index, usedNames, options = {}) {
  throwIfVideoDownloadCancelled(options.signal);
  const normalized = normalizeVideoRequestList([video], null)[0];
  if (normalized.extractor === "yt-dlp") {
    return downloadYtDlpVideoFile(normalized, outputDir, index, usedNames, options);
  }
  if (normalized.extractor === "missav-page") {
    return downloadYtDlpVideoFile({
      ...normalized,
      extractor: "yt-dlp",
      pageUrl: normalized.url,
      sourcePage: normalized.url,
      formatSelector: "best",
      formatExt: "mp4",
      impersonate: normalized.impersonate || "chrome"
    }, outputDir, index, usedNames, options);
  }
  if (normalized.extractor === "bilibili-audio") {
    return downloadBilibiliAudioFile(normalized, outputDir, index, usedNames, options);
  }
  if (normalized.extractor === "bilibili-page" && normalized.audioUrl) {
    return downloadBilibiliDashVideoFile(normalized, outputDir, index, usedNames, options);
  }
  if (normalized.protocol === "hls" || looksLikeHlsPlaylistUrl(normalized.url) || isHlsContentType(normalized.contentType)) {
    return downloadHlsVideoFile(normalized, outputDir, index, usedNames, options);
  }

  const result = await requestVideoStreamWithFallback(normalized, {
    maxBytes: maxSingleVideoBytes,
    timeout: 45000,
    signal: options.signal,
    headers: {
      ...videoRequestHeaders,
      ...normalizeVideoHttpHeaders(normalized.httpHeaders),
      Referer: normalized.referer || normalized.url,
      Accept: normalizeVideoHttpHeaders(normalized.httpHeaders)?.Accept || "video/mp4,video/webm,video/ogg,video/*,*/*;q=0.8"
    }
  });
  throwIfVideoDownloadCancelled(options.signal);

  const contentType = normalizedContentType(result.contentType);
  const hasVideoExtension = looksLikeVideoUrl(result.finalUrl) || looksLikeVideoUrl(normalized.url);
  if (contentType && !contentType.startsWith("video/") && contentType !== "application/octet-stream" && !hasVideoExtension) {
    result.stream.resume();
    const error = new Error("URL did not return a video.");
    error.code = "NON_VIDEO_RESPONSE";
    throw error;
  }

  const filename = makePreferredVideoFilename(result.finalUrl, index, contentType, usedNames, normalized.filename);
  const filePath = path.join(outputDir, filename);
  let bytesWritten = 0;
  let lastProgressAt = 0;
  const emitProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 250) {
      return;
    }
    lastProgressAt = now;
    options.onProgress?.({
      bytesWritten,
      bytesTotal: result.contentLength || normalized.bytes || 0,
      filename,
      filePath,
      contentType: contentType || result.contentType || "video/*",
      finalUrl: result.finalUrl
    });
  };
  emitProgress(true);
  const byteCounter = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        throwIfVideoDownloadCancelled(options.signal);
        bytesWritten += chunk.length;
        emitProgress();
        callback(null, chunk);
      } catch (error) {
        callback(error);
      }
    }
  });
  const abortStream = () => {
    result.stream.destroy(videoDownloadCancelledError());
  };
  options.signal?.addEventListener("abort", abortStream, { once: true });

  try {
    await pipeline(
      result.stream,
      byteLimitStream(maxSingleVideoBytes, "Video is larger than 4 GB.", "VIDEO_TOO_LARGE"),
      byteCounter,
      createWriteStream(filePath, { flags: "wx" })
    );
    emitProgress(true);
  } catch (error) {
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abortStream);
  }

  return {
    url: result.finalUrl,
    sourceUrl: normalized.url,
    sourcePage: normalized.sourcePage || normalized.referer || null,
    referer: normalized.referer || null,
    poster: normalized.poster || null,
    listIndex: normalized.listIndex || null,
    filename,
    path: filePath,
    bytes: bytesWritten || result.contentLength || 0,
    contentType: contentType || result.contentType || "video/*",
    outputIndex: index
  };
}

async function runVideoDownloadPass(items, outputDir, usedNames, concurrency, options = {}) {
  return mapWithConcurrency(items, concurrency, async ({ video, index, outputIndex }) => {
    const item = { video, index, outputIndex };
    try {
      throwIfVideoDownloadCancelled(options.signal);
      if (index > 0) {
        await sleep((index % Math.max(1, concurrency)) * 350);
      }
      throwIfVideoDownloadCancelled(options.signal);
      options.onItemStart?.(item);
      const file = await downloadVideoFile(video, outputDir, outputIndex, usedNames, {
        signal: options.signal,
        onProgress: (progress) => options.onItemProgress?.(item, progress)
      });
      options.onItemComplete?.(item, file);
      return {
        item,
        file
      };
    } catch (error) {
      const failure = videoFailureDetails(video, error, outputIndex);
      options.onItemFailure?.(item, failure);
      return {
        item,
        failure
      };
    }
  });
}

async function runTrackedVideoDownloadJob(job, pageUrl, videoUrls, outputDir, usedNames, concurrency) {
  job.status = "downloading";
  job.startedAt = new Date().toISOString();
  recomputeVideoDownloadJob(job);

  const itemFor = (item) => job.items[item.index];
  const results = await runVideoDownloadPass(videoDownloadItems(videoUrls), outputDir, usedNames, concurrency, {
    signal: job.abortController?.signal,
    onItemStart(item) {
      if (job.status === "cancelled") {
        return;
      }
      const progressItem = itemFor(item);
      if (!progressItem) {
        return;
      }
      progressItem.status = "downloading";
      progressItem.error = null;
      recomputeVideoDownloadJob(job);
    },
    onItemProgress(item, progress) {
      if (job.status === "cancelled") {
        return;
      }
      const progressItem = itemFor(item);
      if (!progressItem) {
        return;
      }
      progressItem.status = "downloading";
      progressItem.bytesDownloaded = progress.bytesWritten || 0;
      if (progress.bytesTotal) {
        progressItem.bytesTotal = progress.bytesTotal;
      }
      if (progress.filename) {
        progressItem.filename = progress.filename;
      }
      if (Number.isFinite(progress.progress)) {
        progressItem.progress = Math.max(0, Math.min(1, progress.progress));
      } else {
        progressItem.progress = progressItem.bytesTotal > 0
          ? Math.max(0, Math.min(1, progressItem.bytesDownloaded / progressItem.bytesTotal))
          : 0;
      }
      recomputeVideoDownloadJob(job);
    },
    onItemComplete(item, file) {
      if (job.status === "cancelled") {
        return;
      }
      const progressItem = itemFor(item);
      if (!progressItem) {
        return;
      }
      progressItem.status = "complete";
      progressItem.bytesDownloaded = file.bytes || progressItem.bytesDownloaded || 0;
      progressItem.bytesTotal = file.bytes || progressItem.bytesTotal || 0;
      progressItem.progress = 1;
      progressItem.filename = file.filename || progressItem.filename;
      progressItem.path = file.path;
      job.downloaded += 1;
      job.completed += 1;
      recomputeVideoDownloadJob(job);
    },
    onItemFailure(item, failure) {
      if (job.status === "cancelled") {
        return;
      }
      const progressItem = itemFor(item);
      if (!progressItem) {
        return;
      }
      progressItem.status = "failed";
      progressItem.error = failure.error;
      progressItem.errorCode = failure.errorCode;
      job.failed += 1;
      job.completed += 1;
      recomputeVideoDownloadJob(job);
    }
  });
  if (job.status === "cancelled") {
    return job.result;
  }

  const files = [];
  const failed = [];
  for (const result of results) {
    if (result.file) {
      files.push(result.file);
    } else if (result.failure) {
      failed.push(result.failure);
    }
  }

  const payload = {
    outputDir,
    requested: videoUrls.length,
    downloaded: files.length,
    failed: failed.length,
    files,
    failures: failed,
    summary: videoDownloadSummary(outputDir, videoUrls.length, files, failed)
  };

  for (const failure of failed) {
    warnDiagnostic(`Video download failed: ${failure.errorCode} ${failure.url} (${failure.error})`);
  }

  job.status = failed.length ? "failed" : "complete";
  job.result = payload;
  job.error = failed.length ? failed[0]?.error || "Video download failed." : null;
  job.finishedAt = new Date().toISOString();
  recomputeVideoDownloadJob(job);
  await appendVideoHistory(pageUrl, outputDir, videoUrls.length, payload);
  if (job.status === "complete" && files.length && job.assistantTicket) {
    job.assistantTicket.complete({ producerEventId: `videos:${job.id}`, files: files.map((file) => file.path) });
  }
  return payload;
}

function imageDownloadItems(images) {
  return images.map((image, index) => ({
    image,
    index,
    outputIndex: downloadOutputIndex(image, index + 1)
  }));
}

function imageDownloadCancelledError() {
  const error = new Error("Image download cancelled.");
  error.code = "ABORT_ERR";
  return error;
}

function throwIfImageDownloadCancelled(signal) {
  if (signal?.aborted) {
    throw imageDownloadCancelledError();
  }
}

function makeImageDownloadJobId() {
  return `image-job-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function createImageDownloadJob(imageUrls, outputDir) {
  const items = imageUrls.map((image, index) => ({
    index,
    outputIndex: downloadOutputIndex(image, index + 1),
    url: image.url,
    sourcePage: image.sourcePage || image.referer || null,
    referer: image.referer || null,
    pageNumber: image.pageNumber || null,
    listIndex: image.listIndex || null,
    filename: image.filename || null,
    status: "queued",
    bytesDownloaded: 0,
    bytesTotal: Number(image.bytes || 0) || 0,
    progress: 0,
    attempts: 0,
    error: null,
    errorCode: null,
    refreshAttempted: false,
    refreshSucceeded: false
  }));
  const job = {
    id: makeImageDownloadJobId(),
    abortController: new AbortController(),
    status: "queued",
    outputDir,
    requested: imageUrls.length,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    completed: 0,
    bytesDownloaded: 0,
    bytesTotal: items.reduce((total, item) => total + item.bytesTotal, 0),
    progress: 0,
    percent: 0,
    activeFilename: null,
    attempts: 0,
    items,
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date().toISOString()
  };
  recomputeImageDownloadJob(job);
  return job;
}

function recomputeImageDownloadJob(job) {
  job.bytesDownloaded = job.items.reduce((total, item) => total + Number(item.bytesDownloaded || 0), 0);
  job.bytesTotal = job.items.reduce((total, item) => total + Number(item.bytesTotal || 0), 0);
  const itemProgress = job.requested > 0
    ? job.items.reduce((total, item) => total + Number(item.progress || 0), 0) / job.requested
    : 0;
  job.progress = Math.max(0, Math.min(1, itemProgress));
  job.percent = Math.round(job.progress * 100);
  job.attempts = job.items.reduce((total, item) => total + Number(item.attempts || 0), 0);
  job.activeFilename = job.items.find((item) => item.status === "downloading")?.filename || null;
  job.updatedAt = new Date().toISOString();
}

function imageDownloadJobSnapshot(job) {
  return {
    id: job.id,
    status: job.status,
    outputDir: job.outputDir,
    requested: job.requested,
    downloaded: job.downloaded,
    skipped: job.skipped,
    failed: job.failed,
    completed: job.completed,
    bytesDownloaded: job.bytesDownloaded,
    bytesTotal: job.bytesTotal,
    progress: job.progress,
    percent: job.percent,
    activeFilename: job.activeFilename,
    attempts: job.attempts,
    items: job.items.map((item) => ({ ...item })),
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    updatedAt: job.updatedAt
  };
}

function isImageDownloadJobTerminal(job) {
  return ["complete", "failed", "cancelled"].includes(job?.status);
}

function cancelImageDownloadJob(job) {
  if (!job || isImageDownloadJobTerminal(job)) {
    return false;
  }
  job.status = "cancelled";
  job.error = "Image download cancelled.";
  job.finishedAt = new Date().toISOString();
  for (const item of job.items) {
    if (["queued", "downloading", "retrying"].includes(item.status)) {
      item.status = "cancelled";
      item.error = "Image download cancelled.";
    }
  }
  job.abortController?.abort();
  recomputeImageDownloadJob(job);
  return true;
}

function pruneImageDownloadJobs(imageDownloadJobs) {
  const now = Date.now();
  for (const [id, job] of imageDownloadJobs.entries()) {
    if (job.finishedAt && now - new Date(job.finishedAt).getTime() > imageDownloadJobTtlMs) {
      imageDownloadJobs.delete(id);
    }
  }
  while (imageDownloadJobs.size > maxImageDownloadJobs) {
    const oldest = Array.from(imageDownloadJobs.entries())
      .filter(([_id, job]) => job.finishedAt)
      .sort((left, right) => new Date(left[1].finishedAt).getTime() - new Date(right[1].finishedAt).getTime())[0];
    if (!oldest) {
      break;
    }
    imageDownloadJobs.delete(oldest[0]);
  }
}

function imageAttemptCount(result) {
  return Math.max(1, Number(result?.file?.attempts || result?.skipped?.attempts || result?.failure?.attempts || 1));
}

async function runImageDownloadPass(items, outputDir, usedNames, existingHashes, concurrency, options = {}) {
  return mapWithConcurrency(items, concurrency, async ({ image, index, outputIndex }) => {
    const item = { image, index, outputIndex };
    try {
      throwIfImageDownloadCancelled(options.signal);
      if (index > 0) {
        await sleep((index % Math.max(1, concurrency)) * 350);
      }
      throwIfImageDownloadCancelled(options.signal);
      options.onItemStart?.(item);
      const result = await downloadImageFile(image, outputDir, outputIndex, usedNames, existingHashes, {
        signal: options.signal,
        onProgress: (progress) => options.onItemProgress?.(item, progress)
      });
      if (result.skipped) {
        const skipped = {
          ...result,
          pageLabel: imageFailureLabel(image, outputIndex)
        };
        options.onItemSkipped?.(item, skipped);
        return {
          item,
          skipped
        };
      }

      options.onItemComplete?.(item, result);
      return {
        item,
        file: result
      };
    } catch (error) {
      const failureImage = error.image
        ? mergeImageMetadata(image, error.image)
        : image;
      error.autoRetried = Boolean(options.autoRetried);
      if (error.code === "ABORT_ERR") {
        options.onItemCancelled?.(item);
        return { item, cancelled: true };
      }
      const failure = imageFailureDetails(failureImage, error, outputIndex, options);
      options.onItemFailure?.({ ...item, image: failureImage }, failure);
      return {
        item: { image: failureImage, index, outputIndex },
        failure
      };
    }
  });
}

async function executeImageDownload(pageUrl, imageUrls, outputDir, usedNames, existingHashes, concurrency, options = {}) {
  const files = [];
  const failed = [];
  const skippedDuplicates = [];
  const initialResults = await runImageDownloadPass(imageDownloadItems(imageUrls), outputDir, usedNames, existingHashes, concurrency, {
    signal: options.signal,
    onItemStart: options.onItemStart,
    onItemProgress: options.onItemProgress,
    onItemComplete: options.onItemComplete,
    onItemSkipped: options.onItemSkipped,
    onItemCancelled: options.onItemCancelled,
    onItemFailure(item, failure) {
      if (failure.retryable && !options.signal?.aborted) {
        options.onItemRetry?.(item, failure);
      } else {
        options.onItemFailure?.(item, failure);
      }
    }
  });
  let autoRetried = 0;
  let attempts = initialResults.reduce((total, result) => total + (result.cancelled ? 0 : imageAttemptCount(result)), 0);

  for (const result of initialResults) {
    if (result.file) files.push(result.file);
    else if (result.skipped) skippedDuplicates.push(result.skipped);
    else if (result.failure && !result.failure.retryable) failed.push(result.failure);
  }

  const retryableFailures = options.signal?.aborted ? [] : initialResults.filter((result) => result.failure?.retryable);
  if (retryableFailures.length) {
    autoRetried = retryableFailures.length;
    const rescueItems = retryableFailures.map((result) => ({
      image: { ...result.item.image, ...result.failure },
      index: result.item.index,
      outputIndex: result.item.outputIndex
    }));
    const rescueResults = await runImageDownloadPass(rescueItems, outputDir, usedNames, existingHashes, 1, {
      autoRetried: true,
      signal: options.signal,
      onItemStart: options.onItemRetryStart || options.onItemStart,
      onItemProgress: options.onItemProgress,
      onItemComplete: options.onItemComplete,
      onItemSkipped: options.onItemSkipped,
      onItemFailure: options.onItemFailure,
      onItemCancelled: options.onItemCancelled
    });
    attempts += rescueResults.reduce((total, result) => total + (result.cancelled ? 0 : imageAttemptCount(result)), 0);
    for (const result of rescueResults) {
      if (result.file) files.push(result.file);
      else if (result.skipped) skippedDuplicates.push(result.skipped);
      else if (result.failure) failed.push(result.failure);
    }
  }

  const payload = {
    outputDir,
    requested: imageUrls.length,
    downloaded: files.length,
    skipped: skippedDuplicates.length,
    failed: failed.length,
    cancelled: Boolean(options.signal?.aborted),
    files,
    skippedDuplicates,
    failures: failed,
    autoRetried,
    retryableFailed: failed.filter((failure) => failure.retryable).length,
    attempts,
    summary: imageDownloadSummary(outputDir, imageUrls.length, files, failed, skippedDuplicates)
  };
  await appendImageHistory(pageUrl, outputDir, imageUrls.length, payload);
  return payload;
}

async function runTrackedImageDownloadJob(job, pageUrl, imageUrls, outputDir, usedNames, existingHashes, concurrency) {
  job.status = "downloading";
  job.startedAt = new Date().toISOString();
  recomputeImageDownloadJob(job);
  const itemFor = (item) => job.items[item.index];
  const updateProgress = (item, progress) => {
    if (job.status === "cancelled") return;
    const target = itemFor(item);
    if (!target) return;
    target.status = "downloading";
    target.bytesDownloaded = Number(progress.bytesDownloaded || 0);
    if (progress.bytesTotal) target.bytesTotal = Number(progress.bytesTotal);
    target.progress = Number.isFinite(progress.progress)
      ? Math.max(0, Math.min(1, progress.progress))
      : target.bytesTotal > 0 ? Math.min(1, target.bytesDownloaded / target.bytesTotal) : target.progress;
    recomputeImageDownloadJob(job);
  };
  const completeItem = (item, result, status) => {
    if (job.status === "cancelled") return;
    const target = itemFor(item);
    if (!target || ["complete", "skipped"].includes(target.status)) return;
    const priorAttempts = target.status === "retrying" ? Number(target.attempts || 0) : 0;
    target.status = status;
    target.progress = 1;
    target.bytesDownloaded = Number(result.bytes || target.bytesDownloaded || 0);
    target.bytesTotal = Number(result.bytes || target.bytesTotal || 0);
    target.filename = result.filename || target.filename;
    target.path = result.path || result.duplicatePath || null;
    target.url = result.sourceUrl || target.url;
    target.sourcePage = result.sourcePage || target.sourcePage;
    target.referer = result.referer || target.referer;
    target.attempts = priorAttempts + Number(result.attempts || (priorAttempts ? 0 : target.attempts) || 1);
    target.refreshAttempted = Boolean(result.refreshAttempted);
    target.refreshSucceeded = Boolean(result.refreshSucceeded);
    job.completed += 1;
    if (status === "complete") job.downloaded += 1;
    else job.skipped += 1;
    recomputeImageDownloadJob(job);
  };
  const payload = await executeImageDownload(pageUrl, imageUrls, outputDir, usedNames, existingHashes, concurrency, {
    signal: job.abortController.signal,
    onItemStart(item) {
      if (job.status === "cancelled") return;
      const target = itemFor(item);
      if (target) {
        target.status = "downloading";
        target.error = null;
        recomputeImageDownloadJob(job);
      }
    },
    onItemProgress: updateProgress,
    onItemRetry(item, failure) {
      if (job.status === "cancelled") return;
      const target = itemFor(item);
      if (target) {
        target.status = "retrying";
        target.error = failure.error;
        target.errorCode = failure.errorCode;
        target.attempts = Number(failure.attempts || 1);
        recomputeImageDownloadJob(job);
      }
    },
    onItemRetryStart(item) {
      if (job.status === "cancelled") return;
      const target = itemFor(item);
      if (target) {
        target.status = "retrying";
        recomputeImageDownloadJob(job);
      }
    },
    onItemComplete(item, file) { completeItem(item, file, "complete"); },
    onItemSkipped(item, skipped) { completeItem(item, skipped, "skipped"); },
    onItemFailure(item, failure) {
      if (job.status === "cancelled") return;
      const target = itemFor(item);
      if (!target) return;
      const priorAttempts = target.status === "retrying" ? Number(target.attempts || 0) : 0;
      target.status = "failed";
      target.error = failure.error;
      target.errorCode = failure.errorCode;
      target.url = failure.url || target.url;
      target.sourcePage = failure.sourcePage || target.sourcePage;
      target.referer = failure.referer || target.referer;
      target.attempts = priorAttempts + Number(failure.attempts || (priorAttempts ? 0 : target.attempts) || 1);
      target.refreshAttempted = Boolean(failure.refreshAttempted);
      target.refreshSucceeded = Boolean(failure.refreshSucceeded);
      job.failed += 1;
      job.completed += 1;
      recomputeImageDownloadJob(job);
    }
  });
  job.result = payload;
  if (job.status !== "cancelled") {
    job.status = payload.failed ? "failed" : "complete";
    job.error = payload.failed ? payload.failures[0]?.error || "Image download failed." : null;
    job.finishedAt = new Date().toISOString();
  }
  recomputeImageDownloadJob(job);
  if (job.status === "complete" && payload.files.length && job.assistantTicket) {
    job.assistantTicket.complete({ producerEventId: `images:${job.id}`, files: payload.files.map((file) => file.path) });
  }
  return payload;
}

async function previewImageFile(image) {
  const normalized = normalizeImageRequestList([image], null)[0];
  const { image: activeImage, response } = await requestImageBufferWithRefresh(normalized);
  const { buffer, contentType, finalUrl } = response;

  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error("URL did not return an image.");
  }

  if (activeImage.crop) {
    return {
      buffer: await cropImageBuffer(buffer, finalUrl, activeImage.crop),
      contentType: "image/png"
    };
  }

  return {
    buffer,
    contentType
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getStatus(torrent, state) {
  if (state?.error) {
    return "error";
  }

  if (torrent.done) {
    return "complete";
  }

  if (state?.paused || torrent.paused) {
    return "paused";
  }

  if (!torrent.ready && !torrent.name) {
    return "metadata";
  }

  return "downloading";
}

function allTorrentFileIndexes(torrent) {
  return torrent.files.map((_file, index) => index);
}

function normalizeSelectedFileIndexes(value, torrent) {
  const files = Array.isArray(torrent?.files) ? torrent.files : [];
  const selected = new Set(
    Array.isArray(value)
      ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 0 && item < files.length)
      : allTorrentFileIndexes(torrent)
  );
  return Array.from(selected).sort((left, right) => left - right);
}

function applyTorrentFileSelection(torrent, selectedFileIndexes) {
  const selected = new Set(normalizeSelectedFileIndexes(selectedFileIndexes, torrent));
  torrent.files.forEach((file, index) => {
    if (selected.has(index)) {
      file.select();
    } else {
      file.deselect();
    }
  });
  return Array.from(selected);
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === modulePath;
}

export function createTorrentApp(options = {}) {
  const app = express();
  const client = new WebTorrent({
    dht: options.dht ?? true,
    lsd: options.lsd ?? true,
    tracker: options.tracker ?? true,
    maxConns: Number(options.maxConns || process.env.TORRENT_MAX_CONNS || 120)
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
  });
  const voiceIngressLimits = normalizeVoiceIngressLimits(options.voiceIngressLimits);
  const voiceIngressSchemas = {
    profile: {
      ...voiceIngressLimits.profile,
      fields: new Set(["metadataJson", "metadata_json", "metadata", "trimStartSeconds", "trim_start_seconds", "trimEndSeconds", "trim_end_seconds"]),
      metadataFields: new Set(["metadataJson", "metadata_json", "metadata"]),
      fileFields: new Set(["files"]),
      maxFiles: maxVoiceSourcesPerProfile,
      normalFieldBytes: 64 * 1024
    },
    tts: {
      ...voiceIngressLimits.tts,
      fields: new Set(["profileId", "profile_id", "language", "outputDir", "output_dir", "settingsJson", "settings_json"]),
      metadataFields: new Set(),
      fileFields: new Set(["txtFile", "txt_file"]),
      maxFiles: 1,
      normalFieldBytes: 64 * 1024
    },
    v2v: {
      ...voiceIngressLimits.v2v,
      fields: new Set(["profileId", "profile_id", "modelVersionId", "model_version_id", "language", "outputDir", "output_dir", "settingsJson", "settings_json", "sourceTranscript", "source_transcript", "transcript"]),
      metadataFields: new Set(),
      fileFields: new Set(["sourceAudio", "source_audio"]),
      maxFiles: 1,
      normalFieldBytes: 64 * 1024
    },
    song: {
      ...voiceIngressLimits.song,
      fields: new Set(["profileId", "profile_id", "modelVersionId", "model_version_id", "language", "outputDir", "output_dir", "settingsJson", "settings_json"]),
      metadataFields: new Set(),
      fileFields: new Set(["sourceAudio", "source_audio", "sourceSong", "source_song"]),
      maxFiles: 1,
      normalFieldBytes: 64 * 1024
    },
    rvcModel: {
      ...voiceIngressLimits.rvcModel,
      fields: new Set(["profileId", "profileVersionId", "modelId"]),
      metadataFields: new Set(),
      fileFields: new Set(["modelFile", "indexFile", "smokeAudio"]),
      maxFiles: 3,
      normalFieldBytes: 64 * 1024
    }
  };
  const voiceIngressSweep = Promise.all([
    sweepVoiceIngressArtifacts(),
    sweepLocalQualityReviewArtifacts()
  ]).catch((error) => {
    warnDiagnostic(`Voice Clone local artifact cleanup failed: ${error.message}`);
  });
  const torrentState = new Map();
  const imageDownloadJobs = new Map();
  const videoDownloadJobs = new Map();
  const voiceJobs = new Map();
  const voiceGpuScheduler = createVoiceGpuScheduler({
    statePath: path.join(voiceDataRootDir(), "voice-gpu-scheduler.json"),
    maxHeavyJobs: 1,
    logger: warnDiagnostic
  });
  void voiceGpuScheduler.restore();
  let liveVoiceService = null;
  const configuredPort = Number(options.port ?? process.env.PORT ?? 3099);
  let actualPort = configuredPort;
  const host = options.host || process.env.HOST || "127.0.0.1";
  const defaultDownloadDir = path.resolve(
    options.defaultDownloadDir || process.env.TORRENT_DOWNLOAD_DIR || fallbackDownloadDir
  );
  const assistantDataDir = path.resolve(
    options.assistantDataDir || process.env.MAGIC_BOX_ASSISTANT_DATA_DIR || path.join(path.dirname(settingsFilePath()), "assistant")
  );
  const assistantManager = createAssistantManager({
    dataDir: assistantDataDir,
    voiceProfileStorePath: path.join(voiceDataRootDir(), "profiles"),
    providers: options.assistantProviders || []
  });
  const acquireSeedVcResources = async ({ signal = null } = {}) => {
    const scheduledResource = await voiceGpuScheduler.acquire({
      id: makeVoiceId("voice-gpu-seed-vc"),
      kind: "seed-vc-refinement",
      priority: VOICE_GPU_PRIORITIES.interactiveTtv,
      signal
    });
    const releaseRefinementSlot = scheduledResource.release;
    const diagnostics = {
      serializedSeedVc: true,
      gpuScheduler: "single-heavy-job",
      schedulerJobId: scheduledResource.job.id,
      schedulerPriority: scheduledResource.job.priority,
      liveVoiceWasLoaded: liveVoiceService?.isLoaded?.() === true,
      liveVoiceUnloaded: false,
      liveVoiceRestoreScheduled: false
    };
    if (signal?.aborted) {
      releaseRefinementSlot();
      throw voiceJobCancelledError();
    }
    if (!diagnostics.liveVoiceWasLoaded) {
      return { diagnostics, async release() { releaseRefinementSlot(); } };
    }
    if (liveVoiceService?.hasActiveSessions?.()) {
      const error = new Error("Seed-VC refinement cannot safely unload the live voice runtime while a conversation session is active.");
      error.code = "VOICE_GPU_RESOURCE_BUSY";
      releaseRefinementSlot();
      throw error;
    }
    const preferences = assistantManager.voicePreferences();
    const restoreProfileId = sanitizeUnicodeText(preferences?.profileId || "");
    try {
      await liveVoiceService.unload();
    } catch (error) {
      releaseRefinementSlot();
      throw error;
    }
    diagnostics.liveVoiceUnloaded = true;
    return {
      diagnostics,
      async release() {
        try {
          if (!restoreProfileId || !liveVoiceService || liveVoiceService.hasActiveSessions?.()) return;
          diagnostics.liveVoiceRestoreScheduled = true;
          void (async () => {
            try {
              const db = await readVoiceDb();
              const restoreProfile = getVoiceProfile(db, restoreProfileId);
              if (restoreProfile?.conversationModel?.state === "ready") {
                await liveVoiceService.warmProfile(restoreProfile);
              }
            } catch (error) {
              warnDiagnostic(`Configured live voice could not be restored after Seed-VC: ${sanitizeUnicodeText(error.message || error)}`);
            }
          })();
        } finally {
          releaseRefinementSlot();
        }
      }
    };
  };
  const acquireFineTrainingResources = async ({
    job,
    signal = null,
    workload = "Fine Training",
    schedulerKind = "gpt-sovits-fine-training"
  } = {}) => {
    const scheduledResource = await voiceGpuScheduler.acquire({
      id: makeVoiceId("voice-gpu-fine-training"),
      kind: schedulerKind,
      priority: VOICE_GPU_PRIORITIES.fineBuild,
      metadata: { profileId: job?.profileId || "", voiceJobId: job?.id || "" },
      signal
    });
    const releaseTrainingSlot = scheduledResource.release;
    let assistantGpuSuspension = null;
    const diagnostics = {
      exclusiveGpuLease: true,
      gpuScheduler: "single-heavy-job",
      schedulerJobId: scheduledResource.job.id,
      schedulerPriority: scheduledResource.job.priority,
      liveVoiceWasLoaded: liveVoiceService?.isLoaded?.() === true,
      liveVoiceUnloaded: false,
      persistentVoiceWorkersClosed: false,
      assistantGpuWorkersSuspended: 0,
      assistantGpuRestoreMode: "not-needed",
      liveVoiceRestoreScheduled: false
    };
    if (signal?.aborted) {
      releaseTrainingSlot();
      throw voiceJobCancelledError();
    }
    if (liveVoiceService?.hasActiveSessions?.()) {
      const error = new Error(`${workload} is waiting for the active realtime voice conversation to end before taking exclusive GPU memory.`);
      error.code = "VOICE_GPU_RESOURCE_BUSY";
      releaseTrainingSlot();
      throw error;
    }
    const preferences = assistantManager.voicePreferences();
    const restoreProfileId = sanitizeUnicodeText(preferences?.profileId || "");
    try {
      if (diagnostics.liveVoiceWasLoaded) {
        await liveVoiceService.unload();
        diagnostics.liveVoiceUnloaded = true;
      }
      await closeLiveVoiceWorkerSessions();
      diagnostics.persistentVoiceWorkersClosed = true;
      assistantGpuSuspension = await assistantModelRuntime?.suspendGpuWorkers?.({ reason: workload });
      diagnostics.assistantGpuWorkersSuspended = assistantGpuSuspension?.suspended?.length || 0;
      diagnostics.assistantGpuRestoreMode = diagnostics.assistantGpuWorkersSuspended ? "on-demand" : "not-needed";
    } catch (error) {
      await assistantGpuSuspension?.restore?.().catch(() => {});
      releaseTrainingSlot();
      throw error;
    }
    return {
      diagnostics,
      async release() {
        releaseTrainingSlot();
        // Assistant generation is restored lazily by its next request. This
        // avoids racing a queued Voice Clone GPU lease with eager LLM startup.
        if (!diagnostics.liveVoiceWasLoaded || !restoreProfileId || !liveVoiceService || liveVoiceService.hasActiveSessions?.()) return;
        diagnostics.liveVoiceRestoreScheduled = true;
        void (async () => {
          try {
            const db = await readVoiceDb();
            const restoreProfile = getVoiceProfile(db, restoreProfileId);
            if (restoreProfile?.conversationModel?.state === "ready") {
              await liveVoiceService.warmProfile(restoreProfile);
            }
          } catch (error) {
            warnDiagnostic(`Configured live voice could not be restored after ${workload}: ${sanitizeUnicodeText(error.message || error)}`);
          }
        })();
      }
    };
  };
  const assistantModelRuntime = createLocalModelRuntime({
    manager: assistantManager,
    runtimeRoot: options.assistantRuntimeRoot,
    onRuntimeModeChange(mode) {
      if (mode !== "TEXT_INTERACTIVE" || !liveVoiceService?.unload || liveVoiceService.hasActiveSessions?.()) return;
      void liveVoiceService.unload({ ifIdle: true }).catch(() => {});
    }
  });
  const assistantWorkspaceIndex = createWorkspaceIndex({
    manager: assistantManager,
    modelRuntime: assistantModelRuntime
  });
  const assistantGroundedChat = createGroundedChat({
    manager: assistantManager,
    modelRuntime: assistantModelRuntime,
    workspaceIndex: assistantWorkspaceIndex
  });
  const assistantAutomationEngine = createAutomationEngine({
    manager: assistantManager,
    modelRuntime: assistantModelRuntime
  });
  const assistantToolIntegrations = createToolIntegrations({ manager: assistantManager });
  const fileTransferManager = createFileTransferManager({ defaultDownloadDir, rootDir, assistantIntegration: assistantToolIntegrations });
  const formatFactoryManager = createFormatFactoryManager({ defaultDownloadDir, assistantIntegration: assistantToolIntegrations });

  client.on("error", (error) => {
    errorDiagnostic(`Torrent engine error: ${error.message}`);
  });

  app.use(express.json({ limit: "25mb" }));
  app.use("/api/file-transfer", fileTransferManager.localRouter);
  app.use("/api/format-factory", formatFactoryManager.router);
  app.use("/api/assistant", assistantManager.router);

  function getTorrent(id) {
    return client.torrents.find((torrent) => torrent.infoHash === id);
  }

  function serializeTorrent(torrent) {
    const state = torrentState.get(torrent.infoHash) || {};
    const connectedPeers = Object.values(torrent._peers || {}).filter(
      (peer) => peer.connected
    ).length;
    const selectedIndexes = new Set(
      Array.isArray(state.selectedFileIndexes)
        ? state.selectedFileIndexes
        : allTorrentFileIndexes(torrent)
    );

    return {
      id: torrent.infoHash,
      name: torrent.name || "Fetching metadata",
      status: getStatus(torrent, state),
      error: state.error || null,
      progress: torrent.progress || 0,
      downloaded: bytes(torrent.downloaded),
      length: bytes(torrent.length),
      downloadSpeed: bytes(torrent.downloadSpeed),
      uploadSpeed: bytes(torrent.uploadSpeed),
      ratio: Number.isFinite(torrent.ratio) ? torrent.ratio : 0,
      peers: torrent.numPeers || connectedPeers || 0,
      connectedPeers,
      trackerEnabled: Boolean(client.tracker),
      dhtEnabled: Boolean(client.dht),
      torrentPort: client.torrentPort || null,
      maxConnections: client.maxConns,
      timeRemaining: bytes(torrent.timeRemaining),
      downloadPath: state.downloadPath || torrent.path || defaultDownloadDir,
      addedAt: state.addedAt || Date.now(),
      selectedFileCount: selectedIndexes.size,
      files: torrent.files.map((file, index) => ({
        index,
        name: file.name,
        length: bytes(file.length),
        progress: file.progress || 0,
        selected: selectedIndexes.has(index)
      }))
    };
  }

  function compactTorrentHistory(torrent, state, status) {
    const selectedIndexes = Array.isArray(state.selectedFileIndexes)
      ? state.selectedFileIndexes
      : allTorrentFileIndexes(torrent);
    return {
      type: "torrent",
      id: state.historyId,
      infoHash: torrent.infoHash,
      name: torrent.name || "Fetching metadata",
      sourceType: state.sourceType || "torrent",
      outputDir: state.downloadPath || torrent.path || defaultDownloadDir,
      status,
      selectedFileCount: selectedIndexes.length,
      fileCount: torrent.files.length,
      downloaded: bytes(torrent.downloaded),
      length: bytes(torrent.length),
      progress: torrent.progress || 0
    };
  }

  function recordTorrentHistory(torrent, status) {
    const state = torrentState.get(torrent.infoHash);
    if (!state) {
      return;
    }

    upsertHistoryEntry(
      (item) => item.type === "torrent" && item.infoHash === torrent.infoHash,
      compactTorrentHistory(torrent, state, status)
    ).catch((error) => {
      warnDiagnostic(`Could not write torrent history: ${error.message}`);
    });
  }

  function attachTorrentEvents(torrent, downloadPath, sourceType = "torrent") {
    const existing = torrentState.get(torrent.infoHash);

    torrentState.set(torrent.infoHash, {
      addedAt: existing?.addedAt || Date.now(),
      downloadPath,
      historyId: existing?.historyId || makeHistoryId("torrent"),
      sourceType: existing?.sourceType || sourceType,
      selectedFileIndexes: existing?.selectedFileIndexes || null,
      error: null,
      paused: false
    });

    torrent.once("metadata", () => {
      const state = torrentState.get(torrent.infoHash);
      if (state) {
        state.paused = false;
        state.selectedFileIndexes = normalizeSelectedFileIndexes(state.selectedFileIndexes, torrent);
        applyTorrentFileSelection(torrent, state.selectedFileIndexes);
      }
      recordTorrentHistory(torrent, "metadata");
    });

    torrent.once("done", () => {
      const state = torrentState.get(torrent.infoHash);
      if (state) {
        state.paused = false;
      }
      recordTorrentHistory(torrent, "complete");
    });

    torrent.on("error", (error) => {
      const state = torrentState.get(torrent.infoHash);
      if (state) {
        state.error = error.message;
      }
      recordTorrentHistory(torrent, "error");
    });
  }

  async function addTorrent(torrentId, downloadPathInput, sourceType = "torrent") {
    const downloadPath = await ensureDownloadDir(
      normalizeDownloadDir(downloadPathInput, defaultDownloadDir)
    );

    const torrent = client.add(torrentId, { path: downloadPath });
    attachTorrentEvents(torrent, downloadPath, sourceType);
    recordTorrentHistory(torrent, "added");
    return serializeTorrent(torrent);
  }

  function pauseTorrent(torrent) {
    if (typeof torrent.pause === "function") {
      torrent.pause();
      return;
    }

    torrent.files.forEach((file) => file.deselect());
  }

  function resumeTorrent(torrent) {
    const state = torrentState.get(torrent.infoHash);
    if (typeof torrent.resume === "function") {
      torrent.resume();
    } else {
      torrent.files.forEach((file) => file.select());
    }

    if (state?.selectedFileIndexes) {
      applyTorrentFileSelection(torrent, state.selectedFileIndexes);
    }
  }

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/config", async (_request, response) => {
    const settings = await readSettings();
    response.json({
      port: actualPort,
      defaultDownloadDir,
      savedDownloadDir: settings.downloadPath || null,
      savedToolPaths: settings.toolPaths || null,
      platform: os.platform(),
      maxConnections: client.maxConns,
      dhtEnabled: Boolean(client.dht),
      trackerEnabled: Boolean(client.tracker),
      torrentPort: client.torrentPort || null,
      fileTransferSupported: true
    });
  });

  app.post("/api/settings", async (request, response) => {
    try {
      const current = await readSettings();
      const downloadPath = request.body?.downloadPath
        ? normalizeDownloadDir(request.body.downloadPath, defaultDownloadDir)
        : normalizeDownloadDir(current.downloadPath, defaultDownloadDir);
      const toolPaths = normalizeToolPaths(request.body?.toolPaths || current.toolPaths, downloadPath);
      const settings = await writeSettings({
        ...current,
        downloadPath,
        toolPaths
      });
      response.json(settings);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/system/choose-folder", async (request, response) => {
    try {
      const folder = await chooseDownloadFolder(request.body?.currentPath);
      response.json({ folder });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/system/open-path", async (request, response) => {
    try {
      const openedPath = await openLocalPath(request.body?.path, {
        openFolder: request.body?.folder === true
      });
      response.json({ ok: true, path: openedPath });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/history", async (_request, response) => {
    response.json(await readHistory());
  });

  app.get("/api/history/:id/failures", async (request, response) => {
    const history = await readHistory();
    const entry = history.find((item) => item?.id === request.params.id && item?.type === "image");
    if (!entry) {
      response.status(404).json({ error: "Image download history was not found." });
      return;
    }
    if (!entry.failureManifestId) {
      response.json({ id: entry.id, failures: Array.isArray(entry.failures) ? entry.failures : [] });
      return;
    }
    try {
      const failures = await readImageFailureManifest(entry.failureManifestId);
      response.json({ id: entry.id, failures: Array.isArray(failures) ? failures : [] });
    } catch {
      response.json({ id: entry.id, failures: Array.isArray(entry.failures) ? entry.failures : [] });
    }
  });

  app.delete("/api/history", async (_request, response) => {
    await clearHistory();
    response.status(204).end();
  });

  app.get("/api/voice-clone/health", async (_request, response) => {
    try {
      response.json({ ...(await voiceEngineHealth()), gpuScheduler: voiceGpuScheduler.snapshot() });
    } catch (error) {
      response.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/voice-clone/vtv/engines", async (_request, response) => {
    try {
      const health = await voiceEngineHealth();
      response.json({ engines: health.vtvEngines || {}, defaults: { songEngineId: vtvSeedEngineId, allowFallback: false } });
    } catch (error) {
      response.status(500).json({ code: "ENGINE_RUNTIME_UNHEALTHY", error: sanitizeUnicodeText(error.message || "VTV engine health failed.") });
    }
  });

  app.get("/api/voice-clone/vtv/engines/:engineId/health", async (request, response) => {
    try {
      const health = await voiceEngineHealth();
      const state = health.vtvEngines?.[String(request.params.engineId || "")];
      if (!state) {
        response.status(404).json({ code: "ENGINE_VERSION_INCOMPATIBLE", error: "Unknown VTV engine." });
        return;
      }
      response.json({ engineId: request.params.engineId, ...state });
    } catch (error) {
      response.status(500).json({ code: "ENGINE_RUNTIME_UNHEALTHY", error: sanitizeUnicodeText(error.message || "VTV engine health failed.") });
    }
  });

  app.get("/api/voice-clone/vtv/profiles/:profileId/targets", async (request, response) => {
    try {
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, String(request.params.profileId || ""));
      if (!profile) {
        response.status(404).json({ code: "TARGET_REFERENCE_INVALID", error: "Voice profile was not found." });
        return;
      }
      const targetState = await profileVtvTargetState(profile, {
        samples: db.samples,
        rvcModelId: String(request.query.rvcModelId || ""),
        yingReferenceArtifactId: String(request.query.yingReferenceArtifactId || "")
      });
      response.json({ profileId: profile.id, ...targetState });
    } catch (error) {
      response.status(500).json({ code: String(error.code || "ENGINE_RUNTIME_UNHEALTHY"), error: sanitizeUnicodeText(error.message || "VTV target status could not be read."), action: error.action || "" });
    }
  });

  app.post("/api/voice-clone/rvc/training-jobs", async (request, response) => {
    try {
      const profileId = String(request.body?.profileId || "");
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, profileId);
      if (!profile) {
        response.status(404).json({ code: "TARGET_REFERENCE_INVALID", error: "Voice profile was not found." });
        return;
      }
      const sources = selectRvcProfileTrainingSources(db.samples, profile.id);
      const readiness = assessRvcTrainingReadiness({
        voicedDurationSec: sources.reduce((total, source) => total + source.voicedDurationSec, 0),
        singingDurationSec: sources.reduce((total, source) => total + source.singingDurationSec, 0)
      });
      if (!readiness.ready) {
        response.status(400).json({
          code: "RVC_TRAINING_DATA_INSUFFICIENT",
          error: `RVC training needs at least 10 minutes of approved voice. Add or approve ${readiness.missingVoicedDurationSec.toFixed(1)} more seconds.`,
          action: "Open TTV Profiles, add voice sources, and verify their transcript clips.",
          details: readiness
        });
        return;
      }
      const existing = Array.from(voiceJobs.values()).find((job) => (
        job.type === "rvc_training"
        && job.profileId === profile.id
        && !isVoiceJobTerminal(job)
      ));
      if (existing) {
        response.status(409).json({ code: "RVC_TRAINING_FAILED", error: "An RVC training job is already running for this Profile.", job: voiceJobSnapshot(existing) });
        return;
      }
      const epochs = Math.max(50, Math.min(1000, Number(request.body?.epochs) || 200));
      pruneVoiceJobs(voiceJobs);
      const job = createVoiceJob(voiceJobs, "rvc_training", { profileId: profile.id });
      void runRvcProfileTrainingJob(job, profile.id, { epochs, acquireTrainingResources: acquireFineTrainingResources });
      response.status(202).json(voiceJobSnapshot(job));
    } catch (error) {
      response.status(400).json({
        code: String(error.code || "RVC_TRAINING_FAILED"),
        error: sanitizeUnicodeText(error.message || "RVC training could not be started."),
        action: error.action || "",
        details: error.details || null
      });
    }
  });

  app.post("/api/voice-clone/rvc/models/import", async (request, response) => {
    let imported = null;
    let service = null;
    let ingress = null;
    try {
      const multipart = /^multipart\/form-data(?:;|$)/i.test(String(request.headers["content-type"] || ""));
      ingress = multipart ? await parseVoiceMultipart(request, voiceIngressSchemas.rvcModel) : null;
      const body = ingress?.body || request.body || {};
      const files = ingress?.files || [];
      const modelFile = files.find((file) => file.fieldname === "modelFile");
      const indexFile = files.find((file) => file.fieldname === "indexFile");
      const smokeAudio = files.find((file) => file.fieldname === "smokeAudio");
      let modelPath = modelFile?.path || body.modelPath;
      let indexPath = indexFile?.path || body.indexPath;
      let smokeInputPath = smokeAudio?.path || body.smokeInputPath;
      if (!body.profileId || !modelPath || !indexPath) {
        response.status(400).json({ code: "RVC_MODEL_INSPECTION_FAILED", error: "profileId, a .pth model, and its matching .index file are required." });
        return;
      }
      if (modelFile && !/\.pth$/i.test(modelFile.originalname)) {
        response.status(400).json({ code: "RVC_MODEL_INSPECTION_FAILED", error: "The RVC model file must use the .pth extension." });
        return;
      }
      if (indexFile && !/\.index$/i.test(indexFile.originalname)) {
        response.status(400).json({ code: "RVC_INDEX_MISSING", error: "The RVC feature index must use the .index extension." });
        return;
      }
      if (ingress && modelFile && indexFile) {
        ({ modelPath, indexPath, smokeInputPath } = await stageRvcBrowserUploads({
          ingressDir: ingress.ingressDir,
          modelFile,
          indexFile,
          smokeAudio
        }));
      }
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, String(body.profileId));
      if (!profile) {
        response.status(404).json({ code: "TARGET_REFERENCE_INVALID", error: "Voice profile was not found." });
        return;
      }
      if (!smokeInputPath) {
        smokeInputPath = selectRvcProfileTrainingSources(db.samples, profile.id)[0]?.path || "";
      }
      if (!smokeInputPath) {
        response.status(400).json({
          code: "RVC_TRAINING_DATA_INSUFFICIENT",
          error: "No approved Profile clip is available for automatic RVC validation.",
          action: "Prepare and approve at least one transcript clip on TTV Profiles."
        });
        return;
      }
      const requestedModelId = String(body.modelId || "");
      if (requestedModelId && !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(requestedModelId)) {
        response.status(400).json({ code: "RVC_MODEL_INSPECTION_FAILED", error: "modelId must be a local artifact name, not a path." });
        return;
      }
      const modelId = requestedModelId || makeVoiceId("rvc-model");
      imported = await importRvcModelBundle({
        modelPath,
        indexPath,
        profileId: profile.id,
        profileVersionId: body.profileVersionId,
        modelId,
        destinationDir: path.join(voiceDataRootDir(), "profiles", String(profile.id), "vtv-targets", vtvRvcEngineId, modelId)
      });
      service = await createVtvEngineService({ dataRoot: voiceDataRootDir() });
      await validateAndFinalizeRvcBundle({ imported, smokeInputPath, service });
      response.status(201).json(imported);
    } catch (error) {
      if (imported?.directory) await fs.rm(imported.directory, { recursive: true, force: true }).catch(() => {});
      response.status(400).json({ code: String(error.code || "RVC_MODEL_INSPECTION_FAILED"), error: sanitizeUnicodeText(error.message || "RVC model import failed."), action: error.action || "" });
    } finally {
      if (service) await service.close().catch(() => {});
      if (ingress) await ingress.cleanup().catch(() => {});
    }
  });

  app.post("/api/voice-clone/yingmusic/reference-artifacts/build", async (request, response) => {
    try {
      const body = request.body || {};
      const sourcePaths = Array.isArray(body.sourcePaths) ? body.sourcePaths : (body.sourcePath ? [body.sourcePath] : []);
      if (!body.profileId) {
        response.status(400).json({ code: "TARGET_REFERENCE_INVALID", error: "profileId is required." });
        return;
      }
      const artifactId = String(body.artifactId || `ying-ref-${Date.now()}`);
      let artifact;
      if (sourcePaths.length) {
        artifact = await buildYingMusicReferenceArtifact({
          sourcePaths,
          outputDir: path.join(voiceDataRootDir(), "profiles", String(body.profileId), "vtv-targets", vtvYingMusicEngineId, artifactId),
          profileId: body.profileId,
          profileVersionId: body.profileVersionId,
          artifactId
        });
      } else {
        const db = await readVoiceDb();
        const profile = getVoiceProfile(db, String(body.profileId));
        if (!profile) {
          response.status(404).json({ code: "TARGET_REFERENCE_INVALID", error: "Voice profile was not found." });
          return;
        }
        artifact = await buildYingMusicReferenceFromProfile({
          profile,
          samples: db.samples,
          profileVersionId: body.profileVersionId,
          artifactId
        });
      }
      response.status(201).json(artifact);
    } catch (error) {
      response.status(400).json({ code: String(error.code || "TARGET_REFERENCE_INVALID"), error: sanitizeUnicodeText(error.message || "YingMusic reference build failed."), action: error.action || "" });
    }
  });

  app.get("/api/assistant/live-voice/health", async (request, response) => {
    try {
      const offline = await streamingVoiceOfflineHealth({ force: request.query.verify === "1" });
      if (request.query.warm === "1" && offline.available && liveVoiceService) {
        const runtimeHealth = await liveVoiceService.health();
        response.json({ ...offline, runtime: runtimeHealth, warm: runtimeHealth.warm === true });
        return;
      }
      response.json(offline);
    } catch (error) {
      response.status(500).json({ error: sanitizeUnicodeText(error.message || "Streaming voice health check failed.") });
    }
  });

  app.post("/api/assistant/live-voice/unload", async (_request, response) => {
    try {
      response.json(liveVoiceService ? await liveVoiceService.unload() : { unloaded: true });
    } catch (error) {
      response.status(500).json({ error: sanitizeUnicodeText(error.message || "Voice models could not be unloaded.") });
    }
  });

  app.post("/api/voice-clone/profiles/:profileId/conversation-model", async (request, response) => {
    try {
      pruneVoiceJobs(voiceJobs);
      let db = await readVoiceDb();
      let profile = getVoiceProfile(db, String(request.params.profileId || ""));
      if (!profile) {
        response.status(404).json({ error: "Voice profile was not found." });
        return;
      }
      const requestedPrimaryReferenceSegmentId = sanitizeUnicodeText(request.body?.primaryReferenceSegmentId || "").slice(0, 160);
      if (requestedPrimaryReferenceSegmentId) {
        const belongsToProfile = db.samples.some((sample) => sample.profileId === profile.id && (sample.segments || []).some((segment) => segment.id === requestedPrimaryReferenceSegmentId));
        if (!belongsToProfile) throw new Error("The selected primary reference does not belong to this voice profile.");
        profile.conversationPrimaryReferenceSegmentId = requestedPrimaryReferenceSegmentId;
        await writeVoiceDb(db);
      }
      if (!liveVoiceService) throw new Error("The local live voice server is not attached yet.");
      const job = createVoiceJob(voiceJobs, "conversation_voice_build", { profileId: profile.id });
      void runVoiceJob(job, [{
        status: "running",
        progress: 20,
        message: "Preparing multilingual conversation speaker prompt",
        run: async () => {
          await buildConversationVoiceForProfile(job, profile.id);
          if (liveVoiceService) {
            updateVoiceJob(job, { progress: 70, message: "Caching the resident CosyVoice speaker identity" });
            const latestDb = await readVoiceDb();
            const latestProfile = getVoiceProfile(latestDb, profile.id);
            try {
              const warmResult = await liveVoiceService.warmProfile(latestProfile);
              if (!warmResult.warmed || !warmResult.speakerFeaturesCached) {
                throw new Error(warmResult.error || "CosyVoice did not persist the speaker prompt features.");
              }
              latestProfile.conversationModel.warmedAt = new Date().toISOString();
              latestProfile.conversationModel.promptSchemaVersion = 2;
              latestProfile.conversationModel.primaryReferenceSegmentId = warmResult.primaryReferenceSegmentId || latestProfile.conversationModel.primaryReferenceSegmentId;
              latestProfile.conversationModel.referenceDiagnostics = Array.isArray(warmResult.referenceDiagnostics) ? warmResult.referenceDiagnostics : latestProfile.conversationModel.referenceDiagnostics;
              latestProfile.conversationModel.excludedReferenceSegmentIds = Array.isArray(warmResult.excludedReferenceSegmentIds) ? warmResult.excludedReferenceSegmentIds : [];
              await writeVoiceDb(latestDb);
              job.result = { profile: publicVoiceProfile(latestProfile, latestDb.samples) };
            } catch (error) {
              latestProfile.conversationModel.state = "failed";
              latestProfile.conversationModel.error = sanitizeUnicodeText(error.message || "Speaker prompt preparation failed.");
              await writeVoiceDb(latestDb);
              throw error;
            }
          }
        }
      }]);
      response.status(202).json(voiceJobSnapshot(job));
    } catch (error) {
      response.status(400).json({ error: sanitizeUnicodeText(error.message || "Conversation voice preparation could not start.") });
    }
  });

  app.post("/api/voice-clone/profiles/:profileId/conversation-model/warm", async (request, response) => {
    try {
      if (!liveVoiceService) throw new Error("The local live voice server is not attached yet.");
      let db = await readVoiceDb();
      let profile = getVoiceProfile(db, String(request.params.profileId || ""));
      if (!profile) {
        response.status(404).json({ error: "Voice profile was not found." });
        return;
      }
      if (Number(profile.conversationModel?.promptSchemaVersion) < 2) {
        profile = await ensureConversationPromptV2(profile.id);
        db = await readVoiceDb();
        profile = getVoiceProfile(db, profile.id);
      }
      const result = await liveVoiceService.warmProfile(profile);
      if (!result.warmed) throw new Error(result.error || "Conversation voice warm-up failed.");
      if (assistantManager.voicePreferences().profileId === profile.id) {
        assistantManager.setVoiceRuntimeState({ effectiveMode: "ready", effectiveProfileId: profile.id });
      }
      profile.conversationModel.warmedAt = new Date().toISOString();
      profile.conversationModel.warmLatencyMs = Number(result.warmLatencyMs) || 0;
      profile.conversationModel.promptSchemaVersion = 2;
      profile.conversationModel.primaryReferenceSegmentId = result.primaryReferenceSegmentId || profile.conversationModel.primaryReferenceSegmentId;
      profile.conversationModel.referenceDiagnostics = Array.isArray(result.referenceDiagnostics) ? result.referenceDiagnostics : profile.conversationModel.referenceDiagnostics;
      profile.conversationModel.excludedReferenceSegmentIds = Array.isArray(result.excludedReferenceSegmentIds) ? result.excludedReferenceSegmentIds : [];
      await writeVoiceDb(db);
      response.json({ ...result, profile: publicVoiceProfile(profile, db.samples) });
    } catch (error) {
      response.status(400).json({ error: sanitizeUnicodeText(error.message || "Conversation voice could not be warmed.") });
    }
  });

  app.delete("/api/voice-clone/profiles/:profileId/conversation-model", async (request, response) => {
    try {
      const profileId = String(request.params.profileId || "");
      await liveVoiceService?.unload();
      await withVoiceProfileMutationLock(profileId, async () => {
        const db = await readVoiceDb();
        const profile = getVoiceProfile(db, profileId);
        if (!profile) throw new Error("Voice profile was not found.");
        const conversationDir = path.resolve(voiceProfileFolder(profileId), "conversation");
        const profileRoot = path.resolve(voiceProfileFolder(profileId));
        if (!conversationDir.startsWith(`${profileRoot}${path.sep}`)) throw new Error("Conversation model path was invalid.");
        await fs.rm(conversationDir, { recursive: true, force: true });
        profile.conversationModel = null;
        profile.updatedAt = new Date().toISOString();
        await writeVoiceDb(db);
      });
      response.status(204).end();
    } catch (error) {
      response.status(400).json({ error: sanitizeUnicodeText(error.message || "Conversation voice could not be removed.") });
    }
  });

  app.post("/api/voice-clone/models/install", async (request, response) => {
    try {
      const platformError = voiceInstallPlatformError();
      if (platformError) throw new Error(platformError);
      pruneVoiceJobs(voiceJobs);
      const requestedEngine = String(request.body?.engine || "").trim().toLowerCase();
      const engine = [seedVcEngineId, voicePreparationEngineId, cosyVoiceStreamingEngineId, whisperTurboStreamingEngineId].includes(requestedEngine)
        ? requestedEngine
        : normalizeVoiceEngine(requestedEngine, { language: request.body?.language || "zh" });
      if ([cosyVoiceStreamingEngineId, whisperTurboStreamingEngineId].includes(engine) && request.body?.licenseAccepted !== true) {
        throw new Error("Accept the Apache-2.0 and MIT model licenses before installing multilingual streaming voice.");
      }
      const job = createVoiceJob(voiceJobs, "model_install");
      runVoiceModelInstallJob(job, engine);
      response.status(202).json(voiceJobSnapshot(job));
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/voice-clone/models/:engine", async (request, response) => {
    try {
      const engine = String(request.params.engine || "").toLowerCase();
      if (![cosyVoiceStreamingEngineId, whisperTurboStreamingEngineId].includes(engine)) {
        response.status(404).json({ error: "Streaming voice model was not found." });
        return;
      }
      if (request.body?.confirmation !== true) throw new Error("Explicit confirmation is required to remove local streaming voice models.");
      await liveVoiceService?.unload();
      const target = path.resolve(voiceEngineRootDir(), "conversation");
      const root = path.resolve(voiceEngineRootDir());
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Streaming voice model path was invalid.");
      await fs.rm(target, { recursive: true, force: true });
      streamingVoiceHealthCache = null;
      response.status(204).end();
    } catch (error) {
      response.status(400).json({ error: sanitizeUnicodeText(error.message || "Streaming voice models could not be removed.") });
    }
  });

  app.get("/api/voice-clone/profiles", async (_request, response) => {
    const db = await readVoiceDb();
    response.json(db.profiles.map((profile) => publicVoiceProfile(profile, db.samples)));
  });

  app.post("/api/voice-clone/profiles/:profileId/warm", async (request, response) => {
    try {
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, String(request.params.profileId || ""));
      if (!profile) {
        response.status(404).json({ error: "Voice profile was not found." });
        return;
      }
      if (profile.status !== "ready" || !profile.voiceModel?.engine) {
        throw new Error("Build this Target Voice Profile before warming conversation audio.");
      }
      const engine = normalizeVoiceEngine(profile.voiceModel.engine, { language: profile.language });
      if (engine !== gptSoVitsEngineId) {
        response.json({ profileId: profile.id, engine, warmed: true });
        return;
      }
      const [voiceResult, asrResult] = await Promise.all([
        callLiveVoiceEngineWorker({
          action: "warm-profile",
          profileId: profile.id,
          voiceModel: profile.voiceModel
        }, { engine }),
        callLiveVoiceEngineWorker({
          action: "warm-waveform",
          referenceAudioPath: profile.voiceModel.referenceAudioPath || "",
          baselineAudioPaths: voiceModelValidationBaselineAudioPaths(profile)
        }, { engine: voicePreparationEngineId })
      ]);
      response.json({
        profileId: profile.id,
        engine,
        warmed: voiceResult.warmed === true && asrResult.warmed === true
      });
    } catch (error) {
      response.status(400).json({ error: sanitizeUnicodeText(error.message || "The trained voice could not be warmed.") });
    }
  });

  app.post("/api/voice-clone/profiles", async (request, response) => {
    try {
      validateVoiceConsent(request.body?.consentConfirmed);
      const profileId = makeVoiceId("voice-profile");
      const now = new Date().toISOString();
      const profile = {
        id: profileId,
        name: normalizeVoiceProfileName(request.body?.name),
        language: normalizeVoiceLanguage(request.body?.language, { allowAuto: false }),
        description: String(request.body?.description || "").trim().slice(0, 300),
        status: "draft",
        sampleCount: 0,
        totalSpeechSeconds: 0,
        qualityScore: 0,
        engine: normalizeVoiceEngine(request.body?.engine, { language: normalizeVoiceLanguage(request.body?.language, { allowAuto: false }) }),
        modelVersion: "",
        qualityMode: "",
        activeModelVersionId: "",
        modelVersions: [],
        consentConfirmed: true,
        localFolderPath: voiceProfileFolder(profileId),
        analysisWarnings: [],
        createdAt: now,
        updatedAt: now
      };
      await fs.mkdir(profile.localFolderPath, { recursive: true });
      const created = await withVoiceProfileMutationLock(profileId, async () => {
        const db = await readVoiceDb();
        db.profiles.unshift(profile);
        await writeVoiceDb(db);
        return publicVoiceProfile(profile, db.samples);
      });
      response.status(201).json(created);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/voice-clone/profiles/:profileId", async (request, response) => {
    try {
      const profileId = String(request.params.profileId || "");
      await withVoiceProfileMutationLock(profileId, async () => {
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, profileId);
      if (!profile) {
        response.status(404).json({ error: "Voice profile was not found." });
        return;
      }
      db.profiles = db.profiles.filter((item) => item.id !== profileId);
      db.samples = db.samples.filter((sample) => sample.profileId !== profileId);
      await writeVoiceDb(db, { deletedProfileIds: [profileId] });
      await fs.rm(voiceProfileFolder(profileId), { recursive: true, force: true });
      response.status(204).end();
      });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  const voiceRouteRegistration = registerVoiceCloneRoutes({
    app,
    voiceIngress: {
      parse(request, schemaName) {
        return parseVoiceMultipart(request, voiceIngressSchemas[schemaName]);
      },
      async cleanup(ingress) {
        await ingress?.cleanup?.();
      },
      async transfer(file, ownership) {
        if (ownership?.kind === "profile") {
          return {
            kind: "profile",
            sample: await saveVoiceSampleFromStagedFile(
              ownership.profile,
              file,
              ownership.trimOptions,
              ownership.metadata
            )
          };
        }
        if (ownership?.kind === "job") {
          const maxDurationSeconds = ownership.mode === "song-v2v"
            ? maxVoiceSongSourceDurationSeconds
            : maxVoiceSourceDurationSeconds;
          return {
            kind: "job",
            source: await saveVoiceSourceAudioFromStagedFile(file, {
              jobId: ownership.job.id,
              maxDurationSeconds
            })
          };
        }
        throw voiceIngressError("invalid_field", "Voice upload ownership was not recognized.", 400);
      }
    },
    profileStore: {
      async get(profileId, options = {}) {
        const db = await readVoiceDb();
        const profile = getVoiceProfile(db, profileId);
        if (profile && ["v2v", "song-v2v"].includes(options.mode)) {
          const modernSongEngineIds = options.mode === "song-v2v" && Array.isArray(options.vtvEngineIds)
            ? options.vtvEngineIds
            : null;
          if (modernSongEngineIds) {
            if (modernSongEngineIds.includes(vtvSeedEngineId)) {
              resolveVoiceProfileForSeedV2v(profile, options.modelVersionId);
            }
          } else if (options.conversionEngine === seedVcEngineId) {
            resolveVoiceProfileForSeedV2v(profile, options.modelVersionId);
          } else {
            resolveVoiceProfileForV2v(profile, options.modelVersionId);
          }
        }
        return {
          db,
          profile,
          samples: profile ? db.samples.filter((sample) => sample.profileId === profile.id) : [],
          maxSources: maxVoiceSourcesPerProfile,
          addedSamples: []
        };
      },
      async stageSample(record, ownedFile, analysis) {
        const sample = analysis?.sample || ownedFile?.sample;
        if (!sample) {
          throw new Error("Voice sample transfer did not produce a durable sample.");
        }
        sample.preparation = {
          ...normalizedVoicePreparation(sample),
          revision: Math.max(1, normalizedVoicePreparation(sample).revision || 1),
          status: "queued",
          vocalPath: "",
          accompanimentPath: "",
          warnings: [],
          failureMessage: "",
          failureDismissedAt: ""
        };
        sample.segments = [];
        record.db.samples.push(sample);
        record.samples.push(sample);
        record.addedSamples.push(sample);
        return sample;
      },
      async finalizePreparation({ profileId, sampleId, preparationRevision, status, errorCode, message }) {
        if (status !== "needs-attention") {
          throw new Error("Voice Preparation finalization only accepts a retriable attention state.");
        }
        return markVoicePreparationNeedsAttention(
          String(profileId || ""),
          String(sampleId || ""),
          Math.max(1, Math.round(Number(preparationRevision) || 1)),
          `${sanitizeUnicodeText(errorCode || "preparation_failed")}: ${sanitizeUnicodeText(message || "Voice Preparation could not be queued.")}`
        );
      },
      async save(record, { rollback = false } = {}) {
        if (rollback) {
          for (const sample of record.addedSamples || []) {
            await Promise.all([
              fs.rm(sample.storedPath, { force: true }),
              fs.rm(path.join(voiceProfileFolder(sample.profileId), "samples", "segments", sample.id), { recursive: true, force: true }),
              fs.rm(path.join(voiceProfileFolder(sample.profileId), "samples", "prepared", sample.id), { recursive: true, force: true }),
              fs.rm(path.join(voiceProfileFolder(sample.profileId), "samples", "preparing", sample.id), { recursive: true, force: true })
            ].map((operation) => operation.catch(() => {})));
          }
          record.db.samples = record.db.samples.filter((sample) => !(record.addedSamples || []).includes(sample));
          return null;
        }
        return withVoiceProfileMutationLock(record.profile.id, async () => {
          const currentDb = await readVoiceDb();
          const currentProfile = getVoiceProfile(currentDb, record.profile.id);
          if (!currentProfile) {
            throw new Error("Voice profile was deleted before the uploaded source could be committed.");
          }
          const addedSamples = Array.isArray(record.addedSamples) ? record.addedSamples : [];
          const currentSamples = currentDb.samples.filter((sample) => sample.profileId === currentProfile.id);
          if (currentSamples.length + addedSamples.length > maxVoiceSourcesPerProfile) {
            throw new Error(`Profiles can contain up to ${maxVoiceSourcesPerProfile} training sources.`);
          }
          for (const sample of addedSamples) {
            if (currentDb.samples.some((item) => item.id === sample.id)) {
              throw new Error("A staged voice source was already committed. Refresh the profile before uploading again.");
            }
            currentDb.samples.push(sample);
          }
          const aggregate = aggregateVoiceSampleQuality(currentDb.samples.filter((sample) => sample.profileId === currentProfile.id));
          Object.assign(currentProfile, {
            status: currentProfile.voiceModel?.engine ? "ready" : "draft",
            totalSpeechSeconds: aggregate.totalSpeechSeconds,
            qualityScore: aggregate.qualityScore,
            analysisWarnings: aggregate.warnings,
            updatedAt: new Date().toISOString()
          });
          await writeVoiceDb(currentDb);
          record.db = currentDb;
          record.profile = currentProfile;
          record.samples = currentDb.samples.filter((sample) => sample.profileId === currentProfile.id);
          return {
            profile: publicVoiceProfile(currentProfile, currentDb.samples),
            samples: addedSamples.map((sample) => publicVoiceSample(sample, currentProfile.language))
          };
        });
      }
    },
    mediaTools: {
      decodeText(file) {
        return decodeTextFileFromPath(file);
      },
      async analyzeSample(ownedFile) {
        return { sample: ownedFile.sample };
      },
      async inspectSourceInput(ownedFile) {
        return ownedFile.source;
      }
    },
    voiceJobs: {
      create({ type, profileId, sampleId, preparationRevision }) {
        pruneVoiceJobs(voiceJobs);
        const job = createVoiceJob(voiceJobs, type, { profileId, sampleId, preparationRevision });
        Object.defineProperty(job, "dispose", {
          value: async () => {
            voiceJobs.delete(job.id);
            await fs.rm(voiceJobInputsFolder(job.id), { recursive: true, force: true }).catch(() => {});
          },
          enumerable: false
        });
        return job;
      },
      run(job, operation) {
        void Promise.resolve().then(operation);
        return job;
      },
      snapshot(job) {
        return voiceJobSnapshot(job);
      }
    },
    preparationGateway: {
      runProfileSource({ job, profileId, sampleId, revision }) {
        return runVoiceProfilePreparationJob(job, profileId, sampleId, revision);
      }
    },
    engineGateway: {
      runTts({ job, payload }) {
        return runVoiceTtsJob(job, payload.defaultOutputDir, payload, { acquireSeedVcResources });
      },
      runV2v({ job, payload }) {
        return runVoiceV2vJob(job, payload.defaultOutputDir, payload);
      },
      runSongV2v({ job, payload }) {
        return runVoiceSongReplacementJob(job, payload.defaultOutputDir, payload, {
          acquireEngineResources: ({ job: voiceJob, engineId, signal }) => acquireFineTrainingResources({
            job: voiceJob,
            signal,
            workload: `${engineId} Song VTV`,
            schedulerKind: `${engineId}-song-vtv`
          })
        });
      }
    },
    settings: {
      defaultOutputDir() {
        return defaultDownloadDir;
      }
    }
  });

  app.patch("/api/voice-clone/profiles/:profileId/samples/:sampleId", async (request, response) => {
    try {
      const profileId = String(request.params.profileId || "");
      const sampleId = String(request.params.sampleId || "");
      await withVoiceProfileMutationLock(profileId, async () => {
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, profileId);
      if (!profile) {
        response.status(404).json({ error: "Voice profile was not found." });
        return;
      }
      const sample = db.samples.find((item) => item.profileId === profileId && item.id === sampleId);
      if (!sample) {
        response.status(404).json({ error: "Voice sample was not found." });
        return;
      }
      const body = request.body || {};
      const editedWhilePreparationActive = [
        'transcript',
        'transcriptLanguage',
        'transcript_language',
        'trimStartSeconds',
        'trim_start_seconds',
        'trimEndSeconds',
        'trim_end_seconds'
      ].some((key) => Object.prototype.hasOwnProperty.call(body, key));
      if (Object.prototype.hasOwnProperty.call(body, "transcript")) {
        sample.transcript = normalizeVoiceTranscript(body.transcript);
      }
      if (Object.prototype.hasOwnProperty.call(body, "transcriptLanguage") || Object.prototype.hasOwnProperty.call(body, "transcript_language")) {
        sample.transcriptLanguage = normalizeTranscriptLanguage(body.transcriptLanguage ?? body.transcript_language, profile.language);
      }
      if (
        Object.prototype.hasOwnProperty.call(body, "trimStartSeconds")
        || Object.prototype.hasOwnProperty.call(body, "trim_start_seconds")
        || Object.prototype.hasOwnProperty.call(body, "trimEndSeconds")
        || Object.prototype.hasOwnProperty.call(body, "trim_end_seconds")
      ) {
        const trim = parseVoiceTrimOptions(body);
        sample.trimApplied = trim.applied;
        sample.trimStartSeconds = trim.start;
        sample.trimEndSeconds = trim.end;
        sample.normalizedReferenceAudioPath = null;
      }
      if (editedWhilePreparationActive) {
        invalidateVoicePreparationForManualEdit(
          sample,
          'A source edit superseded queued Voice Preparation. The older result was held back; reprocess the source when ready.'
        );
      }
      sample.updatedAt = new Date().toISOString();
      const aggregate = aggregateVoiceSampleQuality(db.samples.filter((item) => item.profileId === profileId));
      Object.assign(profile, {
        status: profile.voiceModel?.engine ? "ready" : profile.status,
        totalSpeechSeconds: aggregate.totalSpeechSeconds,
        qualityScore: aggregate.qualityScore,
        analysisWarnings: aggregate.warnings,
        updatedAt: new Date().toISOString()
      });
      await writeVoiceDb(db);
      response.json({
        profile: publicVoiceProfile(profile, db.samples),
        sample: publicVoiceSample(sample, profile.language)
      });
      });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.patch("/api/voice-clone/profiles/:profileId/samples/:sampleId/segments/:segmentId", async (request, response) => {
    try {
      const profileId = String(request.params.profileId || "");
      const sampleId = String(request.params.sampleId || "");
      const segmentId = String(request.params.segmentId || "");
      await withVoiceProfileMutationLock(profileId, async () => {
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, profileId);
      if (!profile) {
        response.status(404).json({ error: "Voice profile was not found." });
        return;
      }
      const sample = db.samples.find((item) => item.profileId === profileId && item.id === sampleId);
      if (!sample) {
        response.status(404).json({ error: "Voice sample was not found." });
        return;
      }
      const segment = (Array.isArray(sample.segments) ? sample.segments : []).find((item) => item.id === segmentId);
      if (!segment) {
        response.status(404).json({ error: "Voice sample segment was not found." });
        return;
      }
      const body = request.body || {};
      const transcriptSaved = Object.prototype.hasOwnProperty.call(body, "transcript");
      if (transcriptSaved) {
        segment.transcript = normalizeVoiceTranscript(body.transcript);
      }
      if (Object.prototype.hasOwnProperty.call(body, "transcriptLanguage") || Object.prototype.hasOwnProperty.call(body, "transcript_language")) {
        segment.transcriptLanguage = normalizeTranscriptLanguage(body.transcriptLanguage ?? body.transcript_language, profile.language);
      }
      if (transcriptSaved) {
        reviewPreparedTrainingClipTranscript(segment, { autoInclude: true });
      }
      if (Object.prototype.hasOwnProperty.call(body, "includeInTraining") || Object.prototype.hasOwnProperty.call(body, "include_in_training")) {
        const requestedInclusion = Boolean(body.includeInTraining ?? body.include_in_training);
        segment.includeInTraining = requestedInclusion && segment.qualityVerdict === "eligible" && segment.boundary === "complete";
      }
      if (Object.prototype.hasOwnProperty.call(body, "preferredPrompt") || Object.prototype.hasOwnProperty.call(body, "preferred_prompt")) {
        const preferredPrompt = Boolean(body.preferredPrompt ?? body.preferred_prompt);
        if (preferredPrompt && !gptSoVitsSegmentPromptReady(segment, profile.language)) {
          throw new Error("Only an eligible prepared 3-10 second sentence clip with a matching transcript can be used as the GPT-SoVITS prompt.");
        }
        if (preferredPrompt) {
          for (const profileSample of db.samples.filter((item) => item.profileId === profileId)) {
            profileSample.preferredPrompt = false;
            for (const profileSegment of Array.isArray(profileSample.segments) ? profileSample.segments : []) {
              profileSegment.preferredPrompt = false;
            }
          }
          segment.includeInTraining = true;
        }
        segment.preferredPrompt = preferredPrompt;
      }
      if (segment.preferredPrompt) {
        if (!gptSoVitsSegmentPromptReady(segment, profile.language)) {
          throw new Error("A selected GPT-SoVITS prompt must keep a matching transcript and a 3-10 second prepared sentence clip.");
        }
        segment.includeInTraining = true;
      }
      segment.updatedAt = new Date().toISOString();
      invalidateVoicePreparationForManualEdit(
        sample,
        'A clip edit superseded queued Voice Preparation. The older result was held back; reprocess the source when ready.'
      );
      sample.updatedAt = new Date().toISOString();
      Object.assign(profile, {
        status: profile.voiceModel?.engine ? "ready" : profile.status,
        updatedAt: new Date().toISOString()
      });
      await writeVoiceDb(db);
      response.json({
        profile: publicVoiceProfile(profile, db.samples),
        sample: publicVoiceSample(sample, profile.language),
        segment: publicVoiceSampleSegment(sample, segment, profile.language)
      });
      });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.patch("/api/voice-clone/profiles/:profileId/training-clips", async (request, response) => {
    try {
      const profileId = String(request.params.profileId || "");
      await withVoiceProfileMutationLock(profileId, async () => {
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, profileId);
      if (!profile) {
        response.status(404).json({ error: "Voice profile was not found." });
        return;
      }
      if (request.body?.includeAll !== true && request.body?.include_all !== true) {
        response.status(400).json({ error: "Set includeAll to true to include every transcript-ready clip." });
        return;
      }

      let updatedClipCount = 0;
      for (const sample of db.samples.filter((item) => item.profileId === profileId)) {
        const segments = Array.isArray(sample.segments) ? sample.segments : [];
        if (voiceSamplePreparationReady(sample)) {
          for (const segment of segments) {
            if (!voicePreparedSegmentWithinSampleTrim(sample, segment) || !segment.audioPath || segment.qualityVerdict !== "eligible" || segment.boundary !== "complete") {
              continue;
            }
            if (segment.includeInTraining === false) {
              updatedClipCount += 1;
            }
            segment.includeInTraining = true;
            segment.updatedAt = new Date().toISOString();
          }
        }
        sample.updatedAt = new Date().toISOString();
      }
      profile.updatedAt = new Date().toISOString();
      await writeVoiceDb(db);
      response.json({
        updatedClipCount,
        profile: publicVoiceProfile(profile, db.samples)
      });
      });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/voice-clone/profiles/:profileId/samples/:sampleId/preparation-failure/dismiss", async (request, response) => {
    try {
      const profileId = String(request.params.profileId || "");
      const sampleId = String(request.params.sampleId || "");
      const revision = Math.max(0, Math.round(Number(request.body?.preparationRevision) || 0));
      const result = await dismissVoicePreparationFailure(profileId, sampleId, revision);
      if (!result) {
        response.status(404).json({ error: "Voice source preparation failure was not found." });
        return;
      }
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/voice-clone/profiles/:profileId/samples/:sampleId/reprocess", async (request, response) => {
    try {
      pruneVoiceJobs(voiceJobs);
      const profileId = String(request.params.profileId || "");
      const sampleId = String(request.params.sampleId || "");
      await withVoiceProfileMutationLock(profileId, async () => {
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, profileId);
      const sample = db.samples.find((item) => item.profileId === profileId && item.id === sampleId);
      if (!profile || !sample) {
        response.status(404).json({ error: "Voice source was not found." });
        return;
      }
      if (!sample.storedPath || !await pathExists(sample.storedPath)) {
        response.status(400).json({ error: "The original source is unavailable, so it cannot be reprocessed." });
        return;
      }
      const previousPreparation = normalizedVoicePreparation(sample);
      const preparedAudioMatchesCurrentTrim = preparedVoiceAudioMatchesTrim(sample, previousPreparation);
      const requestedPreparedVocalReuse = Boolean(request.body?.reusePreparedVocal ?? request.body?.reuse_prepared_vocal);
      const reusePreparedVocal = Boolean(
        requestedPreparedVocalReuse
        && preparedAudioMatchesCurrentTrim
        && previousPreparation.vocalPath
        && previousPreparation.accompanimentPath
        && pathIsInside(voiceDataRootDir(), previousPreparation.vocalPath)
        && pathIsInside(voiceDataRootDir(), previousPreparation.accompanimentPath)
        && await pathExists(previousPreparation.vocalPath)
        && await pathExists(previousPreparation.accompanimentPath)
      );
      const preparationRevision = Math.max(1, previousPreparation.revision + 1);
      sample.preparation = {
        ...previousPreparation,
        revision: preparationRevision,
        status: "queued",
        warnings: [],
        failureMessage: "",
        failureDismissedAt: ""
      };
      sample.updatedAt = new Date().toISOString();
      profile.updatedAt = new Date().toISOString();
      await writeVoiceDb(db);
      const job = createVoiceJob(voiceJobs, "prepare-profile-source", { profileId, sampleId, preparationRevision });
      void runVoiceProfilePreparationJob(job, profileId, sampleId, preparationRevision, { reusePreparedVocal });
      response.status(202).json({
        job: voiceJobSnapshot(job),
        profile: publicVoiceProfile(profile, db.samples),
        sample: publicVoiceSample(sample, profile.language)
      });
      });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/voice-clone/profiles/:profileId/analyze", async (request, response) => {
    try {
      pruneVoiceJobs(voiceJobs);
      const profileId = String(request.params.profileId || "");
      const db = await readVoiceDb();
      if (!getVoiceProfile(db, profileId)) {
        response.status(404).json({ error: "Voice profile was not found." });
        return;
      }
      const job = createVoiceJob(voiceJobs, "profile_analyze", { profileId });
      runVoiceAnalyzeJob(job, profileId);
      response.status(202).json(voiceJobSnapshot(job));
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/voice-clone/profiles/:profileId/build", async (request, response) => {
    try {
      const qualityMode = String(request.body?.qualityMode || "quick").toLowerCase();
      if (!["quick", "fine"].includes(qualityMode)) {
        response.status(400).json({ error: "Voice Clone qualityMode must be quick or fine." });
        return;
      }
      pruneVoiceJobs(voiceJobs);
      const profileId = String(request.params.profileId || "");
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, profileId);
      if (!profile) {
        response.status(404).json({ error: "Voice profile was not found." });
        return;
      }
      const engine = normalizeVoiceEngine(request.body?.engine || profile.engine, { language: profile.language });
      const job = createVoiceJob(voiceJobs, "profile_build", { profileId });
      runVoiceBuildJob(job, profileId, qualityMode, engine, { acquireFineTrainingResources });
      response.status(202).json(voiceJobSnapshot(job));
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.patch("/api/voice-clone/profiles/:profileId/model-version", async (request, response) => {
    try {
      const profileId = String(request.params.profileId || "");
      const versionId = sanitizeUnicodeText(request.body?.versionId || request.body?.modelVersionId || "");
      if (!versionId) {
        response.status(400).json({ error: "Choose a saved profile version." });
        return;
      }
      await withVoiceProfileMutationLock(profileId, async () => {
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, profileId);
      if (!profile) {
        response.status(404).json({ error: "Voice profile was not found." });
        return;
      }
      const versions = normalizeVoiceModelVersions(profile);
      const version = versions.find((item) => item.id === versionId);
      if (!version) {
        response.status(404).json({ error: "Saved profile version was not found." });
        return;
      }
      applyVoiceModelVersion(profile, version);
      profile.updatedAt = new Date().toISOString();
      await writeVoiceDb(db);
      response.json(publicVoiceProfile(profile, db.samples));
      });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/voice-clone/profiles/:profileId/model-versions/:versionId", async (request, response) => {
    try {
      const profileId = String(request.params.profileId || "");
      const versionId = sanitizeUnicodeText(request.params.versionId || "");
      await withVoiceProfileMutationLock(profileId, async () => {
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, profileId);
      if (!profile) {
        response.status(404).json({ error: "Voice profile was not found." });
        return;
      }
      const restoredProfile = profileWithActiveVoiceModelVersion(profile);
      const versions = normalizeVoiceModelVersions(restoredProfile);
      const version = versions.find((item) => item.id === versionId);
      if (!version) {
        response.status(404).json({ error: "Saved profile version was not found." });
        return;
      }
      if (versionId === restoredProfile.activeModelVersionId || version.active) {
        response.status(409).json({ error: "This model is currently in use. Select another model before deleting it." });
        return;
      }

      const otherVersions = versions.filter((item) => item.id !== versionId);
      const referencedPaths = otherVersions.flatMap((item) => collectVoiceModelAbsolutePaths(item.voiceModel));
      const removedPaths = [];
      const preservedSharedPaths = [];
      for (const candidate of voiceModelArtifactCandidates(restoredProfile, version)) {
        const isReferenced = referencedPaths.some((referencedPath) => (
          candidate.kind === "directory"
            ? pathIsInside(candidate.path, referencedPath)
            : path.resolve(candidate.path).toLowerCase() === path.resolve(referencedPath).toLowerCase()
        ));
        if (isReferenced) {
          preservedSharedPaths.push(candidate.path);
          continue;
        }
        await fs.rm(candidate.path, {
          recursive: candidate.kind === "directory",
          force: true
        });
        removedPaths.push(candidate.path);
      }

      Object.assign(profile, {
        modelVersions: otherVersions.map((item) => ({
          ...item,
          active: item.id === restoredProfile.activeModelVersionId
        })),
        updatedAt: new Date().toISOString()
      });
      await writeVoiceDb(db);
      response.json({
        deletedVersionId: versionId,
        removedPaths,
        preservedSharedPaths,
        profile: publicVoiceProfile(profile, db.samples)
      });
      });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/voice-clone/tts", async (request, response) => {
    try {
      pruneVoiceJobs(voiceJobs);
      const text = sanitizeUnicodeText(request.body?.text || "");
      if (!text.trim()) {
        throw new Error("Enter text to generate.");
      }
      if (text.length > maxVoiceTextLength) {
        throw new Error(`Text is longer than the ${maxVoiceTextLength} character MVP limit.`);
      }
      const settings = normalizeVoiceOutputFormat(parseVoiceSettings(request.body?.settings));
      const profileId = String(request.body?.profileId || request.body?.profile_id || "");
      const db = await readVoiceDb();
      const profile = getVoiceProfile(db, profileId);
      if (!profile) {
        response.status(404).json({ error: "Voice profile was not found." });
        return;
      }
      if (profile.status !== "ready" || !profile.voiceModel?.engine) {
        throw new Error("Build this Target Voice Profile with a local neural engine before generating audio.");
      }
      const job = createVoiceJob(voiceJobs, "tts", { profileId });
      runVoiceTtsJob(job, defaultDownloadDir, {
        profileId,
        text,
        language: normalizeVoiceLanguage(request.body?.language),
        settings,
        outputDir: request.body?.outputDir || request.body?.output_dir
      }, { acquireSeedVcResources });
      response.status(202).json(voiceJobSnapshot(job));
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/voice-clone/preparation-jobs", (_request, response) => {
    pruneVoiceJobs(voiceJobs);
    const activePreparationJobs = Array.from(voiceJobs.values())
      .filter((job) => (
        job.type === "prepare-profile-source"
        && !isVoiceJobTerminal(job)
      ))
      .map((job) => voiceJobSnapshot(job));
    response.json(activePreparationJobs);
  });

  app.get("/api/voice-clone/jobs/:jobId", (request, response) => {
    pruneVoiceJobs(voiceJobs);
    const job = voiceJobs.get(String(request.params.jobId || ""));
    if (!job) {
      void readVoiceDb().then((db) => {
        const persisted = (Array.isArray(db.jobs) ? db.jobs : []).find((item) => item.id === String(request.params.jobId || ""));
        if (!persisted) {
          response.status(404).json({ error: "Voice Clone job was not found." });
          return;
        }
        response.json(sanitizeStructuredText(persisted));
      }).catch(() => response.status(404).json({ error: "Voice Clone job was not found." }));
      return;
    }
    response.json(voiceJobSnapshot(job));
  });

  app.post("/api/voice-clone/jobs/:jobId/cancel", (request, response) => {
    pruneVoiceJobs(voiceJobs);
    const job = voiceJobs.get(String(request.params.jobId || ""));
    if (!job) {
      response.status(404).json({ error: "Voice Clone job was not found." });
      return;
    }
    cancelVoiceJob(job);
    response.json(voiceJobSnapshot(job));
  });

  app.get("/api/voice-clone/history", async (_request, response) => {
    const db = await readVoiceDb();
    response.json(db.outputs.map(publicVoiceOutput));
  });

  app.get("/api/voice-clone/jobs/:jobId/attempts", (request, response) => {
    pruneVoiceJobs(voiceJobs);
    const job = voiceJobs.get(String(request.params.jobId || ""));
    if (!job) {
      response.status(404).json({ error: "Voice Clone job was not found." });
      return;
    }
    const settings = job.result?.output?.settings || {};
    response.json({
      jobId: job.id,
      attempts: Array.isArray(settings.attempts)
        ? settings.attempts
        : Array.isArray(settings.synthesisIntegrity?.attempts)
          ? settings.synthesisIntegrity.attempts
          : [],
      diagnostics: job.diagnostics || null
    });
  });

  app.get("/api/voice-clone/outputs/:outputId/quality-report", async (request, response) => {
    const db = await readVoiceDb();
    const output = db.outputs.find((item) => item.id === String(request.params.outputId || ""));
    if (!output) {
      response.status(404).json({ error: "Voice output was not found." });
      return;
    }
    response.json({
      outputId: output.id,
      qualityReport: publicVoiceOutputSettings(output.settings).qualityReport || null,
      lineage: publicVoiceOutputSettings(output.settings).lineage || null,
      vtvLineage: publicVoiceOutputSettings(output.settings).vtvLineage || null,
      vtvQuality: publicVoiceOutputSettings(output.settings).vtvQuality || null,
      vtvReferencePack: publicVoiceOutputSettings(output.settings).vtvReferencePack || null,
      finalMixGate: publicVoiceOutputSettings(output.settings).finalMixGate || null,
      stemGate: publicVoiceOutputSettings(output.settings).stemGate || null
    });
  });

  app.get("/api/voice-clone/profiles/:profileId/reference-packs", async (request, response) => {
    const db = await readVoiceDb();
    const profile = getVoiceProfile(db, String(request.params.profileId || ""));
    if (!profile) {
      response.status(404).json({ error: "Voice profile was not found." });
      return;
    }
    const model = profileWithActiveVoiceModelVersion(profile).voiceModel || {};
    const referencePacks = model.referencePacks && typeof model.referencePacks === "object"
      ? model.referencePacks
      : { gptPrompt: model.referencePack };
    const vtvPacks = {
      vtvSpeech: buildRuntimeVtvReferencePack(profileWithActiveVoiceModelVersion(profile), model.versionId || profile.activeModelVersionId || "", "speech"),
      vtvSong: buildRuntimeVtvReferencePack(profileWithActiveVoiceModelVersion(profile), model.versionId || profile.activeModelVersionId || "", "song")
    };
    response.json({
      profileId: profile.id,
      packs: Object.entries({ ...referencePacks, ...vtvPacks }).filter(([, pack]) => Boolean(pack)).map(([name, pack]) => ({
        ...pack,
        name,
        purpose: pack.purpose || (name.startsWith("vtv") ? name : "gpt_prompt"),
        complete: name.startsWith("vtv")
          ? validateVtvReferencePackV2(pack, { profileId: profile.id, modelVersionId: model.versionId || profile.activeModelVersionId || "", mode: name === "vtvSong" ? "song" : "speech", requireReady: true }).valid
          : validateReferencePackManifest(pack, { expectedProfileId: profile.id, minimumArtifacts: 1 }).valid
      }))
    });
  });

  app.get("/api/voice-clone/profiles/:profileId/dataset-snapshot", async (request, response) => {
    const db = await readVoiceDb();
    const profile = getVoiceProfile(db, String(request.params.profileId || ""));
    if (!profile) {
      response.status(404).json({ error: "Voice profile was not found." });
      return;
    }
    const samples = db.samples.filter((sample) => sample.profileId === profile.id);
    response.json({
      profileId: profile.id,
      snapshot: {
        ...voiceCloneLineage(profile, samples),
        trainingEngine: profile.voiceModel?.engine || profile.engine || "",
        capturedAt: profile.voiceModel?.datasetSnapshot?.capturedAt || null,
        schemaVersion: profile.voiceModel?.datasetSnapshot?.schemaVersion || null
      }
    });
  });

  const activateVoiceModelVersion = async (request, response) => {
    try {
      const profileId = String(request.params.profileId || "");
      await withVoiceProfileMutationLock(profileId, async () => {
        const db = await readVoiceDb();
        const profile = getVoiceProfile(db, profileId);
        if (!profile) {
          response.status(404).json({ error: "Voice profile was not found." });
          return;
        }
        const versions = normalizeVoiceModelVersions(profile);
        const versionId = sanitizeUnicodeText(request.body?.versionId || request.body?.modelVersionId || "");
        const version = versions.find((item) => item.id === versionId);
        if (!version) {
          response.status(404).json({ error: "Saved profile version was not found." });
          return;
        }
        applyVoiceModelVersion(profile, version);
        await writeVoiceDb(db);
        response.json(publicVoiceProfile(profile, db.samples));
      });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  };
  app.post("/api/voice-clone/models/:modelVersionId/promote", async (request, response) => {
    request.params.profileId = String(request.body?.profileId || request.body?.profile_id || "");
    request.body = { ...(request.body || {}), versionId: request.params.modelVersionId };
    await activateVoiceModelVersion(request, response);
  });
  app.post("/api/voice-clone/models/:modelVersionId/rollback", async (request, response) => {
    request.params.profileId = String(request.body?.profileId || request.body?.profile_id || "");
    request.body = { ...(request.body || {}), versionId: request.params.modelVersionId };
    await activateVoiceModelVersion(request, response);
  });

  app.get("/api/voice-clone/samples/:sampleId/audio", async (request, response) => {
    try {
      const db = await readVoiceDb();
      const sample = db.samples.find((item) => item.id === String(request.params.sampleId || ""));
      if (!sample) {
        response.status(404).json({ error: "Voice sample was not found." });
        return;
      }
      const storedPath = path.resolve(sample.storedPath || "");
      const voiceRoot = path.resolve(voiceDataRootDir());
      if (!storedPath.startsWith(`${voiceRoot}${path.sep}`)) {
        response.status(400).json({ error: "Voice sample path is outside the local Voice Clone data folder." });
        return;
      }
      response.type(voiceAudioContentType(sample.format));
      response.sendFile(storedPath, (error) => {
        if (error && !response.headersSent) {
          response.status(404).json({ error: "Voice sample file was not found." });
        }
      });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/voice-clone/samples/:sampleId/prepared-audio/:kind", async (request, response) => {
    try {
      const db = await readVoiceDb();
      const sample = db.samples.find((item) => item.id === String(request.params.sampleId || ""));
      const preparation = normalizedVoicePreparation(sample);
      const kind = String(request.params.kind || "");
      const audioPath = kind === "vocal" ? preparation.vocalPath : kind === "accompaniment" ? preparation.accompanimentPath : "";
      if (!sample || !audioPath) {
        response.status(404).json({ error: "Prepared voice audio was not found." });
        return;
      }
      const voiceRoot = path.resolve(voiceDataRootDir());
      if (!pathIsInside(voiceRoot, audioPath) || path.resolve(audioPath) === voiceRoot) {
        response.status(400).json({ error: "Prepared voice audio path is outside the local Voice Clone data folder." });
        return;
      }
      response.type("audio/wav");
      response.sendFile(path.resolve(audioPath), (error) => {
        if (error && !response.headersSent) {
          response.status(404).json({ error: "Prepared voice audio file was not found." });
        }
      });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/voice-clone/samples/:sampleId/segments/:segmentId/audio", async (request, response) => {
    try {
      const db = await readVoiceDb();
      const sample = db.samples.find((item) => item.id === String(request.params.sampleId || ""));
      const segment = (Array.isArray(sample?.segments) ? sample.segments : []).find((item) => item.id === String(request.params.segmentId || ""));
      if (!sample || !segment) {
        response.status(404).json({ error: "Voice sample segment was not found." });
        return;
      }
      const audioPath = path.resolve(segment.audioPath || "");
      const voiceRoot = path.resolve(voiceDataRootDir());
      if (!audioPath.startsWith(`${voiceRoot}${path.sep}`)) {
        response.status(400).json({ error: "Voice sample segment path is outside the local Voice Clone data folder." });
        return;
      }
      response.type("audio/wav");
      response.sendFile(audioPath, (error) => {
        if (error && !response.headersSent) {
          response.status(404).json({ error: "Voice sample segment file was not found." });
        }
      });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/voice-clone/outputs/:outputId/audio", async (request, response) => {
    try {
      const db = await readVoiceDb();
      const output = db.outputs.find((item) => item.id === String(request.params.outputId || ""));
      if (!output) {
        response.status(404).json({ error: "Voice output was not found." });
        return;
      }
      response.type("audio/wav");
      response.sendFile(output.outputPath, (error) => {
        if (error && !response.headersSent) {
          response.status(404).json({ error: "Voice output file was not found." });
        }
      });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/voice-clone/outputs/:outputId", async (request, response) => {
    try {
      const outputId = String(request.params.outputId || "");
      await withVoiceProfileMutationLock("voice-output", async () => {
      const db = await readVoiceDb();
      const output = db.outputs.find((item) => item.id === outputId);
      if (!output) {
        response.status(404).json({ error: "Voice output was not found." });
        return;
      }
      db.outputs = db.outputs.filter((item) => item.id !== outputId);
      db.qualityReports = (Array.isArray(db.qualityReports) ? db.qualityReports : [])
        .filter((report) => report.outputId !== outputId);
      db.attempts = (Array.isArray(db.attempts) ? db.attempts : [])
        .filter((attempt) => attempt.outputId !== outputId);
      await writeVoiceDb(db);
      await fs.rm(output.outputPath, { force: true });
      await fs.rm(output.metadataPath, { force: true });
      for (const candidate of Array.isArray(output.settings?.vtvCandidates) ? output.settings.vtvCandidates : []) {
        try {
          const candidatePath = resolveManagedArtifactPath(voiceDataRootDir(), candidate.relativePath);
          if (pathIsInside(voiceDataRootDir(), candidatePath)) await fs.rm(candidatePath, { force: true });
        } catch {}
      }
      response.status(204).end();
      });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/torrents", (_request, response) => {
    response.json(client.torrents.map(serializeTorrent));
  });

  app.post("/api/torrents/magnet", async (request, response) => {
    const magnet = request.body?.magnet?.trim();

    if (!magnet || !magnet.startsWith("magnet:?")) {
      response.status(400).json({ error: "Enter a valid magnet link." });
      return;
    }

    try {
      const torrent = await addTorrent(magnet, request.body?.downloadPath, "magnet");
      response.status(201).json(torrent);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/torrents/file", upload.single("torrent"), async (request, response) => {
    if (!request.file?.buffer) {
      response.status(400).json({ error: "Choose a .torrent file." });
      return;
    }

    try {
      const torrent = await addTorrent(request.file.buffer, request.body?.downloadPath, "file");
      response.status(201).json(torrent);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/torrents/file-json", async (request, response) => {
    const dataBase64 = request.body?.dataBase64;

    if (!dataBase64 || typeof dataBase64 !== "string") {
      response.status(400).json({ error: "Choose a .torrent file." });
      return;
    }

    try {
      const torrent = await addTorrent(
        Buffer.from(dataBase64, "base64"),
        request.body?.downloadPath,
        "file"
      );
      response.status(201).json(torrent);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/torrents/:id/pause", (request, response) => {
    const torrent = getTorrent(request.params.id);

    if (!torrent) {
      response.status(404).json({ error: "Torrent not found." });
      return;
    }

    pauseTorrent(torrent);
    const state = torrentState.get(torrent.infoHash);
    if (state) {
      state.paused = true;
    }

    response.json(serializeTorrent(torrent));
  });

  app.post("/api/torrents/:id/resume", (request, response) => {
    const torrent = getTorrent(request.params.id);

    if (!torrent) {
      response.status(404).json({ error: "Torrent not found." });
      return;
    }

    resumeTorrent(torrent);
    const state = torrentState.get(torrent.infoHash);
    if (state) {
      state.paused = false;
      state.error = null;
    }

    response.json(serializeTorrent(torrent));
  });

  app.post("/api/torrents/:id/files", (request, response) => {
    const torrent = getTorrent(request.params.id);

    if (!torrent) {
      response.status(404).json({ error: "Torrent not found." });
      return;
    }

    if (!Array.isArray(torrent.files) || torrent.files.length === 0) {
      response.status(400).json({ error: "Torrent metadata is not ready yet." });
      return;
    }

    const state = torrentState.get(torrent.infoHash);
    if (!state) {
      response.status(400).json({ error: "Torrent state was not found." });
      return;
    }

    state.selectedFileIndexes = applyTorrentFileSelection(torrent, request.body?.selectedFileIndexes);
    recordTorrentHistory(torrent, "file-selection");
    response.json(serializeTorrent(torrent));
  });

  app.delete("/api/torrents/:id", (request, response) => {
    const torrent = getTorrent(request.params.id);

    if (!torrent) {
      response.status(404).json({ error: "Torrent not found." });
      return;
    }

    client.remove(torrent.infoHash, (error) => {
      if (error) {
        response.status(400).json({ error: error.message });
        return;
      }

      torrentState.delete(torrent.infoHash);
      response.status(204).end();
    });
  });

  app.post("/api/images/scan", async (request, response) => {
    try {
      const result = await scanImagePage(request.body?.pageUrl);
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/images/download", async (request, response) => {
    try {
      const imageUrls = normalizeImageRequestList(request.body?.images, request.body?.pageUrl);
      const outputRootDir = normalizeDownloadDir(
        request.body?.outputDir,
        path.join(defaultDownloadDir, "image-downloads")
      );
      const outputDir = await ensureDownloadDir(request.body?.galleryName
        ? imageGalleryOutputDir(outputRootDir, request.body.galleryName, request.body?.pageUrl)
        : outputRootDir);
      const { usedNames, existingHashes } = await buildOutputFileIndex(outputDir);
      const requestedConcurrency = Number(request.body?.concurrency);
      const downloadConcurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
        ? Math.min(2, Math.floor(requestedConcurrency))
        : 2;

      if (request.body?.background) {
        pruneImageDownloadJobs(imageDownloadJobs);
        const job = createImageDownloadJob(imageUrls, outputDir);
        job.assistantTicket = assistantToolIntegrations.capture("images", { outputRootPath: outputDir, producerJobId: job.id });
        imageDownloadJobs.set(job.id, job);
        runTrackedImageDownloadJob(
          job,
          request.body?.pageUrl,
          imageUrls,
          outputDir,
          usedNames,
          existingHashes,
          downloadConcurrency
        ).catch((error) => {
          if (job.status !== "cancelled") {
            job.status = "failed";
            job.error = error.message || "Image download failed.";
            job.finishedAt = new Date().toISOString();
            recomputeImageDownloadJob(job);
          }
          warnDiagnostic(`Image download job failed: ${error.message}`);
        });
        response.status(202).json(imageDownloadJobSnapshot(job));
        return;
      }

      const assistantTicket = assistantToolIntegrations.capture("images", { outputRootPath: outputDir, producerJobId: `images-sync-${Date.now()}` });
      const payload = await executeImageDownload(
        request.body?.pageUrl,
        imageUrls,
        outputDir,
        usedNames,
        existingHashes,
        downloadConcurrency
      );
      if (!payload.failed && payload.files.length && assistantTicket) {
        assistantTicket.complete({ producerEventId: `images-sync:${Date.now()}:${payload.files.map((file) => file.filename).join("|")}`, files: payload.files.map((file) => file.path) });
      }
      response.json(payload);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/images/download/:jobId", (request, response) => {
    pruneImageDownloadJobs(imageDownloadJobs);
    const job = imageDownloadJobs.get(String(request.params.jobId || ""));
    if (!job) {
      response.status(404).json({ error: "Image download job was not found." });
      return;
    }
    response.json(imageDownloadJobSnapshot(job));
  });

  app.post("/api/images/download/:jobId/cancel", (request, response) => {
    pruneImageDownloadJobs(imageDownloadJobs);
    const job = imageDownloadJobs.get(String(request.params.jobId || ""));
    if (!job) {
      response.status(404).json({ error: "Image download job was not found." });
      return;
    }
    cancelImageDownloadJob(job);
    response.json(imageDownloadJobSnapshot(job));
  });

  app.post("/api/images/preview", async (request, response) => {
    try {
      const result = await previewImageFile(request.body?.image);
      response.type(result.contentType);
      response.send(result.buffer);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/images/preview", async (request, response) => {
    try {
      const referer = typeof request.query?.referer === "string" ? request.query.referer : "";
      const result = await previewImageFile({
        url: request.query?.url,
        referer,
        sourcePage: referer
      });
      response.type(result.contentType);
      response.send(result.buffer);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/videos/scan", async (request, response) => {
    const verifyInBrowser = request.body?.verifyInBrowser === true;
    const controller = new AbortController();
    const onDisconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once("close", onDisconnect);
    try {
      const result = await withTimeout(
        scanVideoPage(request.body?.pageUrl, {
          browser: request.body?.browser,
          bilibiliBrowser: request.body?.bilibiliBrowser,
          cookiesFile: request.body?.cookiesFile,
          verifyInBrowser,
          signal: controller.signal
        }, options.videoScanAdapters || {}),
        verifyInBrowser ? 165000 : videoScanTimeoutMs,
        () => {
          controller.abort();
          return verifyInBrowser
            ? Object.assign(new Error("Browser verification timed out. Complete the site's verification and retry."), { code: "VIDEO_VERIFICATION_TIMEOUT" })
            : videoScanTimeoutError();
        }
      );
      response.json(result);
    } catch (error) {
      const challenge = Boolean(error?.accessBlocked || error?.browserChallenge || ["DOUYIN_SESSION_REQUIRED", "BILIBILI_SESSION_REQUIRED"].includes(error?.code));
      const code = challenge ? "VIDEO_VERIFICATION_REQUIRED" : videoErrorCode(error);
      const canVerifyInBrowser = challenge || [
        "VIDEO_VERIFICATION_REQUIRED", "VIDEO_VERIFICATION_TIMEOUT", "VIDEO_VERIFICATION_CANCELLED",
        "VIDEO_VERIFICATION_BUSY", "VIDEO_BROWSER_UNAVAILABLE", "VIDEO_VERIFIED_NO_MEDIA"
      ].includes(code);
      response.status(400).json({ error: friendlyVideoErrorMessage(error), code, canVerifyInBrowser });
    } finally {
      response.off("close", onDisconnect);
      controller.abort();
    }
  });

  app.post("/api/videos/download", async (request, response) => {
    try {
      const videoUrls = normalizeVideoRequestList(request.body?.videos, request.body?.pageUrl);
      const outputDir = await ensureDownloadDir(
        normalizeDownloadDir(
          request.body?.outputDir,
          path.join(defaultDownloadDir, "video-downloads")
        )
      );
      const usedNames = await buildOutputNameIndex(outputDir);
      const requestedConcurrency = Number(request.body?.concurrency);
      const downloadConcurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
        ? Math.min(2, Math.floor(requestedConcurrency))
        : 2;

      if (request.body?.background) {
        pruneVideoDownloadJobs(videoDownloadJobs);
        const job = createVideoDownloadJob(videoUrls, outputDir);
        job.assistantTicket = assistantToolIntegrations.capture("videos", { outputRootPath: outputDir, producerJobId: job.id });
        videoDownloadJobs.set(job.id, job);

        runTrackedVideoDownloadJob(
          job,
          request.body?.pageUrl,
          videoUrls,
          outputDir,
          usedNames,
          downloadConcurrency
        ).catch((error) => {
          job.status = "failed";
          job.error = error.message || "Video download failed.";
          job.finishedAt = new Date().toISOString();
          recomputeVideoDownloadJob(job);
          warnDiagnostic(`Video download job failed: ${job.error}`);
        });

        response.status(202).json(videoDownloadJobSnapshot(job));
        return;
      }

      const assistantTicket = assistantToolIntegrations.capture("videos", { outputRootPath: outputDir, producerJobId: `videos-sync-${Date.now()}` });
      const results = await runVideoDownloadPass(videoDownloadItems(videoUrls), outputDir, usedNames, downloadConcurrency);
      const files = [];
      const failed = [];

      for (const result of results) {
        if (result.file) {
          files.push(result.file);
        } else if (result.failure) {
          failed.push(result.failure);
        }
      }

      const payload = {
        outputDir,
        requested: videoUrls.length,
        downloaded: files.length,
        failed: failed.length,
        files,
        failures: failed,
        summary: videoDownloadSummary(outputDir, videoUrls.length, files, failed)
      };
      for (const failure of failed) {
        warnDiagnostic(`Video download failed: ${failure.errorCode} ${failure.url} (${failure.error})`);
      }
      await appendVideoHistory(request.body?.pageUrl, outputDir, videoUrls.length, payload);
      if (!failed.length && files.length && assistantTicket) {
        assistantTicket.complete({ producerEventId: `videos-sync:${Date.now()}:${files.map((file) => file.filename).join("|")}`, files: files.map((file) => file.path) });
      }
      response.json(payload);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/videos/download/:jobId", (request, response) => {
    pruneVideoDownloadJobs(videoDownloadJobs);
    const job = videoDownloadJobs.get(String(request.params.jobId || ""));
    if (!job) {
      response.status(404).json({ error: "Video download job was not found." });
      return;
    }

    response.json(videoDownloadJobSnapshot(job));
  });

  app.post("/api/videos/download/:jobId/cancel", (request, response) => {
    pruneVideoDownloadJobs(videoDownloadJobs);
    const job = videoDownloadJobs.get(String(request.params.jobId || ""));
    if (!job) {
      response.status(404).json({ error: "Video download job was not found." });
      return;
    }

    cancelVideoDownloadJob(job);
    response.json(videoDownloadJobSnapshot(job));
  });

  app.get("/api/videos/preview", (request, response) => {
    try {
      proxyVideoStream(request.query?.url, {
        referer: typeof request.query?.referer === "string" ? request.query.referer : "",
        headers: parseVideoHttpHeaders(request.query?.headers),
        range: request.headers.range
      }, response);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  const distDir = path.join(rootDir, "dist");
  app.use(express.static(distDir));
  app.use((request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      next();
      return;
    }

    response.sendFile(path.join(distDir, "index.html"), (error) => {
      if (error) {
        next();
      }
    });
  });

  return {
    app,
    client,
    configuredPort,
    defaultDownloadDir,
    fileTransferManager,
    formatFactoryManager,
    assistantManager,
    assistantModelRuntime,
    assistantWorkspaceIndex,
    assistantGroundedChat,
    assistantAutomationEngine,
    assistantToolIntegrations,
    voiceGpuScheduler,
    voiceRouteRegistration,
    voiceIngressSweep,
    host,
    attachLiveVoice(server) {
      if (liveVoiceService) return liveVoiceService;
      liveVoiceService = createLiveVoiceService({
        server,
        async getProfile(profileId) {
          const db = await readVoiceDb();
          return voiceProfileForPlayback(db, getVoiceProfile(db, profileId));
        },
        getHealth: () => streamingVoiceOfflineHealth(),
        workerCommand: () => voiceEngineWorkerCommand(cosyVoiceStreamingEngineId),
        runtime: {
          ...(approvedQwenRuntime() || {}),
          ffmpegPath: voiceWorkerFfmpegPath(),
          cosyVoiceRepository: path.join(voiceEngineRuntimeDir(cosyVoiceStreamingEngineId), "CosyVoice"),
          cosyVoiceModelDir: voiceEngineModelDir(cosyVoiceStreamingEngineId),
          cosyVoiceModelRevision: cosyVoiceStreamingModelVersion,
          whisperTurboModelDir: voiceEngineModelDir(whisperTurboStreamingEngineId),
          whisperModelRevision: whisperTurboStreamingModelVersion,
          whisperSmallModelDir: path.join(voiceEngineRootDir(), "conversation", "asr", "models", "whisper-small-536b066")
        },
        featureFlags: approvedQwenRuntime() ? { providerId: "qwen3-tts-stream-local", persistentTtsSession: true, trueBistream: false, autoGpuLayers: true } : {},
        logger: warnDiagnostic,
        setRuntimeMode: (mode, details) => assistantModelRuntime.voiceResourceScheduler.setRuntimeMode(mode, details)
      });
      return liveVoiceService;
    },
    async warmConfiguredVoice() {
      await assistantManager.ready;
      const preferences = assistantManager.voicePreferences();
      if (preferences.mode !== "streaming" || !preferences.profileId || !liveVoiceService) return { skipped: true };
      if (process.env.VOICE_STARTUP_WARMUP === "0") return { skipped: true, reason: "feature_disabled" };
      assistantManager.setVoiceRuntimeState({ effectiveMode: "warming", effectiveProfileId: preferences.profileId });
      const offline = await streamingVoiceOfflineHealth();
      if (!offline.available) {
        assistantManager.setVoiceRuntimeState({ effectiveMode: "degraded", effectiveProfileId: null, degradedReason: "tts_runtime_unhealthy" });
        return { skipped: true, reason: "voice-models-unavailable" };
      }
      const db = await readVoiceDb();
      const profile = voiceProfileForPlayback(db, getVoiceProfile(db, preferences.profileId));
      if (!profile?.conversationModel || profile.conversationModel.state !== "ready") {
        assistantManager.setVoiceRuntimeState({ effectiveMode: "degraded", effectiveProfileId: null, degradedReason: "profile_not_ready" });
        return { skipped: true, reason: "profile-not-ready" };
      }
      let result;
      try {
        result = await liveVoiceService.warmProfile(profile);
        if (!result?.warmed) throw new Error(result?.error || "Configured conversation voice warm-up failed.");
      } catch (error) {
        assistantManager.setVoiceRuntimeState({ effectiveMode: "degraded", effectiveProfileId: null, degradedReason: "tts_runtime_unhealthy" });
        throw error;
      }
      assistantManager.setVoiceRuntimeState({ effectiveMode: "ready", effectiveProfileId: preferences.profileId });
      infoDiagnostic(`Configured Assistant voice ${profile.id} is resident and ready.`);
      return result;
    },
    closeLiveVoice() {
      return liveVoiceService?.close() || Promise.resolve();
    },
    setActualPort(port) {
      actualPort = port;
    }
  };
}

export function startServer(options = {}) {
  const context = createTorrentApp(options);

  return Promise.resolve(context.voiceIngressSweep).then(() => new Promise((resolve, reject) => {
    const server = context.app.listen(context.configuredPort, context.host);

    server.once("listening", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : context.configuredPort;
      context.setActualPort(actualPort);
      context.attachLiveVoice(server);
      void context.warmConfiguredVoice().catch((error) => warnDiagnostic(`Assistant voice startup warm-up failed: ${error.message}`));

      infoDiagnostic(`Torrent API listening at http://${context.host}:${actualPort}`);
      infoDiagnostic(`Downloads default to ${context.defaultDownloadDir}`);
      let closePromise = null;
      resolve({
        ...context,
        server,
        port: actualPort,
        url: `http://${context.host}:${actualPort}`,
        close() {
          if (closePromise) return closePromise;
          closePromise = (async () => {
            await new Promise((closeResolve, closeReject) => {
              server.close((serverError) => serverError ? closeReject(serverError) : closeResolve());
              server.closeAllConnections?.();
            });
            await context.fileTransferManager.close();
            await context.formatFactoryManager.close();
            await context.voiceRouteRegistration.close();
            await context.closeLiveVoice();
            await closeLiveVoiceWorkerSessions();
            await flushVoiceJobPersistence();
            await context.assistantManager.close();
            await new Promise((closeResolve, closeReject) => {
              context.client.destroy((clientError) => clientError ? closeReject(clientError) : closeResolve());
            });
          })();
          return closePromise;
        }
      });
    });

    server.once("error", reject);
  }));
}

export {
  applyTorrentFileSelection,
  buildBilibiliPageScannedVideoResults,
  buildBilibiliPageOrApiResults,
  buildDouyinDataScannedVideoResults,
  buildDouyinShareScannedVideoResults,
  buildJavtifulPageScannedVideoResults,
  buildMissAvPageScannedVideoResults,
  buildYtDlpScannedVideoResults,
  compactHistory,
  downloadVideoFile,
  downloadVideoResourceToPath,
  extractBilibiliVideosFromPage,
  extractBilibiliVideosWithBrowserLogin,
  extractBilibiliVideosWithSiteSession,
  extractDouyinVideosFromPage,
  extractJavtifulVideosFromPage,
  extractMissAvVideosFromPage,
  filenameWithOutputExtension,
  parseVideoPageInput,
  normalizeVideoRequestList,
  publicVoiceProfile,
  resolveLocalOpenTarget,
  requestBilibiliPlayInfo,
  runFfmpegVoiceCommand,
  scanVideoPage,
  isSeedSongRepairCandidateUsable,
  isSeedSongAdvisoryCandidateUsable,
  isSeedSongStrictlyAccepted,
  normalizeVoicePreparationArtifactPath,
  preserveProfilesMissingFromStaleVoiceDb,
  selectSeedSongReferenceClips,
  selectFineCheckpointCandidate,
  shouldRenderVideoPageAfterFetchError,
  voicePreparationTimeoutForSource,
  voicePreparationWorkerTimeoutOptions,
  voiceCloneLineage
};

if (isMainModule()) {
  startServer()
    .then((context) => {
      globalThis.magicBoxServerContext = context;
    })
    .catch((error) => {
      errorDiagnostic(error);
      process.exitCode = 1;
    });
}
