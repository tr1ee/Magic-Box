import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeEngineResult } from "../../engine-contract.mjs";
import { VtvEngineError } from "../../engine-errors.mjs";
import { normalizeRvcSettings } from "./presets.mjs";
import { loadRvcModelManifest } from "./model-registry.mjs";

async function sha256(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

export function createRvcV2Adapter({ resolver, workerManager, runtimeManifest = null } = {}) {
  return {
    id: "rvc-v2-finetuned",
    displayName: "RVC v2",
    capabilities: { songVtv: true, speechVtv: false, zeroShot: false, requiresReference: false, requiresTargetModel: true, supportsTraining: true, outputSampleRates: [48000] },
    async getInstallState() { return runtimeManifest ? { installed: true, manifest: runtimeManifest } : { installed: false }; },
    async healthCheck() {
      if (!runtimeManifest) return { ready: false, installed: false, errors: ["RVC v2 runtime manifest is missing."] };
      if (!workerManager) return { ready: false, installed: true, errors: ["RVC v2 worker manager is unavailable."] };
      return workerManager.request({ command: "health" }).catch((error) => ({ ready: false, installed: true, errors: [error.message] }));
    },
    async preflight(context = {}) {
      const target = context.target || {};
      const modelDir = target.directory || target.modelDir || (target.modelId && resolver?.profileTargetDir(context.profileId, this.id) ? path.join(resolver.profileTargetDir(context.profileId, this.id), target.modelId) : "");
      const manifestPath = target.manifestPath || (modelDir ? path.join(modelDir, "model-manifest.json") : "");
      if (!runtimeManifest) return { ready: false, errors: ["RVC v2 runtime is not installed."], action: "Install the pinned RVC v2 runtime." };
      if (!manifestPath) return { ready: false, errors: ["RVC v2 target model is not bound."], action: "Import and bind a .pth + .index model." };
      let model;
      try { model = await loadRvcModelManifest(manifestPath); } catch (error) { return { ready: false, errors: [error.message], action: "Repair or re-import the RVC target model." }; }
      const modelPath = path.join(modelDir, model.weights.path);
      const indexPath = path.join(modelDir, model.index.path);
      const [modelStat, indexStat] = await Promise.all([fs.stat(modelPath).catch(() => null), fs.stat(indexPath).catch(() => null)]);
      if (!modelStat?.isFile() || !indexStat?.isFile()) return { ready: false, errors: ["RVC model or index file is missing."], action: "Re-import the complete .pth + .index bundle." };
      const [modelHash, indexHash] = await Promise.all([sha256(modelPath), sha256(indexPath)]);
      if (modelHash !== model.weights.sha256 || indexHash !== model.index.sha256) return { ready: false, errors: ["RVC model or index hash does not match its manifest."], action: "Re-import the complete .pth + .index bundle." };
      return { ready: true, errors: [], warnings: [], resolvedTarget: { ...model, directory: modelDir, modelPath, indexPath }, runtimeLineage: runtimeManifest };
    },
    normalizeSettings(settings = {}) { return normalizeRvcSettings(settings); },
    async warmup(context) { if (workerManager) await workerManager.request({ command: "load_model", model: context.target }); },
    async convertSong(context, signal) {
      if (!workerManager) throw new VtvEngineError("ENGINE_NOT_INSTALLED", "RVC v2 worker is not installed.", { engineId: this.id, action: "Install the pinned RVC v2 runtime." });
      const outputPath = context.outputPath || path.join(resolver.tempDir(context.jobId, this.id), "converted-vocal.wav");
      const normalizedSettings = this.normalizeSettings(context.settings);
      await workerManager.request({ command: "load_model", model: context.target }, { signal });
      const sourceDurationSec = Number(context.shared?.stemGate?.vocal?.durationSeconds
        || context.shared?.stemGate?.source?.durationSeconds
        || context.shared?.durationSeconds
        || context.sourceDurationSeconds
        || 0);
      const inactivityTimeoutMs = Math.min(6 * 60 * 60 * 1000, Math.max(45 * 60 * 1000, Math.ceil(sourceDurationSec * 30 * 1000)));
      const result = await workerManager.request(
        { command: "infer", jobId: context.engineRunId, inputPath: context.shared.leadVocalPath, outputPath, target: context.target, settings: normalizedSettings, seed: context.seed },
        {
          signal,
          timeoutMs: inactivityTimeoutMs,
          onProgress: (event) => context.onEngineProgress?.({
            stage: event.stage || "rvc.inference.running",
            progress: event.percent != null && Number.isFinite(Number(event.percent)) ? Number(event.percent) / 100 : null,
            elapsedSec: Number(event.elapsedSec) || 0,
            sourceDurationSec: Number(event.sourceDurationSec) || sourceDurationSec
          })
        }
      );
      return normalizeEngineResult({
        ...result,
        engineId: this.id,
        convertedVocalPath: result.outputPath || outputPath,
        lineage: { runtimeManifest: context.runtimeManifest, target: context.target },
        engineMetrics: {
          reportedPitchShift: Number(result.reportedPitchShift ?? normalizedSettings.pitchShiftSemitones),
          seed: result.seed ?? context.seed ?? 31002,
          runtimeFactor: Number(result.runtimeFactor),
          peakVramMiB: Number(result.peakVramMiB),
          chunked: result.chunked === true,
          chunkCount: Number(result.chunkCount) || 1,
          chunkSeconds: Number(result.chunkSeconds) || null,
          requestedChunkSeconds: Number(result.requestedChunkSeconds) || null,
          chunkRetryCount: Number(result.chunkRetryCount) || 0
        }
      }, { engineId: this.id });
    },
    async cancel(jobId) { await workerManager?.request({ command: "cancel", jobId }).catch(() => {}); },
    async unload() { await workerManager?.request({ command: "unload" }).catch(() => {}); }
  };
}
