import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { VtvEngineError } from "../../engine-errors.mjs";

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

export async function importRvcModelBundle({ modelPath, indexPath, profileId, profileVersionId = "", modelId = `rvc-model-${Date.now()}`, destinationDir, runtimeRevision = "8f2fdbf", inspection = {}, training = {}, recommendedPreset = "identity" } = {}) {
  if (!modelPath) throw new VtvEngineError("RVC_MODEL_INSPECTION_FAILED", "RVC .pth model path is required.");
  if (!indexPath) throw new VtvEngineError("RVC_INDEX_MISSING", "RVC .index path is required.");
  const modelStat = await fs.stat(modelPath).catch(() => null);
  const indexStat = await fs.stat(indexPath).catch(() => null);
  if (!modelStat?.isFile() || path.extname(modelPath).toLowerCase() !== ".pth") throw new VtvEngineError("RVC_MODEL_INSPECTION_FAILED", "The selected RVC model is not a readable .pth file.");
  if (!indexStat?.isFile() || path.extname(indexPath).toLowerCase() !== ".index") throw new VtvEngineError("RVC_INDEX_MISSING", "The selected RVC index is not a readable .index file.");
  const targetDir = path.resolve(destinationDir || path.join(process.cwd(), "MagicBoxData", "voice_clone", "profiles", String(profileId || "unknown"), "vtv-targets", "rvc-v2-finetuned", String(modelId)));
  await fs.mkdir(targetDir, { recursive: true });
  const targetModel = path.join(targetDir, "model.pth");
  const targetIndex = path.join(targetDir, "model.index");
  await fs.copyFile(modelPath, targetModel);
  await fs.copyFile(indexPath, targetIndex);
  const manifest = {
    schemaVersion: 1,
    engineId: "rvc-v2-finetuned",
    modelId: String(modelId),
    profileId: String(profileId || ""),
    profileVersionId: String(profileVersionId || ""),
    architecture: "rvc-v2",
    sampleRate: Number(inspection.sampleRate) || 48000,
    usesF0: inspection.usesF0 !== false,
    speakerId: Number.isInteger(inspection.speakerId) ? inspection.speakerId : 0,
    weights: { path: "model.pth", sha256: await sha256(targetModel) },
    index: { path: "model.index", sha256: await sha256(targetIndex), required: true },
    training: { datasetHash: "", voicedDurationSec: 0, speechDurationSec: 0, singingDurationSec: 0, sourceProfileId: String(profileId || ""), runtimeRevision, ...training },
    inspection: { status: "pending-worker-smoke", metadataSource: "rvc-worker", ...inspection },
    recommendedPreset,
    createdAt: new Date().toISOString()
  };
  await fs.writeFile(path.join(targetDir, "model-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { ...manifest, directory: targetDir, modelPath: targetModel, indexPath: targetIndex };
}

export async function loadRvcModelManifest(manifestPath) {
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (manifest.engineId !== "rvc-v2-finetuned" || !manifest.weights?.sha256 || !manifest.index?.sha256) throw new Error("RVC manifest is incomplete.");
    return manifest;
  } catch (error) {
    throw new VtvEngineError("RVC_MODEL_INSPECTION_FAILED", `RVC model manifest could not be read: ${error.message}`, { cause: error });
  }
}
