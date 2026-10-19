import { normalizeEngineResult } from "../../engine-contract.mjs";
import { VtvEngineError } from "../../engine-errors.mjs";
import { SEED_VC_VTV_MANIFEST } from "./manifest.mjs";

export function createSeedVcAdapter({ convert = null, getInstallState = async () => ({ installed: false }), healthCheck = async () => ({ ready: false }) } = {}) {
  return {
    id: "seed-vc-svc-v1",
    displayName: "Seed-VC",
    capabilities: { songVtv: true, speechVtv: false, zeroShot: true, requiresReference: true, requiresTargetModel: false, supportsTraining: false, outputSampleRates: [44100] },
    async getInstallState() { return getInstallState(); },
    async healthCheck() { return healthCheck(); },
    async preflight(context = {}) {
      const health = await healthCheck(context);
      const target = context.target || context.targetArtifact || null;
      const ready = health?.ready !== false && Boolean(target || context.resolvedReferenceAudioPath || context.referencePack);
      return {
        ready,
        errors: ready ? [] : ["Seed-VC requires a valid Song Reference Pack."],
        warnings: [],
        resolvedTarget: target || context.referencePack || null,
        runtimeLineage: context.runtimeManifest || SEED_VC_VTV_MANIFEST
      };
    },
    normalizeSettings(settings = {}) { return { ...settings, preset: settings.preset || "current-default" }; },
    async warmup() {},
    async convertSong(context, signal) {
      if (typeof convert !== "function") throw new VtvEngineError("ENGINE_NOT_INSTALLED", "Seed-VC adapter has no conversion bridge.", { engineId: this.id, action: "Repair the managed Seed-VC runtime." });
      const result = await convert(context, signal);
      return normalizeEngineResult({ ...result, engineId: this.id, executionStatus: "succeeded", lineage: { ...SEED_VC_VTV_MANIFEST, ...(result?.lineage || {}) } }, { engineId: this.id });
    },
    async cancel() {},
    async unload() {}
  };
}
