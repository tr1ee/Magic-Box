import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const VOICE_RUNTIME_MODES = Object.freeze([
  "TEXT_INTERACTIVE",
  "VOICE_WARMING",
  "VOICE_READY",
  "VOICE_LISTENING",
  "VOICE_RESPONDING",
  "IDLE_MEMORY_SAVER"
]);

/** Conservative, metadata-backed GPU layer scheduler for the voice worker. */
export class VoiceResourceScheduler {
  constructor({ stateDir, logger = () => {} } = {}) {
    this.stateDir = stateDir || process.cwd();
    this.statePath = path.join(this.stateDir, "voice-resource-scheduler.json");
    this.logger = logger;
    this.cache = new Map();
    this.runtimeMode = "IDLE_MEMORY_SAVER";
    this.runtimeModeChangedAt = new Date().toISOString();
  }

  async readDeviceBudget(device) {
    const total = Number(device?.memoryMiB) || 0;
    let free = 0;
    try {
      const { stdout } = await execFileAsync("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 5000 });
      free = Number(String(stdout).split(/\r?\n/u).map((value) => Number(value.trim())).find((value) => Number.isFinite(value)) || 0);
    } catch {}
    return {
      totalMiB: total,
      freeMiB: free || total,
      ttsP95MiB: Number(process.env.VOICE_TTS_P95_VRAM_MB || 0) || 0,
      asrP95MiB: Number(process.env.VOICE_ASR_P95_VRAM_MB || 0) || 0,
      webviewReserveMiB: Number(process.env.VOICE_WEBVIEW_RESERVE_MB || 768) || 768,
      safetyReserveMiB: Number(process.env.VOICE_VRAM_RESERVE_MB || 1280) || 1280
    };
  }

  async chooseGpuLayers({ model, device, workerKey = "generation" } = {}) {
    const requested = Number(model?.gpuLayers) || 0;
    if (workerKey !== "generation:voice" || process.env.VOICE_AUTO_GPU_LAYERS !== "1" || !device || requested <= 0) return 0;
    const explicit = Number(process.env.VOICE_GPU_LAYERS || 0) || 0;
    const budget = await this.readDeviceBudget(device);
    const available = Math.max(0, Math.min(budget.totalMiB || budget.freeMiB, budget.freeMiB)
      - budget.ttsP95MiB - budget.asrP95MiB - budget.webviewReserveMiB - budget.safetyReserveMiB);
    // A GGUF layer is not uniform across architectures. Until a probe has
    // measured this model, cap auto-offload to a conservative fraction.
    const conservative = Math.max(1, Math.floor(requested * Math.min(0.5, Math.max(0.1, available / Math.max(1, budget.totalMiB || 12288)))));
    const layers = Math.max(1, Math.min(requested, explicit || conservative));
    const key = `${model.id}@${model.manifestRevision}:${device.name || device.id || "gpu"}`;
    this.cache.set(key, { layers, budget, measuredAt: new Date().toISOString() });
    await this.persist();
    this.logger(`voice-resource-scheduler: ${layers}/${requested} GPU layers selected with ${Math.round(available)} MiB budget`);
    return layers;
  }

  async recordObservation(observation = {}) {
    const key = String(observation.key || `${observation.modelId || "unknown"}:${observation.driver || "unknown"}`);
    this.cache.set(key, { ...observation, recordedAt: new Date().toISOString() });
    await this.persist();
  }

  setRuntimeMode(mode, details = {}) {
    const next = VOICE_RUNTIME_MODES.includes(String(mode)) ? String(mode) : "IDLE_MEMORY_SAVER";
    this.runtimeMode = next;
    this.runtimeModeChangedAt = new Date().toISOString();
    this.cache.set("runtime-mode", { mode: next, ...details, changedAt: this.runtimeModeChangedAt });
    return this.runtimeMode;
  }

  async persist() {
    await fs.mkdir(this.stateDir, { recursive: true }).catch(() => {});
    const payload = Object.fromEntries(this.cache.entries());
    await fs.writeFile(this.statePath, JSON.stringify({ schemaVersion: 1, entries: payload }, null, 2), "utf8").catch(() => {});
  }

  status() {
    return { schemaVersion: 1, statePath: this.statePath, runtimeMode: this.runtimeMode, runtimeModeChangedAt: this.runtimeModeChangedAt, entries: Object.fromEntries(this.cache.entries()) };
  }
}

export function createVoiceResourceScheduler(options = {}) {
  return new VoiceResourceScheduler(options);
}
