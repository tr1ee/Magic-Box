import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { VtvEngineError } from "../../engine-errors.mjs";
import { selectEligibleProfileTrainingClips } from "../../profile-engine-support.mjs";

async function sha256(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

export function assessRvcTrainingReadiness({ voicedDurationSec = 0, singingDurationSec = 0 } = {}) {
  const voiced = Math.max(0, Number(voicedDurationSec) || 0);
  const singing = Math.max(0, Number(singingDurationSec) || 0);
  return {
    voicedDurationSec: voiced,
    singingDurationSec: singing,
    category: voiced < 600 ? "blocked" : voiced < 1200 ? "experimental" : "normal",
    speechOnly: singing <= 0,
    songCapable: singing >= 300,
    ready: voiced >= 600,
    requiredVoicedDurationSec: 600,
    recommendedVoicedDurationSec: 1200,
    missingVoicedDurationSec: Math.max(0, Number((600 - voiced).toFixed(3))),
    errors: voiced < 600 ? ["RVC production training requires at least 10 minutes of valid voiced audio."] : [],
    warnings: voiced >= 600 && voiced < 1200 ? ["10–20 minutes is experimental only."] : []
  };
}

export function selectRvcProfileTrainingSources(samples = [], profileId = "") {
  const profile = { id: String(profileId || "") };
  return selectEligibleProfileTrainingClips(profile, samples)
    .map(({ sample, segment }) => ({
      path: String(segment.audioPath),
      sampleId: String(sample.id || ""),
      segmentId: String(segment.id || ""),
      voicedDurationSec: Math.max(0, Number(segment.voicedDurationSeconds) || Number(segment.durationSeconds) || 0),
      singingDurationSec: segment.sourceKind === "singing" || segment.singing === true
        ? Math.max(0, Number(segment.voicedDurationSeconds) || Number(segment.durationSeconds) || 0)
        : 0,
      transcriptHash: createHash("sha256").update(String(segment.transcript || ""), "utf8").digest("hex")
    }))
    .sort((left, right) => left.sampleId.localeCompare(right.sampleId) || left.segmentId.localeCompare(right.segmentId));
}

export async function createRvcDatasetSnapshot({ profileId, sourceFiles = [], outputDir } = {}) {
  const sourceEntries = sourceFiles.map((item) => typeof item === "string" ? { path: item } : { ...item, path: item.path || item.filePath || item.sourcePath });
  const readiness = assessRvcTrainingReadiness({ voicedDurationSec: sourceEntries.reduce((sum, item) => sum + (Number(item.voicedDurationSec) || 0), 0), singingDurationSec: sourceEntries.reduce((sum, item) => sum + (Number(item.singingDurationSec) || 0), 0) });
  if (!readiness.ready) throw new VtvEngineError("RVC_TRAINING_DATA_INSUFFICIENT", readiness.errors[0], { details: readiness });
  const dir = path.resolve(outputDir || path.join(process.cwd(), "MagicBoxData", "voice_clone", "profiles", String(profileId), "vtv-targets", "rvc-v2-finetuned", "dataset"));
  await fs.mkdir(dir, { recursive: true });
  const snapshotDir = path.join(dir, "immutable-source-snapshot");
  await fs.mkdir(snapshotDir, { recursive: true });
  const files = [];
  for (const [index, entry] of sourceEntries.entries()) {
    const sourcePath = path.resolve(String(entry.path || ""));
    const stat = await fs.stat(sourcePath).catch(() => null);
    if (!stat?.isFile()) throw new VtvEngineError("RVC_TRAINING_DATA_INSUFFICIENT", `RVC source file is missing: ${sourcePath}`);
    const targetName = `${String(index + 1).padStart(4, "0")}-${path.basename(sourcePath)}`;
    const targetPath = path.join(snapshotDir, targetName);
    await fs.copyFile(sourcePath, targetPath);
    files.push({ ...entry, path: targetPath, sourcePath, sha256: await sha256(targetPath), bytes: stat.size });
  }
  const snapshot = {
    schemaVersion: 1,
    engineId: "rvc-v2-finetuned",
    profileId: String(profileId || ""),
    sourceFiles: files,
    readiness,
    processing: {
      sourceSnapshot: "immutable-copy",
      vad: "upstream-prepared-clips",
      denoise: "source-profile-qc",
      dereverb: "source-profile-qc",
      speakerConsistency: "single-profile-only",
      clipSlicing: "RVC-preprocess",
      normalization: "48k-mono",
      f0: "RMVPE",
      contentFeatures: "HuBERT-768"
    },
    createdAt: new Date().toISOString()
  };
  snapshot.datasetHash = createHash("sha256").update(JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    engineId: snapshot.engineId,
    profileId: snapshot.profileId,
    sourceFiles: files.map((file) => ({
      sampleId: file.sampleId || "",
      segmentId: file.segmentId || "",
      sha256: file.sha256,
      bytes: file.bytes,
      voicedDurationSec: Number(file.voicedDurationSec) || 0,
      singingDurationSec: Number(file.singingDurationSec) || 0,
      transcriptHash: file.transcriptHash || ""
    })),
    processing: snapshot.processing
  })).digest("hex");
  await fs.writeFile(path.join(dir, "dataset-manifest.json"), JSON.stringify(snapshot, null, 2), "utf8");
  return { ...snapshot, directory: dir, snapshotDirectory: snapshotDir };
}
