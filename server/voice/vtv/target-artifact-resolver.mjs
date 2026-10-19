import fs from "node:fs/promises";
import path from "node:path";
import { selectEligibleProfileTrainingClips } from "./profile-engine-support.mjs";

const MANIFEST_BY_ENGINE = Object.freeze({
  "rvc-v2-finetuned": "model-manifest.json",
  "yingmusic-svc-zero-shot-v1": "artifact-manifest.json"
});

function targetIdFor(engineId, manifest = {}) {
  return String(engineId === "rvc-v2-finetuned" ? manifest.modelId || "" : manifest.artifactId || "");
}

function requestedTargetId(engineId, binding = {}) {
  return String(engineId === "rvc-v2-finetuned"
    ? binding.modelId || binding.artifactId || ""
    : binding.referenceArtifactId || binding.artifactId || "");
}

function safeTargetDirectory(root, artifactId) {
  const normalizedId = String(artifactId || "");
  if (!normalizedId || path.basename(normalizedId) !== normalizedId || normalizedId === "." || normalizedId === "..") return "";
  const directory = path.resolve(root, normalizedId);
  return directory.startsWith(`${path.resolve(root)}${path.sep}`) ? directory : "";
}

async function readTarget({ resolver, profileId, engineId, artifactId }) {
  const manifestName = MANIFEST_BY_ENGINE[engineId];
  if (!manifestName) return null;
  const root = resolver.profileTargetDir(profileId, engineId);
  const directory = safeTargetDirectory(root, artifactId);
  if (!directory) return null;
  const manifestPath = path.join(directory, manifestName);
  let manifest;
  let stat;
  try {
    [manifest, stat] = await Promise.all([
      fs.readFile(manifestPath, "utf8").then(JSON.parse),
      fs.stat(manifestPath)
    ]);
  } catch {
    return null;
  }
  const manifestId = targetIdFor(engineId, manifest);
  if (manifest.engineId !== engineId || manifest.profileId !== profileId || manifestId !== artifactId) return null;
  return {
    ...manifest,
    artifactId: manifestId,
    ...(engineId === "rvc-v2-finetuned" ? { modelId: manifestId } : { referenceArtifactId: manifestId }),
    directory,
    manifestPath,
    modifiedAt: stat.mtime.toISOString()
  };
}

export async function listProfileTargetArtifacts({ resolver, profileId, engineId } = {}) {
  const root = resolver?.profileTargetDir?.(profileId, engineId);
  if (!root || !MANIFEST_BY_ENGINE[engineId]) return [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const targets = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => readTarget({ resolver, profileId: String(profileId), engineId: String(engineId), artifactId: entry.name })));
  return targets
    .filter(Boolean)
    .sort((left, right) => {
      const rightTime = Date.parse(right.createdAt || right.modifiedAt || 0) || 0;
      const leftTime = Date.parse(left.createdAt || left.modifiedAt || 0) || 0;
      return rightTime - leftTime || right.artifactId.localeCompare(left.artifactId);
    });
}

export async function resolveProfileTargetArtifact({ resolver, profileId, engineId, binding = {} } = {}) {
  const requestedId = requestedTargetId(engineId, binding);
  if (requestedId) {
    return readTarget({ resolver, profileId: String(profileId), engineId: String(engineId), artifactId: requestedId });
  }
  return (await listProfileTargetArtifacts({ resolver, profileId: String(profileId), engineId: String(engineId) }))[0] || null;
}

export function publicProfileTargetArtifact(target = {}, engineId = target.engineId) {
  const artifactId = targetIdFor(engineId, target);
  return {
    engineId: String(engineId || ""),
    artifactId,
    ...(engineId === "rvc-v2-finetuned" ? { modelId: artifactId } : { referenceArtifactId: artifactId }),
    profileId: String(target.profileId || ""),
    profileVersionId: String(target.profileVersionId || ""),
    createdAt: String(target.createdAt || target.modifiedAt || ""),
    sampleRate: Number(target.sampleRate) || null,
    durationSec: Number(target.durationSec) || null,
    voicedDurationSec: Number(target.voicedDurationSec) || null,
    architecture: String(target.architecture || ""),
    recommendedPreset: String(target.recommendedPreset || "")
  };
}

export function selectYingMusicProfileReferenceSources(samples = [], profileId, {
  minimumSeconds = 20,
  targetSeconds = 24.6,
  maximumSeconds = 24.8,
  maximumClips = 6,
  voicedSafetyMarginSeconds = 0.5
} = {}) {
  const candidates = selectEligibleProfileTrainingClips({ id: profileId }, samples)
    .map(({ segment }, index) => {
      const durationSeconds = Math.min(10, Math.max(0, Number(segment.durationSeconds) || 0));
      const measuredVoicedSeconds = Number(segment.voicedDurationSeconds);
      const voicedSeconds = Number.isFinite(measuredVoicedSeconds)
        ? Math.max(0, Math.min(durationSeconds, measuredVoicedSeconds))
        : durationSeconds;
      const contributionSeconds = Math.min(durationSeconds, 6);
      const voiceRatio = voicedSeconds / Math.max(0.001, durationSeconds);
      return {
        audioPath: String(segment.audioPath),
        durationSeconds,
        voicedSeconds,
        contributionSeconds,
        estimatedVoicedContributionSeconds: contributionSeconds * voiceRatio,
        preferred: segment.preferredPrompt === true,
        confidence: Math.min(Number(segment.speechConfidence) || 0, Number(segment.transcriptConfidence) || 1),
        voiceRatio,
        index
      };
    })
    .filter((candidate) => candidate.contributionSeconds >= 2 && candidate.estimatedVoicedContributionSeconds > 0)
    .sort((left, right) => right.estimatedVoicedContributionSeconds - left.estimatedVoicedContributionSeconds
      || right.voiceRatio - left.voiceRatio
      || Number(right.preferred) - Number(left.preferred)
      || right.confidence - left.confidence
      || left.index - right.index);

  const selected = [];
  let sourceSeconds = 0;
  let estimatedVoicedSeconds = 0;
  const requiredEstimatedVoicedSeconds = minimumSeconds + voicedSafetyMarginSeconds;
  for (const candidate of candidates) {
    if (selected.length >= maximumClips || (estimatedVoicedSeconds >= requiredEstimatedVoicedSeconds && selected.length >= 3)) break;
    selected.push({
      audioPath: candidate.audioPath,
      contributionSeconds: candidate.contributionSeconds,
      estimatedVoicedSeconds: Number(candidate.estimatedVoicedContributionSeconds.toFixed(3))
    });
    sourceSeconds += candidate.contributionSeconds;
    estimatedVoicedSeconds += candidate.estimatedVoicedContributionSeconds;
  }
  const projectedDurationSeconds = Math.min(maximumSeconds, Math.max(0, estimatedVoicedSeconds + Math.min(2.5, sourceSeconds - estimatedVoicedSeconds)));
  return {
    ready: selected.length >= 3 && estimatedVoicedSeconds >= minimumSeconds && projectedDurationSeconds >= minimumSeconds,
    clips: selected,
    durationSeconds: Number(Math.min(targetSeconds, projectedDurationSeconds).toFixed(3)),
    sourceDurationSeconds: Number(sourceSeconds.toFixed(3)),
    voicedDurationSeconds: Number(estimatedVoicedSeconds.toFixed(3))
  };
}
