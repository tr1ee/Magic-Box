import fs from "node:fs/promises";
import path from "node:path";

const smokeExtensions = new Set([".wav", ".flac", ".mp3", ".m4a", ".ogg"]);

export async function stageRvcBrowserUploads({ ingressDir, modelFile, indexFile, smokeAudio } = {}) {
  const smokeExtension = path.extname(String(smokeAudio?.originalname || "")).toLowerCase();
  const staged = {
    modelPath: path.join(ingressDir, "uploaded-model.pth"),
    indexPath: path.join(ingressDir, "uploaded-model.index"),
    smokeInputPath: smokeAudio ? path.join(ingressDir, `smoke-input${smokeExtensions.has(smokeExtension) ? smokeExtension : ".wav"}`) : ""
  };
  await Promise.all([
    fs.rename(modelFile.path, staged.modelPath),
    fs.rename(indexFile.path, staged.indexPath),
    ...(smokeAudio ? [fs.rename(smokeAudio.path, staged.smokeInputPath)] : [])
  ]);
  return staged;
}
