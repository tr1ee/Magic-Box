import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeEngineResult } from "../../engine-contract.mjs";
import { VtvEngineError } from "../../engine-errors.mjs";
import { validateYingMusicReferenceArtifact } from "./reference-artifact.mjs";
import { normalizeYingMusicSettings } from "./presets.mjs";

export function createYingMusicSvcAdapter({ resolver, workerManager, runtimeManifest = null } = {}) {
  return {
    id: "yingmusic-svc-zero-shot-v1",
    displayName: "YingMusic-SVC",
    capabilities: { songVtv: true, speechVtv: false, zeroShot: true, requiresReference: true, requiresTargetModel: false, supportsTraining: false, outputSampleRates: [44100] },
    async getInstallState() { return runtimeManifest ? { installed: true, manifest: runtimeManifest } : { installed: false }; },
    async healthCheck() {
      if (!runtimeManifest) return { ready: false, installed: false, errors: ["YingMusic-SVC runtime manifest is missing."] };
      return workerManager?.request({ command: "health" }).catch((error) => ({ ready: false, installed: true, errors: [error.message] })) || { ready: false, installed: true, errors: ["YingMusic worker manager is unavailable."] };
    },
    async preflight(context = {}) {
      if (!runtimeManifest) return { ready: false, errors: ["YingMusic-SVC runtime is not installed."], action: "Install the pinned YingMusic-SVC runtime." };
      const target = context.target || {};
      const manifestPath = target.manifestPath || (target.directory ? path.join(target.directory, "artifact-manifest.json") : "");
      if (!manifestPath) return { ready: false, errors: ["YingMusic reference artifact is not bound."], action: "Build a 20–25 second Song Reference Artifact." };
      let manifest;
      try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch (error) { return { ready: false, errors: ["YingMusic reference artifact manifest is unreadable."], action: "Rebuild the reference artifact." }; }
      const validation = validateYingMusicReferenceArtifact(manifest);
      if (!validation.valid) return { ready: false, errors: validation.errors, action: "Build a valid 20–25 second reference artifact." };
      const audioPath = path.join(path.dirname(manifestPath), manifest.audioPath || "target-timbre.wav");
      if (!(await fs.stat(audioPath).catch(() => null))?.isFile()) return { ready: false, errors: ["YingMusic target-timbre.wav is missing."], action: "Rebuild the reference artifact." };
      const audioHash = createHash("sha256").update(await fs.readFile(audioPath)).digest("hex");
      if (audioHash !== manifest.sha256) return { ready: false, errors: ["YingMusic reference artifact hash does not match its manifest."], action: "Rebuild the reference artifact." };
      return { ready: true, errors: [], warnings: [], resolvedTarget: { ...manifest, directory: path.dirname(manifestPath), audioPath, manifestPath }, runtimeLineage: runtimeManifest };
    },
    normalizeSettings(settings = {}) { return normalizeYingMusicSettings(settings); },
    async warmup(context) { await workerManager?.request({ command: "load_model", model: context.target }); },
    async convertSong(context, signal) {
      if (!workerManager) throw new VtvEngineError("ENGINE_NOT_INSTALLED", "YingMusic-SVC worker is not installed.", { engineId: this.id, action: "Install the pinned YingMusic-SVC runtime." });
      const outputPath = context.outputPath || path.join(resolver.tempDir(context.jobId, this.id), "converted-vocal.wav");
      await workerManager.request({ command: "load_model", model: context.target }, { signal });
      const result = await workerManager.request({ command: "infer", jobId: context.engineRunId, inputPath: context.shared.leadVocalPath, target: context.target, outputPath, settings: this.normalizeSettings(context.settings), seed: context.seed }, { signal });
      return normalizeEngineResult({ ...result, engineId: this.id, convertedVocalPath: result.outputPath || outputPath, lineage: { runtimeManifest: context.runtimeManifest, target: context.target }, engineMetrics: { reportedPitchShift: result.reportedPitchShift ?? null, ...(result.metrics || {}) } }, { engineId: this.id });
    },
    async cancel(jobId) { await workerManager?.request({ command: "cancel", jobId }).catch(() => {}); },
    async unload() { await workerManager?.request({ command: "unload" }).catch(() => {}); }
  };
}
