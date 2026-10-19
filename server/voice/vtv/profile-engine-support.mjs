import { vtvRvcEngineId, vtvSeedEngineId, vtvYingMusicEngineId } from "../../../shared/voiceClone.mjs";

function referencePath(model = {}) {
  return String(model.referenceAudioPath || model.refAudioPath || model.promptAudioPath || "");
}

function modelVersions(profile = {}) {
  const versions = Array.isArray(profile.modelVersions) ? [...profile.modelVersions] : [];
  const legacyModel = profile.voiceModel && typeof profile.voiceModel === "object" ? profile.voiceModel : null;
  const legacyId = String(legacyModel?.versionId || profile.activeModelVersionId || "legacy-seed-target");
  if (legacyModel && referencePath(legacyModel) && !versions.some((version) => String(version.id) === legacyId)) {
    versions.push({
      id: legacyId,
      createdAt: legacyModel.createdAt || profile.updatedAt || profile.createdAt || "",
      engine: legacyModel.engine || profile.engine || "",
      qualityMode: legacyModel.qualityMode || profile.qualityMode || "",
      voiceModel: legacyModel
    });
  }
  return versions;
}

export function createSeedProfileTargetState(profile = {}) {
  const activeId = String(profile.activeModelVersionId || profile.voiceModel?.versionId || "");
  const targets = modelVersions(profile)
    .filter((version) => referencePath(version.voiceModel || version))
    .map((version) => ({
      engineId: vtvSeedEngineId,
      artifactId: String(version.id || version.voiceModel?.versionId || "legacy-seed-target"),
      profileId: String(profile.id || ""),
      profileVersionId: String(version.id || version.voiceModel?.versionId || ""),
      createdAt: String(version.createdAt || version.voiceModel?.createdAt || ""),
      label: String(version.label || version.name || (version.qualityMode === "fine" ? "Fine-trained version" : "Seed-compatible version")),
      qualityMode: String(version.qualityMode || version.voiceModel?.qualityMode || ""),
      ready: true
    }));
  const selectedTarget = targets.find((target) => target.artifactId === activeId) || targets[0] || null;
  const preparedSourceCount = Math.max(0, Number(profile.preparedSourceCount) || 0);
  return {
    ready: Boolean(selectedTarget),
    selectedTarget,
    targets,
    errors: selectedTarget ? [] : ["Seed-VC needs a profile version with a valid reference voice."],
    warnings: [],
    action: selectedTarget
      ? "This profile already has Seed-VC support. You can rebuild it from prepared sources at any time."
      : preparedSourceCount > 0
        ? "Build a Quick Preview or Fine Training version to add Seed-VC support."
        : "Prepare at least one clean source, then build a profile version.",
    migration: {
      status: selectedTarget ? "ready" : preparedSourceCount > 0 ? "available" : "blocked",
      canBuild: preparedSourceCount > 0,
      preparedSourceCount
    }
  };
}

export function selectEligibleProfileTrainingClips(profile = {}, samples = []) {
  return samples
    .filter((sample) => sample?.profileId === profile?.id)
    .flatMap((sample) => (Array.isArray(sample.segments) ? sample.segments : []).map((segment) => ({ sample, segment })))
    .filter(({ segment }) => (
      segment?.audioPath
      && segment?.qualityVerdict === "eligible"
      && segment?.boundary === "complete"
      && segment?.includeInTraining !== false
      && Number(segment.durationSeconds) >= 2.5
    ));
}

export function eligibleProfileDurationSeconds(profile = {}, samples = []) {
  const segmentDuration = selectEligibleProfileTrainingClips(profile, samples)
    .reduce((total, { segment }) => total + Math.max(0, Number(segment.voicedDurationSeconds) || Number(segment.durationSeconds) || 0), 0);
  return Number(segmentDuration.toFixed(3));
}

export function createProfileEngineSummary(states = {}) {
  const engineIds = [vtvSeedEngineId, vtvRvcEngineId, vtvYingMusicEngineId];
  const readyCount = engineIds.filter((engineId) => states[engineId]?.ready === true).length;
  return {
    engineCount: engineIds.length,
    readyCount,
    needsUpgrade: readyCount < engineIds.length,
    legacyProfile: readyCount <= 1 && states[vtvSeedEngineId]?.ready === true
  };
}
