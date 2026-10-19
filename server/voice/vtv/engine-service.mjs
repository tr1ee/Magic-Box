import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVtvDataRootResolver, createVtvEngineRegistry } from "./engine-registry.mjs";
import { createEngineWorkerManager } from "./engine-worker-manager.mjs";
import { createSeedVcAdapter } from "./engines/seed-vc/adapter.mjs";
import { createRvcV2Adapter } from "./engines/rvc-v2/adapter.mjs";
import { createYingMusicSvcAdapter } from "./engines/yingmusic-svc/adapter.mjs";

async function activeManifest(resolver, engineId) {
  try {
    const active = JSON.parse((await fs.readFile(resolver.activePath(engineId), "utf8")).replace(/^\uFEFF/, ""));
    const version = String(active.activeVersion || "");
    return version ? JSON.parse((await fs.readFile(path.join(resolver.runtimeDir(engineId, version), "runtime-manifest.json"), "utf8")).replace(/^\uFEFF/, "")) : null;
  } catch { return null; }
}

function workerFor(engineId, manifest, resolver) {
  if (!manifest?.pythonExecutable || !manifest?.workerEntry) return null;
  const bundledWorkerEntry = engineId === "rvc-v2-finetuned"
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "workers", "vtv_rvc_worker.py")
    : manifest.workerEntry;
  const bundledRvcRunnerEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "workers", "vtv_rvc_runner.py");
  return createEngineWorkerManager({
    engineId,
    executable: manifest.pythonExecutable,
    workerEntry: bundledWorkerEntry,
    cwd: path.dirname(bundledWorkerEntry),
    logPath: path.join(resolver.logDir(engineId), "worker.log"),
    env: {
      PYTHONHASHSEED: "0",
      ...(engineId === "rvc-v2-finetuned" ? { MAGICBOX_RVC_RUNTIME_READY: "1" } : {}),
      ...(engineId === "yingmusic-svc-zero-shot-v1" ? { MAGICBOX_YINGMUSIC_RUNTIME_READY: "1" } : {}),
      ...(engineId === "rvc-v2-finetuned" ? {
        MAGICBOX_RVC_SOURCE_ROOT: manifest.sourceRoot || "",
        MAGICBOX_RVC_RUNNER: bundledRvcRunnerEntry
      } : {}),
      ...(engineId === "yingmusic-svc-zero-shot-v1" ? {
        MAGICBOX_YINGMUSIC_SOURCE_ROOT: manifest.sourceRoot || "",
        MAGICBOX_YINGMUSIC_RUNNER: manifest.runnerEntry || path.join(path.dirname(manifest.workerEntry), "magicbox_yingmusic_runner.py"),
        MAGICBOX_YINGMUSIC_CHECKPOINT: manifest.checkpointPath || "",
        MAGICBOX_YINGMUSIC_CONFIG: manifest.configPath || "",
        MAGICBOX_YINGMUSIC_PYTHON_LIBRARY_BIN: manifest.pythonLibraryBin || "",
        MAGICBOX_YINGMUSIC_CACHE_ROOT: resolver.cacheDir(engineId)
      } : {}),
      HF_HOME: resolver.cacheDir(engineId),
      TRANSFORMERS_CACHE: resolver.cacheDir(engineId),
      TORCH_HOME: resolver.cacheDir(engineId),
      NUMBA_CACHE_DIR: process.env.NUMBA_CACHE_DIR || path.join(resolver.cacheDir(engineId), "numba")
    }
  });
}

export async function createVtvEngineService({ dataRoot, seed = {}, seedHealth = async () => ({ ready: false }) } = {}) {
  const resolver = createVtvDataRootResolver({ dataRoot });
  const rvcManifest = await activeManifest(resolver, "rvc-v2-finetuned");
  const yingManifest = await activeManifest(resolver, "yingmusic-svc-zero-shot-v1");
  const rvcWorker = workerFor("rvc-v2-finetuned", rvcManifest, resolver);
  const yingWorker = workerFor("yingmusic-svc-zero-shot-v1", yingManifest, resolver);
  const registry = createVtvEngineRegistry({ resolver, adapters: [
    createSeedVcAdapter({ ...seed, healthCheck: seedHealth }),
    createRvcV2Adapter({ resolver, workerManager: rvcWorker, runtimeManifest: rvcManifest }),
    createYingMusicSvcAdapter({ resolver, workerManager: yingWorker, runtimeManifest: yingManifest })
  ] });
  return {
    resolver,
    registry,
    workers: { rvc: rvcWorker, yingmusic: yingWorker },
    async list() {
      const engines = [];
      for (const adapter of registry.list()) {
        const install = await adapter.getInstallState();
        engines.push({ id: adapter.id, displayName: adapter.displayName, capabilities: adapter.capabilities, ...install });
      }
      return engines;
    },
    async close() { await Promise.all(Object.values({ ...this.workers }).map((worker) => worker?.stop?.().catch(() => {}))); }
  };
}
