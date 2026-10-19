import fs from "node:fs/promises";
import path from "node:path";
import { assertEngineAdapter } from "./engine-contract.mjs";
import { VtvEngineError } from "./engine-errors.mjs";

export const VTV_ENGINE_IDS = Object.freeze([
  "seed-vc-svc-v1",
  "rvc-v2-finetuned",
  "yingmusic-svc-zero-shot-v1"
]);

export function createVtvDataRootResolver({ dataRoot } = {}) {
  const root = path.resolve(String(dataRoot || path.join(process.cwd(), "MagicBoxData", "voice_clone")));
  const engineRoot = path.join(root, "engines");
  return Object.freeze({
    dataRoot: root,
    engineRoot,
    engineDir(engineId) { return path.join(engineRoot, String(engineId)); },
    runtimeDir(engineId, version = "active") { return path.join(engineRoot, String(engineId), "versions", String(version)); },
    cacheDir(engineId) { return path.join(engineRoot, String(engineId), "cache"); },
    logDir(engineId) { return path.join(engineRoot, String(engineId), "logs"); },
    tempDir(jobId, engineId) { return path.join(root, "jobs", String(jobId), "engines", String(engineId)); },
    activePath(engineId) { return path.join(engineRoot, String(engineId), "active.json"); },
    profileTargetDir(profileId, engineId) { return path.join(root, "profiles", String(profileId), "vtv-targets", String(engineId)); }
  });
}

export function createVtvEngineRegistry({ resolver = createVtvDataRootResolver(), adapters = [] } = {}) {
  const map = new Map();
  for (const adapter of adapters) register(adapter);
  function register(adapter) {
    const value = assertEngineAdapter(adapter);
    if (map.has(value.id)) throw new TypeError(`VTV engine ${value.id} is already registered.`);
    map.set(value.id, value);
    return value;
  }
  return {
    resolver,
    register,
    has(engineId) { return map.has(String(engineId)); },
    get(engineId) { return map.get(String(engineId)) || null; },
    require(engineId) {
      const adapter = map.get(String(engineId));
      if (!adapter) throw new VtvEngineError("ENGINE_VERSION_INCOMPATIBLE", `VTV engine ${engineId} is not registered.`, { engineId });
      return adapter;
    },
    list() { return [...map.values()]; },
    async loadActiveManifest(engineId) {
      const activePath = resolver.activePath(engineId);
      try {
        const active = JSON.parse((await fs.readFile(activePath, "utf8")).replace(/^\uFEFF/, ""));
        const version = String(active.activeVersion || "");
        if (!version) return null;
        return JSON.parse((await fs.readFile(path.join(resolver.runtimeDir(engineId, version), "runtime-manifest.json"), "utf8")).replace(/^\uFEFF/, ""));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    }
  };
}
