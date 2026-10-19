import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Check,
  CheckSquare,
  Download,
  AudioWaveform,
  FileAudio,
  Files,
  FileText,
  FolderOpen,
  Headphones,
  History,
  Info,
  ListChecks,
  Loader2,
  Mic,
  Music,
  RefreshCcw,
  RotateCcw,
  Scissors,
  ShieldCheck,
  Sparkles,
  Star,
  SlidersHorizontal,
  Trash2,
  Upload,
  Volume,
  X
} from "lucide-react";
import { api, retryableStatusError } from "../lib/api.js";
import { clampPercent, formatBytes, formatDateTime, formatDurationSeconds } from "../lib/format.js";
import { clampPaneSize, readStoredPaneSize, storePaneSize } from "../lib/panes.js";
import { AppButton, classNames } from "../components/AppButton.jsx";
import AccessibleConfirmationDialog from "../components/AccessibleConfirmationDialog.jsx";
import SplitHandle from "../components/SplitHandle.jsx";
import {
  defaultVoiceEngineForLanguage,
  gptSoVitsEngineId,
  normalizeVoiceEngine,
  openVoiceEngineId,
  parseEmotionSegments,
  resolveVoiceLanguage,
  seedVcEngineId,
  voicePreparationEngineId,
  voiceEngineSupportsV2v,
  voiceEngines,
  voiceLanguages,
  voiceStyles,
  vtvRvcEngineId,
  vtvSeedEngineId,
  vtvSongEngineIds,
  vtvYingMusicEngineId
} from "../../shared/voiceClone.mjs";
import VtvEngineSelector from "../components/voice/VtvEngineSelector.jsx";
import VtvEngineStatusCard from "../components/voice/VtvEngineStatusCard.jsx";
import VtvComparisonResults from "../components/voice/VtvComparisonResults.jsx";
import VtvProfileEngineMatrix from "../components/voice/VtvProfileEngineMatrix.jsx";

const VOICE_PREVIEW_WIDTH_STORAGE_KEY = "magicBox.voicePreviewWidth.v1";
const VTV_ENGINE_MODE_STORAGE_KEY = "magicBox.lastSongEngineMode";
const VTV_ENGINE_IDS_STORAGE_KEY = "magicBox.lastSelectedEngineIds";
const VTV_RVC_TARGETS_STORAGE_KEY = "magicBox.lastRvcModelByProfile";
const VTV_YING_TARGETS_STORAGE_KEY = "magicBox.lastYingReferenceArtifactByProfile";
const VTV_PRESETS_STORAGE_KEY = "magicBox.lastPresetByEngine";
const PROFILE_LANGUAGE_OPTION = "profile";
const VOICE_NEURAL_ENGINE_ID = openVoiceEngineId;
const MAX_VOICE_PROFILE_SOURCES = 20;
const MAX_TRAINING_SOURCE_BYTES = 512 * 1024 * 1024;

function readStoredJson(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJson(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function voiceOutputDir(downloadPath, platform) {
  if (!downloadPath) {
    return "";
  }

  const separator = platform === "win32" ? "\\" : "/";
  return `${downloadPath.replace(/[\\/]+$/, "")}${separator}voice-clone-outputs`;
}

function voiceLanguageLabel(value) {
  return voiceLanguages.find((language) => language.id === value)?.label || String(value || "Auto");
}

function voiceEngineLabel(value) {
  const engine = voiceEngines.find((item) => item.id === value);
  if (engine) {
    return engine.label;
  }
  if (value === "magic-local") {
    return "Retired Prototype";
  }
  if (value === "system-tts") {
    return "Retired System TTS";
  }
  if (value === "mock") {
    return "Test Fixture";
  }
  if (value === seedVcEngineId) {
    return "Seed-VC High Quality";
  }
  if (value === voicePreparationEngineId) {
    return "Voice Preparation";
  }
  return value || "Not installed";
}

export function isVoiceJobTerminal(job) {
  return Boolean(job && ["completed", "succeeded", "partial", "partial-cancelled", "needs-review", "rejected", "failed", "cancelled"].includes(job.status));
}

function samePreparationTarget(first, second) {
  return Boolean(
    first?.profileId
    && first.profileId === second?.profileId
    && first.sampleId
    && first.sampleId === second?.sampleId
    && Number(first.preparationRevision) === Number(second.preparationRevision)
  );
}

function persistedPreparationFailureJob(profile, sample) {
  const preparation = sample?.preparation || {};
  const failureMessage = String(preparation.failureMessage || "").trim();
  if (!failureMessage || preparation.failureDismissedAt || !["needs-attention", "failed"].includes(preparation.status)) {
    return null;
  }
  const revision = Math.max(1, Number(preparation.revision) || 1);
  return {
    id: `persisted-preparation-failure:${profile.id}:${sample.id}:${revision}`,
    type: "prepare-profile-source",
    status: "failed",
    progress: 100,
    message: "Voice source preparation needs attention",
    error: failureMessage,
    profileId: profile.id,
    sampleId: sample.id,
    preparationRevision: revision,
    updatedAt: sample.updatedAt || profile.updatedAt || "",
    persistedFailure: true
  };
}

function StatusPill({ children, tone = "ready" }) {
  return (
    <span className={classNames("tool-pill", `tool-pill-${tone}`)}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

function voiceSegmentTranscriptStatus(segment) {
  if (segment?.qualityVerdict === "rejected") {
    return { label: "Rejected", tone: "danger" };
  }
  if (segment?.manualTranscriptReviewedAt && segment?.exclusionReasons?.includes("sentence_too_long")) {
    return { label: "Re-slice required", tone: "busy" };
  }
  if (segment?.qualityVerdict === "needs-review") {
    return { label: "Review needed", tone: "busy" };
  }
  if (segment?.gptSoVitsPromptReady) {
    return { label: "Eligible", tone: "ready" };
  }
  if (!segment?.gptSoVitsTranscriptReady) {
    return { label: "Needs transcript", tone: "busy" };
  }
  if (segment.gptSoVitsPromptStatus === "transcript_saved_too_short") {
    return { label: "Saved - too short", tone: "info" };
  }
  if (segment.gptSoVitsPromptStatus === "transcript_saved_too_long") {
    return { label: "Saved - too long", tone: "info" };
  }
  return { label: "Transcript saved", tone: "info" };
}

function VoiceJobProgress({ job, onCancel, onDismiss }) {
  if (!job) {
    return (
      <section className="voice-side-panel voice-job-panel">
        <div className="voice-panel-title">
          <ActivityIcon />
          <h3>Queue</h3>
        </div>
        <p className="voice-muted">No active Voice Clone job.</p>
      </section>
    );
  }

  const percent = clampPercent(job.progress);
  const trainingProgress = job.diagnostics?.trainingProgress || null;
  return (
    <section className="voice-side-panel voice-job-panel">
      <div className="voice-panel-title">
        <Loader2 className={isVoiceJobTerminal(job) ? "" : "spin"} size={20} />
        <h3>{job.type?.replace(/_/g, " ") || "Voice job"}</h3>
      </div>
      <div className="download-progress-panel">
        <div className="download-progress-header">
          <strong>{job.message || job.status}</strong>
          <span>{percent}%</span>
        </div>
        <div className="download-progress-track" aria-label="Voice Clone job progress">
          <i style={{ width: `${percent}%` }} />
        </div>
        <div className="download-progress-meta">
          <span>{trainingProgress
            ? `Epoch ${trainingProgress.epoch}/${trainingProgress.epochs}${trainingProgress.batches ? ` · batch ${trainingProgress.batch}/${trainingProgress.batches}` : ""}`
            : job.status === "needs-review" ? "Needs review" : job.status === "rejected" ? "Rejected" : job.status}</span>
          <span>{formatDateTime(job.updatedAt)}</span>
        </div>
      </div>
      {trainingProgress?.state === "long-running-batch" ? (
        <p className="voice-muted">This batch is taking longer than usual, but the training process is still reporting. MagicBox will not call it stuck only because one GPU batch is slow.</p>
      ) : null}
      {job.error ? <p className="voice-error">{job.error}</p> : null}
      {!isVoiceJobTerminal(job) ? (
        <AppButton tone="danger" onClick={onCancel}>
          <X size={18} />
          Cancel
        </AppButton>
      ) : onDismiss ? (
        <AppButton tone="secondary" onClick={onDismiss}>
          <X size={18} />
          Dismiss
        </AppButton>
      ) : null}
    </section>
  );
}

function ActivityIcon() {
  return <AudioWaveform size={20} />;
}

function voiceOutputModeLabel(mode) {
  if (mode === "song-v2v") {
    return "Song Replacement";
  }
  if (mode === "v2v") {
    return "Voice to Voice";
  }
  return "Text to Voice";
}

function VoiceOutputCard({ onDelete, onOpenFolder, output }) {
  const songIntegrity = output.mode === "song-v2v" ? output.settings?.songIntegrity : null;
  const repairedPhraseCount = Number(songIntegrity?.repairedPhraseCount || 0);
  const synthesisIntegrity = output.mode === "tts" ? output.settings?.synthesisIntegrity : null;
  const qualityReport = output.settings?.qualityReport;
  const lineage = output.settings?.lineage;
  const vtvQuality = output.settings?.vtvQuality;
  const vtvReferencePack = output.settings?.vtvReferencePack;
  const finalMixGate = output.settings?.finalMixGate;
  const stemGate = output.settings?.stemGate;
  const identityEvaluation = output.settings?.identityEvaluation;
  const modernSongQualityStatus = output.settings?.qualityStatus;

  return (
    <article className="voice-output-card">
      <div className="voice-output-head">
        <span className="voice-output-icon">
          <Headphones size={20} />
        </span>
        <div>
          <strong>{output.outputFileName || "Generated voice"}</strong>
          <span>AI-generated voice</span>
        </div>
      </div>
      <audio controls src={output.audioUrl} preload="metadata" />
      <div className="voice-output-meta">
        <span>{voiceOutputModeLabel(output.mode)}</span>
        <span>{voiceEngineLabel(output.engine)}</span>
        <span>{output.profileName}</span>
        <span>{voiceLanguageLabel(output.language)}</span>
        <span>{formatDurationSeconds(output.durationSeconds)}</span>
        <span>{formatDateTime(output.createdAt)}</span>
      </div>
      {qualityReport ? (
        <div className="voice-output-meta">
          <span>{qualityReport.qualityMode === "strict" ? "Strict" : "Balanced"}</span>
          <span>{qualityReport.decision?.accepted ? "Quality passed" : "Quality warning"}</span>
          <span>{qualityReport.identity?.status || "Identity pending"}</span>
          <span>{qualityReport.perceptual?.status || "Perceptual pending"}</span>
        </div>
      ) : null}
      {output.settings?.vtvPipelineVersion ? (
        <div className="voice-output-meta">
          <span>VTV Pipeline V2</span>
          <span>{modernSongQualityStatus === "passed" ? "Pitch + identity passed" : modernSongQualityStatus === "rejected" ? "Pitch/identity rejected" : "Needs review"}</span>
          <span>{output.settings?.nativeSampleRate === 44100 ? "Native 44.1 kHz" : "Native 32 kHz"}</span>
          {vtvReferencePack?.health?.status ? <span>Reference {vtvReferencePack.health.status}</span> : null}
          {vtvQuality?.score !== undefined ? <span>Quality {Number(vtvQuality.score).toFixed(3)}</span> : null}
        </div>
      ) : null}
      {lineage ? (
        <p className="voice-output-lineage">
          {output.settings?.generationPath || "gpt_direct"} · snapshot {String(lineage.datasetSnapshotHash || "untracked").slice(0, 12)} · {lineage.modelState || "unknown"}
        </p>
      ) : null}
      {output.textPreview ? <p>{output.textPreview}</p> : null}
      {output.sourceAudioName ? <p>Source Audio: {output.sourceAudioName}</p> : null}
      {songIntegrity?.accepted ? (
        <p>
          {songIntegrity.advisoryAccepted
            ? "Best usable song saved · local pitch continuity advisory"
            : "Pitch and target voice verified"}
          {!songIntegrity.advisoryAccepted && repairedPhraseCount > 0
            ? ` · ${repairedPhraseCount} weak ${repairedPhraseCount === 1 ? "phrase" : "phrases"} recovered`
            : ""}
        </p>
      ) : null}
      {output.mode === "song-v2v" && finalMixGate ? (
        <p>{finalMixGate.passed ? "Final mixed WAV gate passed" : `Final mix review: ${(finalMixGate.reasons || []).join(", ") || "unknown issue"}`}</p>
      ) : null}
      {output.mode === "song-v2v" && stemGate ? (
        <p>{stemGate.passed ? "Vocal/accompaniment stem QC passed" : `Stem review: ${(stemGate.reasons || []).join(", ") || "unknown issue"}`}</p>
      ) : null}
      {output.mode === "song-v2v" && identityEvaluation ? (
        <p>
          Target identity {identityEvaluation.accepted ? "passed" : "too weak"}
          {Number.isFinite(Number(identityEvaluation.targetSimilarity)) ? ` · ${Number(identityEvaluation.targetSimilarity).toFixed(3)}` : ""}
          {Number.isFinite(Number(identityEvaluation.targetSimilarityFloor)) ? ` / required ${Number(identityEvaluation.targetSimilarityFloor).toFixed(3)}` : ""}
        </p>
      ) : null}
      {synthesisIntegrity?.final?.advisoryCoverageWarning ? (
        <p>Best audible speech saved · local word-coverage advisory</p>
      ) : null}
      <div className="voice-output-actions">
        <AppButton tone="secondary" onClick={() => onOpenFolder(output.outputPath, { folder: true })}>
          <FolderOpen size={18} />
          Open folder
        </AppButton>
        <AppButton tone="danger" onClick={() => onDelete(output.id)}>
          <Trash2 size={18} />
          Delete
        </AppButton>
      </div>
    </article>
  );
}

function VoiceClonePage({ config, downloadPath, onError, onNotice, onOpenPath }) {
  const [health, setHealth] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [voiceHistory, setVoiceHistory] = useState([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [voiceTab, setVoiceTab] = useState("profiles");
  const [voicePreviewWidth, setVoicePreviewWidth] = useState(() =>
    clampPaneSize(readStoredPaneSize(VOICE_PREVIEW_WIDTH_STORAGE_KEY, 500), 420, 680)
  );
  const [isProfileCreatorOpen, setIsProfileCreatorOpen] = useState(false);
  const [profileForm, setProfileForm] = useState({
    name: "",
    language: "zh",
    description: "",
    consentConfirmed: false
  });
  const [sampleFiles, setSampleFiles] = useState([]);
  const [sampleFileMetadata, setSampleFileMetadata] = useState([]);
  const [activeSampleFileIndex, setActiveSampleFileIndex] = useState(0);
  const [samplePreviewUrl, setSamplePreviewUrl] = useState("");
  const [samplePreviewDuration, setSamplePreviewDuration] = useState(0);
  const [activeJob, setActiveJob] = useState(null);
  const [preparationJobs, setPreparationJobs] = useState([]);
  const [lastOutput, setLastOutput] = useState(null);
  const [deletingModelVersionId, setDeletingModelVersionId] = useState("");
  const [modelVersionDeleteConfirmation, setModelVersionDeleteConfirmation] = useState(null);
  const [isVoiceLoading, setIsVoiceLoading] = useState(false);
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [isUploadingSamples, setIsUploadingSamples] = useState(false);
  const [isIncludingAllTrainingClips, setIsIncludingAllTrainingClips] = useState(false);
  const [ttsText, setTtsText] = useState("");
  const [ttsLanguage, setTtsLanguage] = useState(PROFILE_LANGUAGE_OPTION);
  const [ttsSettings, setTtsSettings] = useState({
    speed: 1,
    pitch: 0,
    styleStrength: 0.7,
    qualityMode: "strict",
    refinementMode: "auto",
    copyStyle: false,
    gptCandidateCount: 3,
    seedCandidateCount: 3,
    outputFormat: "wav"
  });
  const [sourceAudioFile, setSourceAudioFile] = useState(null);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState("");
  const [v2vConversionMode, setV2vConversionMode] = useState("speech");
  const [vtvEngineMode, setVtvEngineMode] = useState(() => readStoredJson(VTV_ENGINE_MODE_STORAGE_KEY, "single") === "compare" ? "compare" : "single");
  const [vtvSelectedEngineIds, setVtvSelectedEngineIds] = useState(() => {
    const stored = readStoredJson(VTV_ENGINE_IDS_STORAGE_KEY, [vtvSeedEngineId]);
    const valid = Array.isArray(stored) ? stored.filter((engineId) => vtvSongEngineIds.includes(engineId)).slice(0, 3) : [];
    return valid.length ? valid : [vtvSeedEngineId];
  });
  const [vtvTargets, setVtvTargets] = useState({});
  const [vtvProfileSummary, setVtvProfileSummary] = useState({});
  const [vtvTargetsLoading, setVtvTargetsLoading] = useState(false);
  const [vtvTargetSelections, setVtvTargetSelections] = useState(() => ({
    [vtvRvcEngineId]: readStoredJson(VTV_RVC_TARGETS_STORAGE_KEY, {}),
    [vtvYingMusicEngineId]: readStoredJson(VTV_YING_TARGETS_STORAGE_KEY, {})
  }));
  const [vtvPresets, setVtvPresets] = useState(() => {
    const stored = readStoredJson(VTV_PRESETS_STORAGE_KEY, {});
    return {
      [vtvSeedEngineId]: "current-default",
      [vtvRvcEngineId]: "identity",
      [vtvYingMusicEngineId]: "balanced",
      ...stored,
      // "balanced" was the old implicit RVC default. Migrate it once to the
      // measured identity preset so existing installations receive the fix.
      [vtvRvcEngineId]: stored?.[vtvRvcEngineId] === "clean" ? "clean" : "identity"
    };
  });
  const [buildingYingReference, setBuildingYingReference] = useState(false);
  const [importingRvcModel, setImportingRvcModel] = useState(false);
  const [lastVtvResults, setLastVtvResults] = useState([]);
  const [v2vLanguage, setV2vLanguage] = useState("auto");
  const [v2vModelVersionId, setV2vModelVersionId] = useState("");
  const [v2vSettings, setV2vSettings] = useState({
    conversionEngine: seedVcEngineId,
    preserveEmotion: true,
    preserveTiming: true,
    pitchMode: "auto",
    pitchShift: 0,
    noiseReduction: true,
    vocalIsolation: false,
    vocalVolume: 1,
    accompanimentVolume: 0.9,
    diffusionSteps: 50,
    inferenceCfgRate: 0.85,
    chunkCrossfadeMs: 750,
    separationOverlap: 0.5,
    outputFormat: "wav"
  });

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) || profiles[0] || null,
    [profiles, selectedProfileId]
  );
  const selectedLineage = selectedProfile?.voiceCloneLineage || {};

  const parsedText = useMemo(() => parseEmotionSegments(ttsText), [ttsText]);
  const profileLanguageLabel = selectedProfile?.language && selectedProfile.language !== "auto"
    ? voiceLanguageLabel(selectedProfile.language)
    : "Auto";
  const ttsRequestedLanguage = ttsLanguage === PROFILE_LANGUAGE_OPTION ? "auto" : ttsLanguage;
  const v2vRequestedLanguage = v2vLanguage === PROFILE_LANGUAGE_OPTION
    ? selectedProfile?.language || "auto"
    : v2vLanguage;
  const ttsEffectiveLanguage = useMemo(() => resolveVoiceLanguage({
    requestedLanguage: ttsRequestedLanguage,
    profileLanguage: selectedProfile?.language,
    text: ttsText
  }), [selectedProfile?.language, ttsRequestedLanguage, ttsText]);
  const v2vEffectiveLanguage = useMemo(() => resolveVoiceLanguage({
    requestedLanguage: v2vRequestedLanguage,
    profileLanguage: selectedProfile?.language
  }), [selectedProfile?.language, v2vRequestedLanguage]);
  const displayedOutputs = useMemo(() => (
    lastOutput && !voiceHistory.some((output) => output.id === lastOutput.id)
      ? [lastOutput, ...voiceHistory]
      : voiceHistory
  ), [lastOutput, voiceHistory]);
  const selectedModelVersions = Array.isArray(selectedProfile?.modelVersions) ? selectedProfile.modelVersions : [];
  const selectedActiveVersion = selectedModelVersions.find((version) => version.id === selectedProfile?.activeModelVersionId || version.active) || selectedModelVersions[0] || null;
  const selectedVoiceModel = selectedProfile?.voiceModel?.engine ? selectedProfile.voiceModel : selectedActiveVersion?.voiceModel || {};
  const selectedActiveModelVersionId = selectedProfile?.activeModelVersionId || selectedVoiceModel.versionId || selectedActiveVersion?.id || "";
  const selectedEngine = normalizeVoiceEngine(selectedVoiceModel.engine || selectedProfile?.engine || defaultVoiceEngineForLanguage(selectedProfile?.language || profileForm.language), {
    language: selectedProfile?.language || profileForm.language
  });
  const selectedEngineState = selectedEngine === gptSoVitsEngineId
    ? health?.engines?.gptSoVitsLocal
    : health?.engines?.openVoiceV2Local;
  const engineReady = Boolean(selectedEngineState?.available || selectedEngineState?.workerReady);
  const openVoiceEngineReady = Boolean(health?.engines?.openVoiceV2Local?.available || health?.engines?.openVoiceV2Local?.workerReady);
  const activeJobRunning = Boolean(
    (activeJob && !isVoiceJobTerminal(activeJob))
    || preparationJobs.some((job) => !isVoiceJobTerminal(job))
  );
  const readyProfile = Boolean(
    selectedVoiceModel.engine
    && (selectedProfile?.status === "ready" || selectedActiveVersion?.voiceModel?.engine)
    && normalizeVoiceEngine(selectedVoiceModel.engine || selectedProfile?.engine, { language: selectedProfile?.language }) === selectedEngine
  );
  const openVoiceV2vModelVersions = selectedModelVersions.filter((version) => (
    version.voiceModel?.modelPath
    && voiceEngineSupportsV2v(version.voiceModel?.engine || version.engine)
  ));
  const referenceV2vModelVersions = selectedModelVersions.filter((version) => Boolean(
    version.voiceModel?.referenceAudioPath
    || version.voiceModel?.refAudioPath
    || version.voiceModel?.promptAudioPath
  ));
  const v2vIsSongReplacement = v2vConversionMode === "song";
  const vtvPrimaryEngineId = vtvSelectedEngineIds[0] || vtvSeedEngineId;
  const songUsesSeedTarget = v2vIsSongReplacement && vtvSelectedEngineIds.includes(vtvSeedEngineId);
  const songUsesRvcTarget = v2vIsSongReplacement && vtvSelectedEngineIds.includes(vtvRvcEngineId);
  const songUsesYingTarget = v2vIsSongReplacement && vtvSelectedEngineIds.includes(vtvYingMusicEngineId);
  const selectedVtvEngineLabel = vtvSelectedEngineIds.map((engineId) => (
    engineId === vtvSeedEngineId ? "Seed-VC" : engineId === vtvRvcEngineId ? "RVC v2" : "YingMusic-SVC"
  )).join(" + ");
  const highQualityV2v = v2vIsSongReplacement ? vtvPrimaryEngineId === vtvSeedEngineId : v2vSettings.conversionEngine === seedVcEngineId;
  const v2vTargetEngine = highQualityV2v ? seedVcEngineId : openVoiceEngineId;
  const v2vBuildEngine = highQualityV2v ? selectedEngine : openVoiceEngineId;
  const v2vModelVersions = highQualityV2v ? referenceV2vModelVersions : openVoiceV2vModelVersions;
  const v2vModelVersionKey = v2vModelVersions.map((version) => version.id).join("|");
  const selectedV2vVersion = v2vModelVersions.find((version) => version.id === v2vModelVersionId)
    || v2vModelVersions.find((version) => version.id === selectedActiveModelVersionId || version.active)
    || v2vModelVersions[0]
    || null;
  const selectedV2vVersionId = selectedV2vVersion?.id || "";
  const selectedRvcTargetId = vtvTargetSelections[vtvRvcEngineId]?.[selectedProfile?.id] || "";
  const selectedYingTargetId = vtvTargetSelections[vtvYingMusicEngineId]?.[selectedProfile?.id] || "";
  const selectedVtvTargetStates = {
    [vtvSeedEngineId]: {
      ...(vtvTargets[vtvSeedEngineId] || {}),
      ready: Boolean(selectedV2vVersion?.voiceModel?.referenceAudioPath || selectedV2vVersion?.voiceModel?.refAudioPath || selectedV2vVersion?.voiceModel?.promptAudioPath)
    },
    [vtvRvcEngineId]: {
      ...(vtvTargets[vtvRvcEngineId] || {}),
      selectedTarget: (vtvTargets[vtvRvcEngineId]?.targets || []).find((target) => target.artifactId === selectedRvcTargetId)
        || vtvTargets[vtvRvcEngineId]?.selectedTarget
        || null
    },
    [vtvYingMusicEngineId]: {
      ...(vtvTargets[vtvYingMusicEngineId] || {}),
      selectedTarget: (vtvTargets[vtvYingMusicEngineId]?.targets || []).find((target) => target.artifactId === selectedYingTargetId)
        || vtvTargets[vtvYingMusicEngineId]?.selectedTarget
        || null
    }
  };
  selectedVtvTargetStates[vtvRvcEngineId].ready = selectedVtvTargetStates[vtvRvcEngineId].selectedTarget?.ready === true;
  selectedVtvTargetStates[vtvYingMusicEngineId].ready = selectedVtvTargetStates[vtvYingMusicEngineId].selectedTarget?.ready === true;
  const selectedVtvTargetsReady = vtvSelectedEngineIds.every((engineId) => selectedVtvTargetStates[engineId]?.ready === true);
  const firstMissingVtvTarget = vtvSelectedEngineIds.find((engineId) => selectedVtvTargetStates[engineId]?.ready !== true) || "";
  const v2vEngineState = v2vIsSongReplacement
    ? health?.vtvEngines?.[vtvPrimaryEngineId]
    : (highQualityV2v ? health?.engines?.seedVcSingingLocal : health?.engines?.openVoiceV2Local);
  const seedVcEngineState = health?.engines?.seedVcSingingLocal;
  const seedCudaUpgradeNeeded = Boolean(
    seedVcEngineState?.available
    && health?.gpuAvailable
    && seedVcEngineState?.device !== "cuda"
  );
  const gptSoVitsEngineState = health?.engines?.gptSoVitsLocal;
  const voicePreparationEngineState = health?.engines?.voicePreparationLocal;
  const voicePreparationReady = Boolean(voicePreparationEngineState?.available || voicePreparationEngineState?.workerReady);
  const voicePreparationCudaUpgradeNeeded = Boolean(
    voicePreparationEngineState?.available
    && health?.gpuAvailable
    && voicePreparationEngineState?.device !== "cuda"
  );
  const gptCudaUpgradeNeeded = Boolean(
    gptSoVitsEngineState?.available
    && health?.gpuAvailable
    && gptSoVitsEngineState?.device !== "cuda"
  );
  const v2vEngineReady = v2vIsSongReplacement
    ? vtvSelectedEngineIds.length > 0 && vtvSelectedEngineIds.every((engineId) => Boolean(health?.vtvEngines?.[engineId]?.available || health?.vtvEngines?.[engineId]?.workerReady))
    : Boolean(v2vEngineState?.available || v2vEngineState?.workerReady);
  const v2vProfileReady = v2vIsSongReplacement
    ? Boolean(selectedProfile && selectedVtvTargetsReady)
    : Boolean(selectedProfile && selectedV2vVersion?.voiceModel?.engine && (!highQualityV2v || selectedV2vVersion.voiceModel.referenceAudioPath || selectedV2vVersion.voiceModel.refAudioPath || selectedV2vVersion.voiceModel.promptAudioPath));
  const songReplacementReady = Boolean(v2vProfileReady && v2vEngineReady && health?.ffmpegAvailable);
  const selectedQualityMode = selectedVoiceModel.qualityMode || selectedProfile?.qualityMode || "";
  const selectedTrainingClipCount = Number(selectedVoiceModel.trainingStats?.datasetSampleCount)
    || (Array.isArray(selectedVoiceModel.datasetSamples) ? selectedVoiceModel.datasetSamples.length : 0);
  const selectedCloneModeLabel = readyProfile
    ? selectedQualityMode === "fine"
      ? selectedVoiceModel.fineTuneTrainingCompleted
        ? "Fine trained"
        : "Fine pending"
      : "Quick"
    : "Not built";
  const selectedSamples = selectedProfile?.samples || [];
  const selectedSampleCount = Number(selectedProfile?.sampleCount || 0);
  const selectedHasSamples = selectedSampleCount > 0;
  const selectedPreparedSourceCount = Number(selectedProfile?.preparedSourceCount || 0);
  const selectedHasPreparedSources = selectedPreparedSourceCount > 0;
  const selectedEligibleTrainingClipCount = Number(selectedProfile?.eligibleTrainingClipCount || 0);
  const selectedIsGptSoVits = selectedEngine === gptSoVitsEngineId;
  const selectedPromptReadyCount = Number(selectedProfile?.gptSoVitsReadySampleCount || 0);
  const selectedTranscriptReadyCount = selectedSamples.reduce((total, sample) => {
    const segmentTranscriptCount = Number(sample.transcriptReadySegmentCount || 0);
    const sampleTranscriptCount = !sample.segmentCount && String(sample.transcript || "").trim() ? 1 : 0;
    return total + segmentTranscriptCount + sampleTranscriptCount;
  }, 0);
  const selectedSegmentCount = selectedSamples.reduce((total, sample) => total + Number(sample.segmentCount || 0), 0);
  const selectedTranscriptReadyClips = selectedSamples.flatMap((sample) => (
    Array.isArray(sample.segments)
      ? sample.segments.filter((segment) => segment.qualityVerdict === "eligible" && String(segment.transcript || "").trim())
      : []
  ));
  const selectedEligibleSpeechSeconds = selectedTranscriptReadyClips
    .filter((clip) => clip.includedInFineTraining !== false)
    .reduce((total, clip) => total + Math.max(0, Number(clip.voicedDurationSeconds) || Number(clip.durationSeconds) || 0), 0);
  const selectedIncludedTrainingClipCount = selectedTranscriptReadyClips.filter((clip) => clip.includedInFineTraining !== false).length;
  const selectedExcludedTrainingClipCount = selectedTranscriptReadyClips.length - selectedIncludedTrainingClipCount;
  const selectedReferencePromptClip = selectedTranscriptReadyClips.find((clip) => clip.preferredPrompt) || null;
  const quickBuildUsesAudioOnlyFallback = selectedIsGptSoVits && selectedPromptReadyCount < 1;
  const quickBuildEngine = quickBuildUsesAudioOnlyFallback ? openVoiceEngineId : selectedEngine;
  const quickBuildEngineReady = quickBuildUsesAudioOnlyFallback ? openVoiceEngineReady : engineReady;
  const selectedQuickBuildReady = Boolean(selectedHasPreparedSources && quickBuildEngineReady && voicePreparationReady);
  const selectedBuildReady = Boolean(
    selectedHasPreparedSources
    && selectedEligibleTrainingClipCount > 0
    && engineReady
    && (!selectedIsGptSoVits || selectedPromptReadyCount > 0)
  );
  const fineEngineReady = Boolean(gptSoVitsEngineState?.available || gptSoVitsEngineState?.workerReady);
  const selectedFineBuildReady = Boolean(
    selectedHasPreparedSources
    && selectedEligibleTrainingClipCount > 0
    && fineEngineReady
    && selectedPromptReadyCount > 0
  );
  const buildReadinessText = !selectedHasSamples
    ? "Add a clean voice sample to start."
    : !voicePreparationReady
      ? "Install Voice Preparation to isolate vocals and review speech locally."
      : !selectedHasPreparedSources
        ? "Waiting for vocal isolation to finish. Transcript review is optional when automatic transcripts already pass quality checks."
        : !selectedEligibleTrainingClipCount
          ? selectedQuickBuildReady
            ? "Quick Preview can build from the prepared vocal without transcripts. Automatic or reviewed transcripts improve quality and enable Fine Training."
            : "No clip is eligible yet. Review the rejection reasons or reprocess the source."
    : !engineReady
      ? "Install the local voice engine before building."
      : selectedIsGptSoVits && !selectedPromptReadyCount
        ? "Save a transcript on one 3-10s sentence clip."
        : selectedQualityMode === "fine" && selectedVoiceModel.fineTuneTrainingCompleted
          ? "Fine Clone is ready for generation."
          : readyProfile
            ? "Profile is ready for generation."
            : "Choose a build path when the sample sounds right.";
  const sampleStepTone = selectedHasPreparedSources ? "ready" : selectedHasSamples ? "warning" : "idle";
  const promptStepTone = selectedFineBuildReady ? "ready" : selectedHasSamples ? "warning" : "idle";
  const cloneStepTone = readyProfile ? "ready" : selectedFineBuildReady || selectedQuickBuildReady ? "warning" : "idle";
  const quickBuildDisabled = !selectedQuickBuildReady || activeJobRunning;
  const fineBuildDisabled = !selectedFineBuildReady || activeJobRunning;
  const v2vBuildReady = highQualityV2v ? selectedBuildReady : Boolean(selectedHasPreparedSources && v2vEngineReady);
  const v2vGuideActionIsInstall = v2vIsSongReplacement ? !v2vEngineReady : highQualityV2v && !v2vEngineReady;
  const v2vBuildDisabled = v2vGuideActionIsInstall
    ? activeJobRunning
    : highQualityV2v ? quickBuildDisabled : (!selectedHasPreparedSources || !v2vEngineReady || activeJobRunning);
  const v2vConvertDisabled = !v2vProfileReady || !v2vEngineReady || !sourceAudioFile || (v2vIsSongReplacement && !health?.ffmpegAvailable) || activeJobRunning;
  const v2vBuildActionLabel = activeJobRunning
    ? "Job running"
    : v2vGuideActionIsInstall
      ? "Install High-Quality VTV"
      : !selectedHasPreparedSources
      ? "Prepare sources"
        : highQualityV2v && !engineReady
          ? `Install ${voiceEngineLabel(selectedEngine)}`
          : !highQualityV2v && !v2vEngineReady
            ? `Install ${voiceEngineLabel(v2vTargetEngine)}`
        : v2vProfileReady
          ? highQualityV2v ? "Rebuild Target Version" : "Rebuild OpenVoice Version"
          : highQualityV2v ? "Build Target Version" : "Build OpenVoice Version";
  const v2vActionLabel = activeJobRunning
    ? "Job running"
    : !v2vEngineReady
      ? v2vIsSongReplacement ? "Install selected VTV runtime" : highQualityV2v ? "Install High-Quality VTV" : `Install ${voiceEngineLabel(v2vTargetEngine)}`
      : !v2vProfileReady
        ? "Build V2V version"
        : !sourceAudioFile
          ? v2vIsSongReplacement ? "Choose song" : "Choose source"
          : v2vIsSongReplacement
            ? "Replace Song Vocal"
            : "Convert Voice";
  const v2vReadinessText = !selectedProfile
    ? "Select a target voice profile."
    : v2vIsSongReplacement
      ? !v2vEngineReady
        ? "Install and verify every selected VTV runtime."
        : !selectedVtvTargetsReady
          ? "Bind a ready target artifact for every selected VTV engine."
          : `${selectedVtvEngineLabel} ready. Engines run sequentially on one GPU with no hidden fallback.`
    : !v2vEngineReady
      ? highQualityV2v
        ? "Install Demucs + Seed-VC for neural vocal isolation and pitch-preserving conversion."
        : "Install OpenVoice V2 for source speech conversion."
      : v2vIsSongReplacement && !health?.ffmpegAvailable
        ? "Install FFmpeg before separating vocals and accompaniment."
      : !v2vProfileReady
        ? highQualityV2v
          ? "Build or select any saved target version with clean reference audio."
          : selectedEngine === gptSoVitsEngineId
          ? "Build or select an OpenVoice V2 version for raw source-audio conversion."
          : "Build an OpenVoice V2 version from this profile."
        : v2vIsSongReplacement
          ? highQualityV2v
            ? "Demucs will isolate vocals, Seed-VC will preserve the performance pitch and timing, then Magic Box will remix the accompaniment."
            : "Legacy mode will convert the center-isolated vocal stem and mix it back."
          : highQualityV2v
            ? "Seed-VC source conversion is ready."
            : "OpenVoice source conversion is ready.";
  const v2vVersionStepTone = v2vProfileReady ? "ready" : v2vBuildReady ? "warning" : "idle";
  const v2vConvertStepTone = v2vProfileReady && sourceAudioFile ? "ready" : v2vProfileReady ? "warning" : "idle";
  const buildBlockedLabel = activeJobRunning
    ? "Job running"
    : !selectedHasSamples
      ? "Add samples first"
      : !voicePreparationReady
        ? "Install preparation"
        : !selectedHasPreparedSources || !selectedEligibleTrainingClipCount
          ? "Prepare eligible clips"
      : !engineReady
        ? "Install engine first"
        : selectedIsGptSoVits && !selectedPromptReadyCount
          ? "Need prompt clip"
          : "Build locked";
  const fineBuildBlockedLabel = activeJobRunning
    ? "Job running"
    : !selectedHasSamples
      ? "Add samples first"
      : !voicePreparationReady
        ? "Install preparation"
        : !selectedHasPreparedSources || !selectedEligibleTrainingClipCount
          ? "Need eligible clips"
          : !fineEngineReady
            ? "Install GPT-SoVITS"
            : !selectedPromptReadyCount
              ? "Need prompt clip"
              : "Fine Training locked";
  const referenceSample = (selectedProfile?.samples || [])[0] || null;
  const referenceSampleUrl = referenceSample
    ? `/api/voice-clone/samples/${encodeURIComponent(referenceSample.id)}/audio`
    : "";
  const voiceOutDir = voiceOutputDir(downloadPath, config?.platform);

  const loadVoiceData = useCallback(async (preferredProfileId = "") => {
    setIsVoiceLoading(true);
    try {
      const [nextHealth, nextProfiles, nextHistory, nextPreparationJobs] = await Promise.all([
        api("/api/voice-clone/health"),
        api("/api/voice-clone/profiles"),
        api("/api/voice-clone/history"),
        api("/api/voice-clone/preparation-jobs")
      ]);
      setHealth(nextHealth);
      setProfiles(Array.isArray(nextProfiles) ? nextProfiles : []);
      setVoiceHistory(Array.isArray(nextHistory) ? nextHistory : []);
      setPreparationJobs((current) => {
        const terminalFailures = current.filter((job) => job.status === "failed");
        const activeJobs = Array.isArray(nextPreparationJobs) ? nextPreparationJobs : [];
        const merged = [...terminalFailures];
        for (const job of activeJobs) {
          if (!merged.some((item) => item.id === job.id)) {
            merged.push(job);
          }
        }
        return merged;
      });
      setSelectedProfileId((current) => (
        preferredProfileId && nextProfiles.some((profile) => profile.id === preferredProfileId)
          ? preferredProfileId
          : nextProfiles.some((profile) => profile.id === current)
          ? current
          : nextProfiles[0]?.id || ""
      ));
    } catch (nextError) {
      onError(nextError.message);
    } finally {
      setIsVoiceLoading(false);
    }
  }, [onError]);

  const loadVtvTargets = useCallback(async (profileId) => {
    if (!profileId) {
      setVtvTargets({});
      setVtvProfileSummary({});
      return;
    }
    setVtvTargetsLoading(true);
    try {
      const payload = await api(`/api/voice-clone/vtv/profiles/${encodeURIComponent(profileId)}/targets`);
      const engines = payload?.engines || {};
      setVtvTargets(engines);
      setVtvProfileSummary(payload?.summary || {});
      setVtvTargetSelections((current) => {
        const next = { ...current };
        for (const engineId of [vtvRvcEngineId, vtvYingMusicEngineId]) {
          const targets = Array.isArray(engines[engineId]?.targets) ? engines[engineId].targets : [];
          const currentId = current[engineId]?.[profileId] || "";
          const selectedId = targets.some((target) => target.artifactId === currentId)
            ? currentId
            : engines[engineId]?.selectedTarget?.artifactId || "";
          next[engineId] = { ...(current[engineId] || {}), [profileId]: selectedId };
        }
        return next;
      });
    } catch (nextError) {
      setVtvTargets({});
      setVtvProfileSummary({});
      onError(nextError.message);
    } finally {
      setVtvTargetsLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    loadVoiceData();
  }, [loadVoiceData]);

  useEffect(() => {
    loadVtvTargets(selectedProfile?.id || "");
  }, [loadVtvTargets, selectedProfile?.id]);

  useEffect(() => { writeStoredJson(VTV_ENGINE_MODE_STORAGE_KEY, vtvEngineMode); }, [vtvEngineMode]);
  useEffect(() => { writeStoredJson(VTV_ENGINE_IDS_STORAGE_KEY, vtvSelectedEngineIds); }, [vtvSelectedEngineIds]);
  useEffect(() => { writeStoredJson(VTV_RVC_TARGETS_STORAGE_KEY, vtvTargetSelections[vtvRvcEngineId] || {}); }, [vtvTargetSelections]);
  useEffect(() => { writeStoredJson(VTV_YING_TARGETS_STORAGE_KEY, vtvTargetSelections[vtvYingMusicEngineId] || {}); }, [vtvTargetSelections]);
  useEffect(() => { writeStoredJson(VTV_PRESETS_STORAGE_KEY, vtvPresets); }, [vtvPresets]);

  useEffect(() => {
    const persistedFailures = profiles.flatMap((profile) => (
      (profile.samples || [])
        .map((sample) => persistedPreparationFailureJob(profile, sample))
        .filter(Boolean)
    ));
    setPreparationJobs((current) => {
      const retained = current.filter((job) => (
        !job.persistedFailure || persistedFailures.some((persisted) => persisted.id === job.id)
      ));
      for (const failure of persistedFailures) {
        if (!retained.some((job) => job.status === "failed" && samePreparationTarget(job, failure))) {
          retained.push(failure);
        }
      }
      return retained;
    });
  }, [profiles]);

  useEffect(() => {
    if (!selectedProfile?.language || selectedProfile.language === "auto") {
      return;
    }
    setTtsLanguage(PROFILE_LANGUAGE_OPTION);
    setV2vLanguage("auto");
    setProfileForm((current) => (
      current.name.trim() || current.description.trim()
        ? current
        : { ...current, language: selectedProfile.language }
    ));
  }, [selectedProfile?.id, selectedProfile?.language]);

  useEffect(() => {
    setSampleFiles([]);
    setSampleFileMetadata([]);
    setActiveSampleFileIndex(0);
  }, [selectedProfile?.id]);

  useEffect(() => {
    if (!selectedProfile?.id || !v2vModelVersions.length) {
      setV2vModelVersionId("");
      return;
    }
    setV2vModelVersionId((current) => (
      v2vModelVersions.some((version) => version.id === current)
        ? current
        : v2vModelVersions[0]?.id || ""
    ));
  }, [selectedProfile?.id, v2vModelVersionKey]);

  useEffect(() => {
    if (!sampleFiles.length) {
      setSamplePreviewUrl("");
      setSamplePreviewDuration(0);
      return undefined;
    }
    const activeFile = sampleFiles[activeSampleFileIndex] || sampleFiles[0];
    const url = URL.createObjectURL(activeFile);
    setSamplePreviewUrl(url);
    setSamplePreviewDuration(0);
    return () => URL.revokeObjectURL(url);
  }, [sampleFiles, activeSampleFileIndex]);

  useEffect(() => {
    if (!sourceAudioFile) {
      setSourcePreviewUrl("");
      return undefined;
    }
    const url = URL.createObjectURL(sourceAudioFile);
    setSourcePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [sourceAudioFile]);

  useEffect(() => {
    if (!activeJob?.id || isVoiceJobTerminal(activeJob)) {
      return undefined;
    }

    let isCancelled = false;
    let timerId = 0;
    async function pollVoiceJob() {
      try {
        const job = await api(`/api/voice-clone/jobs/${encodeURIComponent(activeJob.id)}`);
        if (isCancelled) {
          return;
        }
        setActiveJob(job);
        if (isVoiceJobTerminal(job)) {
          const vtvResults = Array.isArray(job.result?.results) ? job.result.results : [];
          const output = job.result?.output || vtvResults.find((result) => result?.output)?.output || null;
          if (vtvResults.length) setLastVtvResults(vtvResults);
          if (job.type === "rvc_training" && job.result?.artifact?.artifactId && job.profileId) {
            setVtvTargetSelections((current) => ({
              ...current,
              [vtvRvcEngineId]: {
                ...(current[vtvRvcEngineId] || {}),
                [job.profileId]: job.result.artifact.artifactId
              }
            }));
          }
          if (output && ["completed", "succeeded", "partial", "needs-review"].includes(job.status)) setLastOutput(output);
          if (["completed", "succeeded"].includes(job.status)) {
            onNotice(job.type === "prepare-profile-source"
              ? "Voice source preparation completed."
              : job.type === "rvc_training"
                ? "RVC training completed. The generated model and index are verified and bound to this Profile."
                : "Voice Clone job completed.");
            await loadVoiceData();
          } else if (["partial", "partial-cancelled"].includes(job.status)) {
            onNotice("Some VTV engines produced output; failed engines are listed separately.");
            await loadVoiceData();
          } else if (job.status === "needs-review") {
            onNotice(job.type === "prepare-profile-source"
              ? "Voice source preparation completed and needs review."
              : "Song output saved and needs review. It is not a strict-quality pass.");
            await loadVoiceData();
          } else if (job.status === "rejected") {
            onError(job.error || "Voice Clone output was rejected by the quality gate.");
          } else if (job.status === "failed") {
            const engineFailure = vtvResults.find((result) => result?.error)?.error;
            onError(job.error || engineFailure?.message || engineFailure?.code || "Voice Clone job failed.");
          } else {
            onNotice("Voice Clone job cancelled.");
          }
          if (job.profileId && ["prepare-profile-source", "profile_build", "rvc_training"].includes(job.type)) {
            await loadVtvTargets(job.profileId);
          }
          if (job.type === "prepare-profile-source") {
            if (job.status !== "completed") {
              setPreparationJobs((current) => (
                current.some((item) => item.id === job.id) ? current : [...current, job]
              ));
            }
            await loadVoiceData();
            setActiveJob(null);
          }
          return;
        }
        timerId = window.setTimeout(pollVoiceJob, 900);
      } catch (nextError) {
        if (!isCancelled) {
          onError(nextError.message);
          if (retryableStatusError(nextError)) timerId = window.setTimeout(pollVoiceJob, 1500);
        }
      }
    }
    timerId = window.setTimeout(pollVoiceJob, 500);
    return () => {
      isCancelled = true;
      window.clearTimeout(timerId);
    };
  }, [activeJob, loadVoiceData, loadVtvTargets, onError, onNotice]);

  useEffect(() => {
    const runningJobs = preparationJobs.filter((job) => job?.id && !isVoiceJobTerminal(job));
    if (!runningJobs.length) {
      return undefined;
    }

    let isCancelled = false;
    let timerId = 0;
    async function pollPreparationJobs() {
      try {
        const updates = await Promise.all(runningJobs.map(async (job) => (
          api(`/api/voice-clone/jobs/${encodeURIComponent(job.id)}`)
        )));
        if (isCancelled) {
          return;
        }
        const updatesById = new Map(updates.map((job) => [job.id, job]));
        const terminalUpdates = updates.filter((job) => isVoiceJobTerminal(job));
        const stillRunning = updates.some((job) => !isVoiceJobTerminal(job));
        setPreparationJobs((current) => current.map((job) => updatesById.get(job.id) || job));
        if (terminalUpdates.length) {
          const failed = terminalUpdates.find((job) => job.status === "failed");
          if (failed) {
            onError(failed.error || "Voice source preparation failed.");
          }
          await loadVoiceData();
          if (!stillRunning) {
            const completedCount = terminalUpdates.filter((job) => job.status === "completed").length;
            if (completedCount) {
              onNotice(`${completedCount} local voice source${completedCount === 1 ? " is" : "s are"} ready for review.`);
            }
            setPreparationJobs((current) => current.filter((job) => {
              const update = updatesById.get(job.id) || job;
              return update.status === "failed";
            }));
          }
        }
        if (stillRunning) {
          timerId = window.setTimeout(pollPreparationJobs, 900);
        }
      } catch (nextError) {
        if (!isCancelled) {
          onError(nextError.message);
          if (retryableStatusError(nextError)) timerId = window.setTimeout(pollPreparationJobs, 1500);
        }
      }
    }
    timerId = window.setTimeout(pollPreparationJobs, 500);
    return () => {
      isCancelled = true;
      window.clearTimeout(timerId);
    };
  }, [loadVoiceData, onError, onNotice, preparationJobs]);

  async function createProfile(event) {
    event.preventDefault();
    setIsCreatingProfile(true);
    try {
      const profile = await api("/api/voice-clone/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profileForm)
      });
      setProfiles((current) => [profile, ...current.filter((item) => item.id !== profile.id)]);
      setProfileForm({
        name: "",
        language: profile.language || profileForm.language,
        description: "",
        consentConfirmed: false
      });
      setSelectedProfileId(profile.id);
      setIsProfileCreatorOpen(false);
      setTtsLanguage(PROFILE_LANGUAGE_OPTION);
      setV2vLanguage("auto");
      onNotice("Voice profile created.");
      await loadVoiceData(profile.id);
    } catch (nextError) {
      onError(nextError.message);
    } finally {
      setIsCreatingProfile(false);
    }
  }

  async function deleteProfile(profileId) {
    if (!profileId) {
      return;
    }
    if (v2vIsSongReplacement && vtvEngineMode === "compare" && vtvSelectedEngineIds.length < 2) {
      onError("Compare mode requires at least two Song VTV engines.");
      return;
    }
    try {
      await api(`/api/voice-clone/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
      onNotice("Voice profile deleted.");
      await loadVoiceData();
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function uploadSamples() {
    if (!selectedProfile || !sampleFiles.length) {
      return;
    }
    setIsUploadingSamples(true);
    try {
      const formData = new FormData();
      const metadataItems = sampleFiles.map((file, index) => {
        const metadata = sampleFileMetadata[index] || {};
        const trimStart = metadata.trim?.start === "" || metadata.trim?.start == null ? null : Number(metadata.trim.start);
        const trimEnd = metadata.trim?.end === "" || metadata.trim?.end == null ? null : Number(metadata.trim.end);
        if (trimStart !== null && (!Number.isFinite(trimStart) || trimStart < 0)) {
          throw new Error(`${file.name}: trim start must be 0 seconds or later.`);
        }
        if (trimEnd !== null && (!Number.isFinite(trimEnd) || trimEnd <= 0)) {
          throw new Error(`${file.name}: trim end must be greater than 0 seconds.`);
        }
        if (trimStart !== null && trimEnd !== null && trimEnd <= trimStart) {
          throw new Error(`${file.name}: trim end must be after trim start.`);
        }
        return {
          transcript: String(metadata.transcript || "").trim(),
          transcriptLanguage: selectedProfile.language,
          trimStartSeconds: trimStart,
          trimEndSeconds: trimEnd
        };
      });
      formData.append("metadataJson", JSON.stringify(metadataItems));
      sampleFiles.forEach((file) => formData.append("files", file));
      const result = await api(`/api/voice-clone/profiles/${encodeURIComponent(selectedProfile.id)}/samples`, {
        method: "POST",
        body: formData
      });
      setSampleFiles([]);
      setSampleFileMetadata([]);
      setActiveSampleFileIndex(0);
      const startedPreparationJobs = Array.isArray(result?.jobs) && result.jobs.length
        ? result.jobs
        : result?.job ? [result.job] : [];
      if (startedPreparationJobs.length) {
        setPreparationJobs((current) => [
          ...current.filter((job) => job.status === "failed"),
          ...startedPreparationJobs
        ]);
      }
      onNotice(startedPreparationJobs.length
        ? `${sampleFiles.length} voice source${sampleFiles.length === 1 ? "" : "s"} saved. Local BGM separation and sentence review started.`
        : `${sampleFiles.length} voice source${sampleFiles.length === 1 ? "" : "s"} saved, but preparation needs attention before training.`);
      await loadVoiceData();
    } catch (nextError) {
      onError(nextError.message);
    } finally {
      setIsUploadingSamples(false);
    }
  }

  function queueSampleFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) {
      return;
    }
    const oversized = incoming.filter((file) => file.size > MAX_TRAINING_SOURCE_BYTES);
    const accepted = incoming.filter((file) => file.size <= MAX_TRAINING_SOURCE_BYTES);
    if (!accepted.length) {
      onError("Each training source must be 512 MiB or smaller.");
      return;
    }
    const remainingSlots = Math.max(0, MAX_VOICE_PROFILE_SOURCES - selectedSampleCount - sampleFiles.length);
    if (!remainingSlots) {
      onError(`This profile already has the maximum of ${MAX_VOICE_PROFILE_SOURCES} sources.`);
      return;
    }
    const existingKeys = new Set(sampleFiles.map((file) => `${file.name}|${file.size}|${file.lastModified}`));
    const additions = accepted
      .filter((file) => {
        const key = `${file.name}|${file.size}|${file.lastModified}`;
        if (existingKeys.has(key)) {
          return false;
        }
        existingKeys.add(key);
        return true;
      })
      .slice(0, remainingSlots);
    if (!additions.length) {
      onError("Those voice sources are already in the upload queue.");
      return;
    }
    const firstNewIndex = sampleFiles.length;
    setSampleFiles((current) => [...current, ...additions]);
    setSampleFileMetadata((current) => [
      ...current,
      ...additions.map(() => ({ transcript: "", trim: { start: "", end: "" } }))
    ]);
    setActiveSampleFileIndex(firstNewIndex);
    if (oversized.length || additions.length < accepted.length) {
      const reasons = [];
      if (oversized.length) reasons.push(`${oversized.length} file(s) over 512 MiB`);
      if (additions.length < accepted.length) reasons.push(`duplicates or files beyond the ${MAX_VOICE_PROFILE_SOURCES}-source limit`);
      onNotice(`Added ${additions.length} new source(s); skipped ${reasons.join(" and ")}.`);
    }
  }

  function updateQueuedSampleMetadata(index, changes) {
    setSampleFileMetadata((current) => current.map((metadata, metadataIndex) => (
      metadataIndex === index ? { ...metadata, ...changes } : metadata
    )));
  }

  function removeQueuedSample(index) {
    setSampleFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));
    setSampleFileMetadata((current) => current.filter((_, metadataIndex) => metadataIndex !== index));
    setActiveSampleFileIndex((current) => Math.max(0, current > index ? current - 1 : Math.min(current, sampleFiles.length - 2)));
  }

  async function updateSampleTranscript(sample, transcript) {
    if (!selectedProfile || !sample) {
      return;
    }
    try {
      await api(`/api/voice-clone/profiles/${encodeURIComponent(selectedProfile.id)}/samples/${encodeURIComponent(sample.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          transcriptLanguage: selectedProfile.language
        })
      });
      onNotice("Sample transcript saved.");
      await loadVoiceData();
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function reprocessSample(sample, { reusePreparedVocal = false } = {}) {
    if (!selectedProfile || !sample) {
      return;
    }
    try {
      const result = await api(`/api/voice-clone/profiles/${encodeURIComponent(selectedProfile.id)}/samples/${encodeURIComponent(sample.id)}/reprocess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reusePreparedVocal ? { reusePreparedVocal: true } : {})
      });
      if (result?.job) {
        setActiveJob(result.job);
      }
      onNotice(
        reusePreparedVocal
          ? "Re-slicing every prepared clip from the existing separated vocal. BGM separation will not run again."
          : "Voice source reprocessing started. Its original file and active model are preserved."
      );
      await loadVoiceData();
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function updateSampleSegmentSettings(sample, segment, changes, notice) {
    if (!selectedProfile || !sample || !segment) {
      return;
    }
    try {
      const result = await api(`/api/voice-clone/profiles/${encodeURIComponent(selectedProfile.id)}/samples/${encodeURIComponent(sample.id)}/segments/${encodeURIComponent(segment.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes)
      });
      onNotice(typeof notice === "function" ? notice(result) : notice);
      if (result?.profile?.id) {
        setProfiles((current) => current.map((profile) => (
          profile.id === result.profile.id ? result.profile : profile
        )));
        await loadVtvTargets(result.profile.id);
      } else {
        await loadVoiceData();
        await loadVtvTargets(selectedProfile.id);
      }
      return result;
    } catch (nextError) {
      onError(nextError.message);
      return null;
    }
  }

  async function updateSampleSegmentTranscript(sample, segment, transcript) {
    return updateSampleSegmentSettings(sample, segment, {
      transcript,
      transcriptLanguage: selectedProfile?.language
    }, (result) => {
      const reasons = result?.segment?.exclusionReasons || [];
      if (result?.segment?.qualityVerdict === "eligible") {
        return "Sentence transcript saved and included in Fine Training. Use Exclude if you do not want this clip in the dataset.";
      }
      if (reasons.includes("sentence_too_long")) {
        return "Transcript saved. This clip is over 10 seconds, so re-slice all clips to create training-safe review clips.";
      }
      if (reasons.includes("clip_too_short")) {
        return "Transcript saved. This clip is shorter than 2.5 seconds and cannot be used for training.";
      }
      return "Sentence transcript saved. This clip still needs review because of an audio-quality warning.";
    });
  }

  async function includeAllTrainingTranscripts() {
    if (!selectedProfile || !selectedTranscriptReadyClips.length) {
      return;
    }
    setIsIncludingAllTrainingClips(true);
    try {
      const result = await api(`/api/voice-clone/profiles/${encodeURIComponent(selectedProfile.id)}/training-clips`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeAll: true })
      });
      onNotice(result.updatedClipCount
        ? `${result.updatedClipCount} eligible prepared clip(s) added back to Fine Training.`
        : "All eligible prepared clips are already included in Fine Training.");
      await loadVoiceData();
      await loadVtvTargets(selectedProfile.id);
    } catch (nextError) {
      onError(nextError.message);
    } finally {
      setIsIncludingAllTrainingClips(false);
    }
  }

  async function startProfileJob(action, body = {}) {
    if (!selectedProfile) {
      return;
    }
    const requestedBuildEngine = normalizeVoiceEngine(body.engine || selectedEngine, { language: selectedProfile.language });
    const requestedBuildEngineState = requestedBuildEngine === gptSoVitsEngineId
      ? health?.engines?.gptSoVitsLocal
      : health?.engines?.openVoiceV2Local;
    if (action === "build" && !Boolean(requestedBuildEngineState?.available || requestedBuildEngineState?.workerReady)) {
      onError(`Install the ${voiceEngineLabel(requestedBuildEngine)} local model package and worker before building a clone profile.`);
      return;
    }
    if (action === "build" && !voicePreparationReady) {
      onError("Install Voice Preparation before building. It isolates the vocal and quality-gates the sentence clips locally.");
      return;
    }
    try {
      const job = await api(`/api/voice-clone/profiles/${encodeURIComponent(selectedProfile.id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      setActiveJob(job);
      onNotice("Voice Clone job started.");
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function installVoiceModels(engine = selectedEngine) {
    try {
      const job = await api("/api/voice-clone/models/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine })
      });
      setActiveJob(job);
      onNotice(`${voiceEngineLabel(engine)} setup started.`);
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function generateTextVoice(event) {
    event.preventDefault();
    if (!selectedProfile) {
      onError("Create or select a Target Voice Profile first.");
      return;
    }
    if (!engineReady) {
      onError(`Install the ${voiceEngineLabel(selectedEngine)} local model package and worker before generating cloned speech.`);
      return;
    }
    if (!voicePreparationReady) {
      onError("Install Voice Preparation before generating speech. It verifies text coverage and rejects persistent hum or tremble locally.");
      return;
    }
    try {
      const job = await api("/api/voice-clone/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: selectedProfile.id,
          text: ttsText,
          language: ttsRequestedLanguage,
          outputDir: voiceOutDir,
          settings: ttsSettings
        })
      });
      setActiveJob(job);
      onNotice("Text to Voice job started.");
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function loadTextFile(file) {
    if (!file) {
      return;
    }
    try {
      setTtsText(await file.text());
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  function selectVtvTarget(engineId, artifactId) {
    if (!selectedProfile?.id) return;
    setVtvTargetSelections((current) => ({
      ...current,
      [engineId]: { ...(current[engineId] || {}), [selectedProfile.id]: artifactId }
    }));
  }

  async function buildYingReference() {
    if (!selectedProfile?.id || buildingYingReference) return;
    setBuildingYingReference(true);
    try {
      const artifact = await api("/api/voice-clone/yingmusic/reference-artifacts/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: selectedProfile.id,
          profileVersionId: selectedV2vVersionId
        })
      });
      selectVtvTarget(vtvYingMusicEngineId, artifact.artifactId);
      await loadVtvTargets(selectedProfile.id);
      onNotice("YingMusic 20–25 second target reference is ready.");
    } catch (nextError) {
      onError(nextError.message);
    } finally {
      setBuildingYingReference(false);
    }
  }

  async function trainRvcModel() {
    if (!selectedProfile?.id || activeJobRunning) return;
    try {
      const job = await api("/api/voice-clone/rvc/training-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: selectedProfile.id })
      });
      setActiveJob(job);
      onNotice("RVC training started. MagicBox will generate and bind the model and index automatically.");
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function importRvcModel({ modelFile, indexFile }) {
    if (!selectedProfile?.id || importingRvcModel) return;
    setImportingRvcModel(true);
    try {
      const formData = new FormData();
      formData.append("profileId", selectedProfile.id);
      if (selectedV2vVersionId) formData.append("profileVersionId", selectedV2vVersionId);
      formData.append("modelFile", modelFile);
      formData.append("indexFile", indexFile);
      const artifact = await api("/api/voice-clone/rvc/models/import", { method: "POST", body: formData });
      selectVtvTarget(vtvRvcEngineId, artifact.modelId || artifact.artifactId);
      await loadVtvTargets(selectedProfile.id);
      onNotice("RVC files passed the same-speaker runtime check and are now bound. Cross-speaker song identity will be measured after conversion.");
      return true;
    } catch (nextError) {
      onError(nextError.message);
      return false;
    } finally {
      setImportingRvcModel(false);
    }
  }

  async function convertVoice(event) {
    event.preventDefault();
    if (!selectedProfile) {
      onError("Create or select a Target Voice Profile first.");
      return;
    }
    if (!sourceAudioFile) {
      onError(v2vIsSongReplacement ? "Choose a source song first." : "Choose Source Audio first.");
      return;
    }
    const modernSongSelection = v2vIsSongReplacement && vtvSelectedEngineIds.length > 0;
    if (!v2vEngineReady) {
      onError(highQualityV2v
        ? "Install the high-quality Demucs + Seed-VC runtime before converting audio."
        : "Install the OpenVoice V2 local model package and worker before converting speech.");
      return;
    }
    if (v2vIsSongReplacement && (vtvTargetsLoading || !selectedVtvTargetsReady)) {
      const targetState = selectedVtvTargetStates[firstMissingVtvTarget] || {};
      const engineLabel = firstMissingVtvTarget === vtvRvcEngineId ? "RVC v2" : firstMissingVtvTarget === vtvYingMusicEngineId ? "YingMusic-SVC" : "Seed-VC";
      onError(vtvTargetsLoading
        ? "Wait for VTV target validation to finish."
        : `${engineLabel}: ${targetState.errors?.join("; ") || targetState.action || "target artifact is not ready."}`);
      return;
    }
    if (v2vIsSongReplacement && !health?.ffmpegAvailable) {
      onError("Install bundled FFmpeg before replacing song vocals.");
      return;
    }
    if (!selectedV2vVersionId && (!modernSongSelection || vtvSelectedEngineIds.includes(vtvSeedEngineId))) {
      onError(highQualityV2v
        ? "Build or select a target version with clean reference audio before converting source audio."
        : `Build a ${voiceEngineLabel(v2vTargetEngine)} version for this profile before converting source audio.`);
      return;
    }
    try {
      const formData = new FormData();
      formData.append("profileId", selectedProfile.id);
      formData.append("modelVersionId", selectedV2vVersionId);
      formData.append("language", v2vIsSongReplacement ? v2vEffectiveLanguage : v2vRequestedLanguage);
      formData.append("outputDir", voiceOutDir);
      formData.append("settingsJson", JSON.stringify(v2vIsSongReplacement
        ? {
            ...v2vSettings,
            vtvEngineSelection: {
              mode: vtvEngineMode,
              engineIds: vtvSelectedEngineIds,
              primaryEngineId: vtvPrimaryEngineId,
              allowFallback: false
            },
            targetBindings: {
              [vtvRvcEngineId]: selectedRvcTargetId ? { modelId: selectedRvcTargetId } : {},
              [vtvYingMusicEngineId]: selectedYingTargetId ? { referenceArtifactId: selectedYingTargetId } : {},
              [vtvSeedEngineId]: { referencePackId: selectedV2vVersion?.voiceModel?.referencePackId || "" }
            },
            engineSettings: {
              [vtvSeedEngineId]: { preset: vtvPresets[vtvSeedEngineId], seed: 31002 },
              [vtvRvcEngineId]: {
                preset: vtvPresets[vtvRvcEngineId],
                pitchShiftSemitones: v2vSettings.pitchShift,
                seed: 31002
              },
              [vtvYingMusicEngineId]: {
                preset: vtvPresets[vtvYingMusicEngineId],
                pitchMode: v2vSettings.pitchMode,
                forcedPitchShift: v2vSettings.pitchMode === "manual" ? v2vSettings.pitchShift : null,
                seed: 31002
              }
            },
            allowFallback: false
          }
        : v2vSettings));
      formData.append("sourceAudio", sourceAudioFile);
      const job = await api(v2vIsSongReplacement ? "/api/voice-clone/song-v2v" : "/api/voice-clone/v2v", {
        method: "POST",
        body: formData
      });
      if (v2vIsSongReplacement) setLastVtvResults([]);
      setActiveJob(job);
      onNotice(v2vIsSongReplacement ? "Song replacement job started." : "Source audio conversion job started.");
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function cancelVoiceJob(targetJob = activeJob) {
    if (!targetJob?.id) {
      return;
    }
    try {
      const job = await api(`/api/voice-clone/jobs/${encodeURIComponent(targetJob.id)}/cancel`, { method: "POST" });
      if (activeJob?.id === job.id) {
        setActiveJob(job);
      }
      setPreparationJobs((current) => current.map((item) => item.id === job.id ? job : item));
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function dismissPreparationJob(job) {
    if (!job?.id) {
      return;
    }
    try {
      if (job.profileId && job.sampleId) {
        await api(`/api/voice-clone/profiles/${encodeURIComponent(job.profileId)}/samples/${encodeURIComponent(job.sampleId)}/preparation-failure/dismiss`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preparationRevision: job.preparationRevision })
        });
      }
      setPreparationJobs((current) => current.filter((item) => item.id !== job.id));
      await loadVoiceData();
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function deleteOutput(outputId) {
    try {
      await api(`/api/voice-clone/outputs/${encodeURIComponent(outputId)}`, { method: "DELETE" });
      if (lastOutput?.id === outputId) {
        setLastOutput(null);
      }
      onNotice("Voice output deleted.");
      await loadVoiceData();
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function useModelVersion(versionId) {
    if (!selectedProfile || !versionId) {
      return;
    }
    try {
      await api(`/api/voice-clone/profiles/${encodeURIComponent(selectedProfile.id)}/model-version`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId })
      });
      onNotice("Profile version selected.");
      await loadVoiceData();
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function deleteModelVersion(version) {
    if (!selectedProfile || !version?.id || version.id === selectedActiveModelVersionId || version.active) {
      return;
    }
    const label = version.label || (version.qualityMode === "fine" ? "Fine Training model" : "Quick Preview model");
    setModelVersionDeleteConfirmation({
      title: `Delete ${label}?`,
      description: "This removes its unshared local model files and cannot be undone.",
      confirmLabel: "Delete model",
      onConfirm: () => executeDeleteModelVersion(version)
    });
  }

  async function executeDeleteModelVersion(version) {
    setDeletingModelVersionId(version.id);
    try {
      const result = await api(`/api/voice-clone/profiles/${encodeURIComponent(selectedProfile.id)}/model-versions/${encodeURIComponent(version.id)}`, {
        method: "DELETE"
      });
      const sharedCount = Array.isArray(result.preservedSharedPaths) ? result.preservedSharedPaths.length : 0;
      onNotice(sharedCount
        ? "Training model deleted. Files shared by another saved model were preserved."
        : "Training model and its local files deleted.");
      await loadVoiceData();
    } catch (nextError) {
      onError(nextError.message);
    } finally {
      setDeletingModelVersionId("");
    }
  }

  const tabItems = [
    { id: "profiles", label: "TTV Profiles", icon: Mic },
    { id: "models", label: "TTV Models", icon: Box },
    { id: "vtv-models", label: "VTV Models", icon: Music },
    { id: "tts", label: "Text to Voice", icon: FileText },
    { id: "v2v", label: "Voice to Voice", icon: FileAudio },
    { id: "history", label: "History", icon: History }
  ];

  const resizeVoicePreview = useCallback((delta) => {
    setVoicePreviewWidth((current) => {
      const next = clampPaneSize(current - delta, 420, 680);
      storePaneSize(VOICE_PREVIEW_WIDTH_STORAGE_KEY, next);
      return next;
    });
  }, []);

  return (
    <section
      className="voice-clone-page"
      aria-label="Voice Clone"
      style={{ "--voice-preview-width": `${voicePreviewWidth}px` }}
    >
      <section className="voice-profile-toolbar" aria-label="Target voice profile selector">
        <div className="voice-profile-selector-label">
          <Mic size={20} />
          <span>Target profile</span>
        </div>
        <select
          className="field voice-profile-select"
          value={selectedProfile?.id || ""}
          onChange={(event) => setSelectedProfileId(event.target.value)}
          aria-label="Target voice profile"
          disabled={!profiles.length}
        >
          {profiles.length ? profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} - {voiceLanguageLabel(profile.language)} - {profile.status}
            </option>
          )) : <option value="">No profiles yet</option>}
        </select>
        <div className="voice-profile-toolbar-meta">
          <span>{selectedSampleCount} sample{selectedSampleCount === 1 ? "" : "s"}</span>
          <span>{selectedProfile?.qualityScore || 0}/100 quality</span>
          <StatusPill tone={readyProfile ? "ready" : "busy"}>{readyProfile ? "Ready" : "Draft"}</StatusPill>
        </div>
        <AppButton
          type="button"
          tone={isProfileCreatorOpen ? "secondary" : "primary"}
          onClick={() => setIsProfileCreatorOpen((current) => !current)}
        >
          {isProfileCreatorOpen ? <X size={18} /> : <Mic size={18} />}
          {isProfileCreatorOpen ? "Close" : "New Profile"}
        </AppButton>

        {isProfileCreatorOpen ? (
          <form className="voice-create-form voice-create-form-inline" onSubmit={createProfile}>
            <input
              className="field"
              value={profileForm.name}
              onChange={(event) => setProfileForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Profile name"
            />
            <select
              className="field"
              value={profileForm.language}
              onChange={(event) => setProfileForm((current) => ({ ...current, language: event.target.value }))}
            >
              {voiceLanguages.filter((language) => language.id !== "auto").map((language) => (
                <option key={language.id} value={language.id}>{language.label}</option>
              ))}
            </select>
            <input
              className="field"
              value={profileForm.description}
              onChange={(event) => setProfileForm((current) => ({ ...current, description: event.target.value }))}
              placeholder="Optional notes"
            />
            <label className="voice-consent-check voice-consent-check-inline">
              <input
                checked={profileForm.consentConfirmed}
                type="checkbox"
                onChange={(event) => setProfileForm((current) => ({ ...current, consentConfirmed: event.target.checked }))}
              />
              <span>I own this voice or have permission to clone it.</span>
            </label>
            <AppButton tone="primary" type="submit" disabled={isCreatingProfile || !profileForm.name.trim() || !profileForm.consentConfirmed}>
              {isCreatingProfile ? <Loader2 className="spin" size={18} /> : <Mic size={18} />}
              Create
            </AppButton>
          </form>
        ) : null}
      </section>

      <section className="voice-main-workspace">
        <nav className="voice-tabs" aria-label="Voice Clone tabs">
          {tabItems.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                className={classNames(voiceTab === tab.id && "active")}
                key={tab.id}
                type="button"
                onClick={() => setVoiceTab(tab.id)}
              >
                <Icon size={18} />
                {tab.label}
              </button>
            );
          })}
        </nav>

        {voiceTab === "profiles" ? (
          <section className="voice-mode-panel">
            <div className="voice-mode-header">
              <div>
                <h3>{selectedProfile ? `TTV Profile · ${selectedProfile.name}` : "No TTV profile selected"}</h3>
                <p>Upload and prepare the target voice used by Text to Voice, then build a Quick Preview or Fine Training model.</p>
              </div>
              <StatusPill tone={readyProfile ? "ready" : "busy"}>{selectedProfile?.status || "draft"}</StatusPill>
            </div>

            {selectedProfile ? (
              <>
                <div className="voice-profile-stats">
                  <span><strong>{selectedProfile.sampleCount || 0}</strong> Samples</span>
                  <span><strong>{formatDurationSeconds(selectedProfile.totalSpeechSeconds)}</strong> Eligible speech</span>
                  <span><strong>{selectedPreparedSourceCount}/{selectedProfile.sampleCount || 0}</strong> Prepared</span>
                  <span><strong>{selectedEligibleTrainingClipCount}</strong> Eligible clips</span>
                  <span><strong>{selectedProfile.qualityScore || 0}/100</strong> Quality</span>
                  <span><strong>{voiceEngineLabel(selectedProfile.engine)}</strong> Engine</span>
                  <span><strong>{selectedCloneModeLabel}</strong> Clone</span>
                  {selectedQualityMode === "fine" ? (
                    <span><strong>{selectedTrainingClipCount || "-"}</strong> Training clips</span>
                  ) : null}
                </div>

                <section className="voice-preparation-guide" aria-label="Voice source preparation status">
                  <div>
                    <span className="voice-preparation-icon"><AudioWaveform size={20} /></span>
                    <div>
                      <strong>Prepare sources before training</strong>
                      <p>
                        {voicePreparationReady
                          ? "Magic Box keeps each original source, separates its vocal from BGM locally, then drafts sentence clips for review. Only eligible prepared clips are used for Quick Clone or Fine Training."
                          : "Install the local Voice Preparation runtime once to enable BGM separation, timestamped speech review, and generation integrity checks."}
                      </p>
                    </div>
                  </div>
                  <StatusPill tone={voicePreparationCudaUpgradeNeeded ? "warning" : voicePreparationReady ? "ready" : "busy"}>
                    {voicePreparationCudaUpgradeNeeded ? "CPU fallback" : voicePreparationReady ? "Preparation ready" : "Setup required"}
                  </StatusPill>
                  {!voicePreparationReady || voicePreparationCudaUpgradeNeeded ? (
                    <AppButton tone="accent" onClick={() => installVoiceModels(voicePreparationEngineId)} disabled={activeJobRunning}>
                      {activeJobRunning && activeJob?.type === "model_install" ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
                      {voicePreparationCudaUpgradeNeeded ? "Upgrade Voice Preparation to CUDA" : "Install Voice Preparation"}
                    </AppButton>
                  ) : null}
                </section>

                <div className="voice-upload-row">
                  <label className="voice-upload-box">
                    <Upload size={22} />
                    <span>{sampleFiles.length ? `Add more (${sampleFiles.length} queued)` : "Add training sources"}</span>
                    <input
                      className="native-file-input"
                      type="file"
                      multiple
                      accept=".wav,.mp3,.m4a,.flac,.ogg,audio/*"
                      onChange={(event) => {
                        queueSampleFiles(event.target.files);
                        event.target.value = "";
                      }}
                    />
                  </label>
                  <AppButton tone="secondary" onClick={uploadSamples} disabled={isUploadingSamples || !sampleFiles.length}>
                    {isUploadingSamples ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
                    Add Samples
                  </AppButton>
                </div>
                <small className="voice-upload-help">
                  Every source is retained locally, then its vocal is separated from BGM and reviewed sentence by sentence. Raw uploads never enter training; profiles support up to {MAX_VOICE_PROFILE_SOURCES} sources, 512 MiB each.
                </small>

                {sampleFiles.length ? (
                  <div className="voice-trim-panel">
                    <div className="voice-panel-title">
                      <Scissors size={20} />
                      <h3>Multi-source training queue</h3>
                    </div>
                    <p>
                      Configure each source separately. After upload, Magic Box drafts timestamped sentence clips; only approved prepared clips can enter Fine Training.
                    </p>
                    <div className="voice-source-queue" role="list" aria-label="Queued voice training sources">
                      {sampleFiles.map((file, index) => (
                        <div className={classNames("voice-source-queue-row", index === activeSampleFileIndex && "active")} role="listitem" key={`${file.name}-${file.size}-${file.lastModified}`}>
                          <button type="button" onClick={() => setActiveSampleFileIndex(index)}>
                            <FileAudio size={18} />
                            <span>
                              <strong>{file.name}</strong>
                              <small>{sampleFileMetadata[index]?.transcript?.trim() ? "Transcript ready" : "Transcript needed for Fine Training"}</small>
                            </span>
                          </button>
                          <button type="button" className="voice-source-remove" aria-label={`Remove ${file.name}`} onClick={() => removeQueuedSample(index)}>
                            <X size={17} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <strong className="voice-source-editor-title">Source {activeSampleFileIndex + 1}: {sampleFiles[activeSampleFileIndex]?.name}</strong>
                    {samplePreviewUrl ? (
                      <audio
                        controls
                        src={samplePreviewUrl}
                        preload="metadata"
                        onLoadedMetadata={(event) => {
                          const duration = Number(event.currentTarget.duration);
                          setSamplePreviewDuration(Number.isFinite(duration) ? duration : 0);
                        }}
                      />
                    ) : null}
                    <div className="voice-trim-grid">
                      <label>
                        Start seconds
                        <input
                          className="field"
                          min="0"
                          max={samplePreviewDuration ? Number(samplePreviewDuration.toFixed(3)) : undefined}
                          step="0.1"
                          type="number"
                          value={sampleFileMetadata[activeSampleFileIndex]?.trim?.start || ""}
                          onChange={(event) => updateQueuedSampleMetadata(activeSampleFileIndex, {
                            trim: { ...(sampleFileMetadata[activeSampleFileIndex]?.trim || {}), start: event.target.value }
                          })}
                        />
                      </label>
                      <label>
                        End seconds
                        <input
                          className="field"
                          min="0"
                          max={samplePreviewDuration ? Number(samplePreviewDuration.toFixed(3)) : undefined}
                          step="0.1"
                          type="number"
                          value={sampleFileMetadata[activeSampleFileIndex]?.trim?.end || ""}
                          onChange={(event) => updateQueuedSampleMetadata(activeSampleFileIndex, {
                            trim: { ...(sampleFileMetadata[activeSampleFileIndex]?.trim || {}), end: event.target.value }
                          })}
                          placeholder={samplePreviewDuration ? samplePreviewDuration.toFixed(1) : "Full clip"}
                        />
                      </label>
                      <AppButton tone="secondary" onClick={() => updateQueuedSampleMetadata(activeSampleFileIndex, { trim: { start: "", end: "" } })}>
                        <RotateCcw size={18} />
                        Full clip
                      </AppButton>
                    </div>
                    <label className="voice-transcript-field">
                      Optional source note
                      <textarea
                        className="field"
                        value={sampleFileMetadata[activeSampleFileIndex]?.transcript || ""}
                        onChange={(event) => updateQueuedSampleMetadata(activeSampleFileIndex, { transcript: event.target.value })}
                        placeholder="Optional note; sentence transcripts are drafted after local vocal isolation."
                      />
                    </label>
                  </div>
                ) : null}

                <div className="voice-build-guide" aria-label="Voice clone build workflow">
                  <div className="voice-build-header">
                    <div>
                      <strong>Clone build</strong>
                      <span>{buildReadinessText}</span>
                    </div>
                    <AppButton tone="secondary" onClick={loadVoiceData} disabled={isVoiceLoading}>
                      {isVoiceLoading ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
                      Refresh status
                    </AppButton>
                  </div>

                  <div className="voice-build-steps" aria-label="Profile readiness">
                    <span className={classNames("voice-build-step", `voice-build-step-${sampleStepTone}`)}>
                      <strong>1</strong>
                      <small>Prepare sources</small>
                      <b>{selectedHasSamples ? `${selectedPreparedSourceCount}/${selectedSampleCount} ready` : "Waiting"}</b>
                    </span>
                    <span className={classNames("voice-build-step", `voice-build-step-${promptStepTone}`)}>
                      <strong>2</strong>
                      <small>{selectedIsGptSoVits ? "Review + prompt" : "Review clips"}</small>
                      <b>
                        {selectedIsGptSoVits
                          ? selectedReferencePromptClip
                            ? "Selected"
                            : selectedPromptReadyCount
                              ? `${selectedPromptReadyCount} eligible`
                            : selectedTranscriptReadyCount
                              ? `${selectedTranscriptReadyCount}/${selectedSegmentCount || selectedTranscriptReadyCount} transcripts`
                              : "Needs transcript"
                          : selectedEligibleTrainingClipCount ? `${selectedEligibleTrainingClipCount} eligible` : selectedHasSamples ? "Review needed" : "Waiting"}
                      </b>
                    </span>
                    <span className={classNames("voice-build-step", `voice-build-step-${cloneStepTone}`)}>
                      <strong>3</strong>
                      <small>Clone</small>
                      <b>{readyProfile ? selectedCloneModeLabel : selectedFineBuildReady || selectedQuickBuildReady ? "Ready to build" : "Locked"}</b>
                    </span>
                  </div>

                  <div className="voice-build-options">
                    <div className="voice-build-option">
                      <div>
                        <Sparkles size={20} />
                        <span>
                          <strong>Quick Preview</strong>
                          <small>{quickBuildUsesAudioOnlyFallback ? "Works without transcripts using the prepared vocal" : "Fast voice check"}</small>
                        </span>
                      </div>
                      <AppButton tone="accent" onClick={() => startProfileJob("build", { qualityMode: "quick", engine: quickBuildEngine })} disabled={quickBuildDisabled}>
                        {quickBuildDisabled
                          ? !selectedHasPreparedSources
                            ? "Prepare sources"
                            : !quickBuildEngineReady
                              ? `Install ${voiceEngineLabel(quickBuildEngine)}`
                              : "Job running"
                          : quickBuildUsesAudioOnlyFallback ? "Build Audio-only Quick" : "Build Quick"}
                      </AppButton>
                    </div>
                    <div className="voice-build-option">
                      <div>
                        <SlidersHorizontal size={20} />
                        <span>
                          <strong>Fine Training</strong>
                          <small>Best voice match</small>
                        </span>
                      </div>
                      <AppButton tone="secondary" onClick={() => startProfileJob("build", { qualityMode: "fine", engine: gptSoVitsEngineId })} disabled={fineBuildDisabled}>
                        {fineBuildDisabled ? fineBuildBlockedLabel : "Train Fine"}
                      </AppButton>
                    </div>
                  </div>
                </div>

                {selectedTranscriptReadyClips.length ? (
                  <section className="voice-training-dataset-summary" aria-label="Fine Training transcript dataset">
                    <div className="voice-training-dataset-copy">
                      <ListChecks size={22} />
                      <div>
                        <strong>{selectedIncludedTrainingClipCount} of {selectedTranscriptReadyClips.length} eligible prepared clips included</strong>
                        <p>
                          Automatic transcripts can be included immediately; human review improves their accuracy. Every included transcript is used for Fine Training. The single 3-10 second reference prompt only guides inference—it does not replace the training dataset.
                        </p>
                      </div>
                    </div>
                    <div className="voice-training-dataset-actions">
                      <AppButton
                        type="button"
                        tone="secondary"
                        onClick={includeAllTrainingTranscripts}
                        disabled={!selectedExcludedTrainingClipCount || isIncludingAllTrainingClips || activeJobRunning}
                      >
                        {isIncludingAllTrainingClips ? <Loader2 className="spin" size={17} /> : <CheckSquare size={17} />}
                        Include all eligible clips
                      </AppButton>
                      <span>
                        <Star size={16} />
                        Reference prompt: {selectedReferencePromptClip ? "Selected" : "Choose one eligible sentence"}
                      </span>
                    </div>
                    {selectedExcludedTrainingClipCount ? (
                      <small>{selectedExcludedTrainingClipCount} eligible clip(s) are currently excluded. Upstream timing validation may still reject mismatched clips after you include them.</small>
                    ) : (
                      <small>All eligible clips are included. Upstream timing validation still protects the model from badly mismatched audio and text.</small>
                    )}
                  </section>
                ) : null}

                <div className="voice-management-row">
                  <AppButton tone="danger" onClick={() => deleteProfile(selectedProfile.id)}>
                    <Trash2 size={18} />
                    Delete Profile
                  </AppButton>
                </div>

                <div className="voice-sample-list">
                  {(selectedProfile.samples || []).length ? selectedProfile.samples.map((sample) => (
                    <article className={classNames("voice-sample-row", `voice-preparation-${sample.preparation?.status || "needs-attention"}`)} key={sample.id}>
                      <FileAudio size={19} />
                      <div>
                        <strong>{sample.originalFileName}</strong>
                        <span>
                          {sample.format?.toUpperCase()} - {formatDurationSeconds(sample.durationSeconds)} - {sample.sampleRate || "?"} Hz
                          {sample.trimApplied ? ` - range ${sample.trimStartSeconds || 0}s-${sample.trimEndSeconds ? `${sample.trimEndSeconds}s` : "end"}` : ""}
                        </span>
                        <span>
                          {sample.preparation?.status === "ready"
                            ? `${sample.segments?.filter((segment) => segment.qualityVerdict === "eligible").length || 0}/${sample.segmentCount || 0} sentence clips eligible for training`
                            : sample.preparation?.status === "preparing"
                              ? "Separating vocal from BGM and reviewing speech locally"
                              : sample.preparation?.status === "queued"
                                ? "Queued for local vocal separation and sentence review"
                                : "Needs review or reprocessing before it can enter training"}
                        </span>
                        <div className="voice-preparation-status-row">
                          <StatusPill tone={sample.preparation?.status === "ready" ? "ready" : sample.preparation?.status === "needs-attention" || sample.preparation?.status === "failed" ? "danger" : "busy"}>
                            {sample.preparation?.status || "needs-attention"}
                          </StatusPill>
                          {sample.preparation?.vocalAudioUrl ? <audio controls src={sample.preparation.vocalAudioUrl} preload="metadata" /> : null}
                          {sample.preparation?.accompanimentAudioUrl ? <audio controls src={sample.preparation.accompanimentAudioUrl} preload="metadata" /> : null}
                        </div>
                        {sample.segments?.length ? (
                          <div className="voice-segment-list">
                            {sample.segments.map((segment, segmentIndex) => {
                              const segmentStatus = voiceSegmentTranscriptStatus(segment);
                              const preparationLocked = ["queued", "preparing"].includes(sample.preparation?.status);
                              const segmentNeedsReslice = Boolean(segment.exclusionReasons?.includes("sentence_too_long"));
                              const firstLongSegment = segmentNeedsReslice && !sample.segments.slice(0, segmentIndex).some((item) => item.exclusionReasons?.includes("sentence_too_long"));
                              return (
                                <form
                                  className="voice-segment-row"
                                  key={segment.id}
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    const transcript = new FormData(event.currentTarget).get("transcript");
                                    updateSampleSegmentTranscript(sample, segment, transcript);
                                  }}
                                >
                                  <div className="voice-segment-meta">
                                    <span>Sentence {segment.index + 1}</span>
                                    <small>{formatDurationSeconds(segment.durationSeconds)} - {segment.startSeconds}s-{segment.endSeconds}s - speech {Math.round(Number(segment.speechConfidence || 0) * 100)}% - transcript {Math.round(Number(segment.transcriptConfidence || 0) * 100)}%</small>
                                    <StatusPill tone={segmentStatus.tone}>
                                      {segmentStatus.label}
                                    </StatusPill>
                                    {segment.manualTranscriptReviewedAt ? <StatusPill tone={segmentNeedsReslice ? "busy" : "ready"}>{segmentNeedsReslice ? "Transcript reviewed" : "Human reviewed"}</StatusPill> : null}
                                    {segment.preferredPrompt ? <StatusPill tone="ready">Reference prompt</StatusPill> : null}
                                    {!segment.includedInFineTraining ? <StatusPill tone="busy">Excluded from training</StatusPill> : null}
                                    {segment.exclusionReasons?.length ? <small className="voice-clip-reasons">{segment.exclusionReasons.join(", ")}</small> : null}
                                  </div>
                                  {segment.audioUrl ? <audio controls src={segment.audioUrl} preload="metadata" /> : null}
                                  <textarea
                                    className="field"
                                    defaultValue={segment.transcript || ""}
                                    name="transcript"
                                    placeholder="Transcript for this sentence"
                                    disabled={preparationLocked}
                                  />
                                  {!preparationLocked ? <small>{segmentNeedsReslice ? "This clip is longer than 10 seconds. Its transcript is saved, but it must be re-sliced before training or reference use." : "After you listen, saving a non-empty transcript confirms the speech and sentence boundary. Missing audio and unsafe clip lengths stay excluded."}</small> : null}
                                  {preparationLocked ? <small>Existing clips are locked while this source is preparing. Wait for it to finish, then review the new clips.</small> : null}
                                  {firstLongSegment ? (
                                    <div className="voice-segment-recovery">
                                      <small>Re-slice all clips replaces the long automatic segments with reviewable clips of 10 seconds or less, using the already separated vocal track.</small>
                                      <AppButton
                                        tone="accent"
                                        type="button"
                                        onClick={() => reprocessSample(sample, { reusePreparedVocal: true })}
                                        disabled={preparationLocked || activeJobRunning || !voicePreparationReady}
                                      >
                                        <Scissors size={16} />
                                        Re-slice all clips
                                      </AppButton>
                                    </div>
                                  ) : null}
                                  <div className="voice-segment-actions">
                                    <AppButton
                                      tone={segment.preferredPrompt ? "accent" : "secondary"}
                                      type="button"
                                      onClick={() => updateSampleSegmentSettings(sample, segment, { preferredPrompt: true }, "Fine Clone reference prompt selected.")}
                                      disabled={preparationLocked || !segment.gptSoVitsPromptReady || segment.preferredPrompt || segment.qualityVerdict !== "eligible"}
                                    >
                                      <Mic size={16} />
                                      {segment.preferredPrompt ? "Reference selected" : "Use as reference"}
                                    </AppButton>
                                    <AppButton
                                      tone="secondary"
                                      type="button"
                                      onClick={() => updateSampleSegmentSettings(sample, segment, { includeInTraining: !segment.includedInFineTraining }, segment.includedInFineTraining ? "Clip excluded from Fine Training." : "Clip included in Fine Training.")}
                                      disabled={preparationLocked || segment.preferredPrompt || segment.qualityVerdict !== "eligible"}
                                    >
                                      <ListChecks size={16} />
                                      {segment.includedInFineTraining ? "Exclude from training" : "Include in training"}
                                    </AppButton>
                                    <AppButton tone="secondary" type="submit" disabled={preparationLocked}>
                                      <Check size={16} />
                                      Save transcript
                                    </AppButton>
                                  </div>
                                </form>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="voice-sample-preparation-state">
                            <p>Automatic sentence clips will appear here when local vocal isolation and speech review finish. The original source remains safe and is never used as a training fallback.</p>
                            {sample.preparation?.warnings?.length ? <small>{sample.preparation.warnings.join(" ")}</small> : null}
                          </div>
                        )}
                      </div>
                      <span className="metric-pill">{sample.qualityScore || 0}/100</span>
                      <AppButton tone="secondary" type="button" onClick={() => reprocessSample(sample, { reusePreparedVocal: true })} disabled={activeJobRunning || !voicePreparationReady}>
                        <RefreshCcw size={16} />
                        Reprocess source
                      </AppButton>
                      {sample.warnings?.length ? <p>{sample.warnings.slice(0, 2).join(" ")}</p> : null}
                    </article>
                  )) : (
                    <div className="empty-table-state compact-empty">
                      <FileAudio size={34} />
                      <h2>No samples yet</h2>
                      <p>Clean single-speaker audio works best.</p>
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </section>
        ) : null}

        {voiceTab === "models" ? (
          <section className="voice-mode-panel voice-model-manager" aria-label="TTV model manager">
            <div className="voice-mode-header">
              <div>
                <h3>TTV Model Manager</h3>
                <p>Models used by Text to Voice for {selectedProfile?.name || "the selected profile"}. Select, compare, or delete saved local versions.</p>
              </div>
              <StatusPill tone={selectedModelVersions.length ? "ready" : "busy"}>
                {selectedModelVersions.length} saved
              </StatusPill>
            </div>

            <div className="voice-model-manager-note">
              <Info size={18} />
              <span>The active model is protected. Select another model before deleting it; checkpoint files shared by another saved model are kept automatically.</span>
            </div>

            {selectedModelVersions.length ? (
              <div className="voice-model-version-list">
                {selectedModelVersions.map((version, index) => {
                  const isActiveVersion = version.id === selectedActiveModelVersionId || version.active;
                  const versionTrainingStats = version.voiceModel?.trainingStats || {};
                  const versionClipCount = Number(version.trainingClipCount) || Number(versionTrainingStats.datasetSampleCount) || 0;
                  const isDeleting = deletingModelVersionId === version.id;
                  return (
                    <article className={classNames("voice-model-version-row", isActiveVersion && "active")} key={version.id || `${version.qualityMode}-${index}`}>
                      <div>
                        <strong>{version.label || `${version.qualityMode === "fine" ? "Fine Training" : "Quick Preview"} ${index + 1}`}</strong>
                        <span>
                          {version.qualityMode === "fine" ? "Fine Training" : "Quick Preview"} - {voiceEngineLabel(version.engine)} - {formatDateTime(version.builtAt)}
                        </span>
                        <small>Model ID: {version.id}</small>
                        {versionClipCount ? <small>{versionClipCount} training clip(s)</small> : null}
                        {version.promptText ? <small>Reference prompt: {version.promptText}</small> : null}
                        {version.qualityMode === "fine" && versionTrainingStats.device ? (
                          <small>
                            {String(versionTrainingStats.device).toUpperCase()} - GPT batch {versionTrainingStats.gptBatchSize || "?"} / SoVITS batch {versionTrainingStats.sovitsBatchSize || "?"}
                            {versionTrainingStats.rejectedDatasetSampleCount ? ` - ${versionTrainingStats.rejectedDatasetSampleCount} rejected clip(s)` : ""}
                          </small>
                        ) : null}
                        {versionTrainingStats.gptCheckpointSelection?.source === "prior-stable" ? (
                          <small>Semantic checkpoint: previous stable GPT (new SoVITS retained)</small>
                        ) : null}
                        {versionTrainingStats.gptCheckpointSelection?.source === "base-pretrained" ? (
                          <small>Semantic checkpoint: stable GPT-SoVITS base (new SoVITS retained)</small>
                        ) : null}
                      </div>
                      <div className="voice-model-version-actions">
                        {isActiveVersion ? (
                          <StatusPill tone="ready">In use</StatusPill>
                        ) : (
                          <AppButton type="button" tone="secondary" onClick={() => useModelVersion(version.id)} disabled={activeJobRunning || Boolean(deletingModelVersionId)}>
                            <Check size={16} />
                            Use
                          </AppButton>
                        )}
                        <AppButton
                          type="button"
                          tone="danger"
                          onClick={() => deleteModelVersion(version)}
                          disabled={isActiveVersion || activeJobRunning || Boolean(deletingModelVersionId)}
                        >
                          {isDeleting ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                          {isActiveVersion ? "Active" : isDeleting ? "Deleting" : "Delete"}
                        </AppButton>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-table-state compact-empty">
                <Box size={34} />
                <h2>No TTV models</h2>
                <p>Build a Quick Preview or Fine Training model from TTV Profiles first.</p>
              </div>
            )}
          </section>
        ) : null}

        {voiceTab === "vtv-models" ? (
          <section className="voice-mode-panel voice-vtv-models-panel" aria-label="VTV model setup page">
            <VtvProfileEngineMatrix
              profileName={selectedProfile?.name}
              profileStats={{
                sampleCount: selectedProfile?.sampleCount || 0,
                preparedSourceCount: selectedPreparedSourceCount,
                eligibleClipCount: selectedEligibleTrainingClipCount,
                eligibleSpeechSeconds: selectedEligibleSpeechSeconds
              }}
              health={health?.vtvEngines || {}}
              states={selectedVtvTargetStates}
              summary={vtvProfileSummary}
              onBuildSeed={() => startProfileJob("build", { qualityMode: "quick", engine: quickBuildEngine })}
              seedBuildDisabled={quickBuildDisabled}
              onImportRvc={importRvcModel}
              importingRvc={importingRvcModel}
              onTrainRvc={trainRvcModel}
              trainingRvc={activeJobRunning && activeJob?.type === "rvc_training"}
              onBuildYing={buildYingReference}
              buildingYing={buildingYingReference}
              onTargetChange={selectVtvTarget}
              onOpenProfiles={() => setVoiceTab("profiles")}
              onContinue={() => {
                setV2vConversionMode("song");
                setVoiceTab("v2v");
              }}
            />
          </section>
        ) : null}

        {voiceTab === "tts" ? (
          <form className="voice-mode-panel" onSubmit={generateTextVoice}>
            <div className="voice-mode-header">
              <div>
                <h3>Text to Voice</h3>
                <p>Target: {selectedProfile?.name || "None selected"} - Speech: {voiceLanguageLabel(ttsEffectiveLanguage)}</p>
              </div>
              <StatusPill tone={readyProfile && engineReady && selectedLineage.modelState === "active" ? "ready" : "busy"}>
                {!engineReady ? "Model setup" : selectedLineage.modelState === "stale" || selectedLineage.modelState === "untracked" ? "Rebuild required" : readyProfile ? "Ready" : "Build profile"}
              </StatusPill>
            </div>
            {selectedLineage.modelState === "stale" || selectedLineage.modelState === "untracked" ? (
              <div className="voice-warning" role="status">
                Active Fine model is {selectedLineage.modelState}. Strict generation is blocked until the dataset is rebuilt.
              </div>
            ) : null}

            <div className="voice-step-strip" aria-label="Text to Voice generation steps">
              <span><strong>1</strong> Target {profileLanguageLabel}</span>
              <span><strong>2</strong> Script {voiceLanguageLabel(ttsEffectiveLanguage)}</span>
              <span><strong>3</strong> Neural clone</span>
            </div>

            <textarea
              className="field voice-script-field"
              value={ttsText}
              onChange={(event) => setTtsText(event.target.value)}
              placeholder={`(\u5e73\u9759) \u4eca\u5929\u7684\u5929\u6c14\u5f88\u597d\u3002(\u5f00\u5fc3) \u6211\u4eec\u51fa\u53d1\u5427\uff01`}
            />
            <div className="voice-upload-row">
              <label className="voice-upload-box">
                <FileText size={20} />
                <span>Upload .txt script</span>
                <input
                  className="native-file-input"
                  type="file"
                  accept=".txt,text/plain"
                  onChange={(event) => loadTextFile(event.target.files?.[0] || null)}
                />
              </label>
              <select className="field" value={ttsLanguage} onChange={(event) => setTtsLanguage(event.target.value)}>
                <option value={PROFILE_LANGUAGE_OPTION}>Script: {voiceLanguageLabel(ttsEffectiveLanguage)}</option>
                {voiceLanguages.filter((language) => language.id !== "auto").map((language) => (
                  <option key={language.id} value={language.id}>{language.label}</option>
                ))}
              </select>
            </div>

            <div className="voice-segment-preview">
              <strong>Style segments</strong>
              {parsedText.segments.length ? parsedText.segments.slice(0, 6).map((segment, index) => (
                <span key={`${segment.style}-${index}`}>{segment.style}: {segment.text}</span>
              )) : <span>Default style is neutral.</span>}
              {parsedText.warnings.map((warning) => <span className="voice-warning" key={warning}>{warning}</span>)}
              <span>Emotion tags change GPT-SoVITS pacing, safe pitch contour, energy, and sampling. Pipeline V2 evaluates complete Seed-VC conversions without waveform mixing and keeps the direct GPT result when it is already safe.</span>
            </div>

            <div className="voice-settings-grid">
              <label>
                Speed
                <input type="range" min="0.7" max="1.3" step="0.05" value={ttsSettings.speed} onChange={(event) => setTtsSettings((current) => ({ ...current, speed: Number(event.target.value) }))} />
              </label>
              <label>
                Pitch
                <input type="range" min="-1.5" max="1.5" step="0.5" value={Math.max(-1.5, Math.min(1.5, ttsSettings.pitch))} onChange={(event) => setTtsSettings((current) => ({ ...current, pitch: Number(event.target.value) }))} />
              </label>
              <label>
                Style strength
                <input type="range" min="0" max="1" step="0.05" value={ttsSettings.styleStrength} onChange={(event) => setTtsSettings((current) => ({ ...current, styleStrength: Number(event.target.value) }))} />
              </label>
              <label>
                Quality gate
                <select className="field" value={ttsSettings.qualityMode} onChange={(event) => setTtsSettings((current) => ({ ...current, qualityMode: event.target.value }))}>
                  <option value="strict">Strict - fail if a key dependency is missing</option>
                  <option value="balanced">Balanced - keep a validated direct result with warning</option>
                </select>
              </label>
              <label>
                Refinement
                <select className="field" value={ttsSettings.refinementMode} onChange={(event) => setTtsSettings((current) => ({ ...current, refinementMode: event.target.value }))}>
                  <option value="auto">Auto - direct GPT first</option>
                  <option value="gpt_direct_only">Direct GPT only</option>
                  <option value="seed_full_conversion">Seed full conversion</option>
                </select>
              </label>
              <label>
                GPT base candidates
                <select className="field" value={ttsSettings.gptCandidateCount} onChange={(event) => setTtsSettings((current) => ({ ...current, gptCandidateCount: Number(event.target.value) }))}>
                  <option value={2}>2 deterministic candidates</option>
                  <option value={3}>3 deterministic candidates</option>
                </select>
              </label>
              <label className="voice-checkbox-field">
                <input type="checkbox" checked={ttsSettings.copyStyle} onChange={(event) => setTtsSettings((current) => ({ ...current, copyStyle: event.target.checked }))} />
                Copy reference style, emotion, and accent
              </label>
            </div>

            <AppButton tone="accent" type="submit" disabled={!readyProfile || !engineReady || !voicePreparationReady || !ttsText.trim() || activeJobRunning}>
              <Volume size={19} />
              {!voicePreparationReady ? "Install Voice Preparation First" : engineReady ? "Generate Voice" : "Install Neural Engine First"}
            </AppButton>
          </form>
        ) : null}

        {voiceTab === "v2v" ? (
          <form className="voice-mode-panel" onSubmit={convertVoice}>
            <div className="voice-mode-header">
              <div>
                <h3>Voice Conversion</h3>
                <p>
                  Target: {selectedProfile?.name || "None selected"} - Version: {v2vIsSongReplacement ? `${vtvSelectedEngineIds.length} VTV target${vtvSelectedEngineIds.length === 1 ? "" : "s"}` : selectedV2vVersion?.label || "Needs target version"} - Output: {voiceLanguageLabel(v2vEffectiveLanguage)}
                </p>
              </div>
              <StatusPill tone={v2vProfileReady && v2vEngineReady ? "ready" : "busy"}>
                {!v2vEngineReady
                  ? highQualityV2v ? "High-quality setup" : "OpenVoice setup"
                  : v2vProfileReady ? (v2vIsSongReplacement ? "Song ready" : "Speech ready") : "Needs target version"}
              </StatusPill>
            </div>

            {!v2vIsSongReplacement ? <label className="voice-version-select">
              <span>Conversion engine</span>
              <select
                className="field"
                value={v2vSettings.conversionEngine}
                onChange={(event) => setV2vSettings((current) => ({ ...current, conversionEngine: event.target.value }))}
              >
                <option value={seedVcEngineId}>High Quality - Demucs + Seed-VC</option>
                <option value={openVoiceEngineId}>Fast Legacy - OpenVoice V2</option>
              </select>
            </label> : null}

            <div className="voice-mode-switch" aria-label="Voice conversion mode">
              <button
                type="button"
                className={classNames(v2vConversionMode === "speech" && "active")}
                onClick={() => setV2vConversionMode("speech")}
              >
                <AudioWaveform size={18} />
                Speech
              </button>
              <button
                type="button"
                className={classNames(v2vConversionMode === "song" && "active")}
                onClick={() => setV2vConversionMode("song")}
              >
                <Music size={18} />
                Song
              </button>
            </div>

            {v2vIsSongReplacement ? (
              <VtvEngineSelector
                mode={vtvEngineMode}
                selectedEngineIds={vtvSelectedEngineIds}
                health={health?.vtvEngines || {}}
                targets={selectedVtvTargetStates}
                onModeChange={(nextMode) => {
                  setVtvEngineMode(nextMode);
                  if (nextMode === "single") {
                    setVtvSelectedEngineIds((current) => [current[0] || vtvSeedEngineId]);
                  }
                }}
                onToggleEngine={(engineId) => {
                  setVtvSelectedEngineIds((current) => {
                    if (vtvEngineMode === "single") return [engineId];
                    if (current.includes(engineId)) {
                      const next = current.filter((item) => item !== engineId);
                      return next.length ? next : [vtvSeedEngineId];
                    }
                    return [...current, engineId].slice(0, 3);
                  });
                }}
              />
            ) : null}

            {v2vIsSongReplacement ? (
              <div className="voice-vtv-status-grid" aria-label="Song VTV target status">
                {[
                  { id: vtvSeedEngineId, displayName: "Seed-VC", capabilities: { requiresReference: true } },
                  { id: vtvRvcEngineId, displayName: "RVC v2", capabilities: { requiresTargetModel: true } },
                  { id: vtvYingMusicEngineId, displayName: "YingMusic-SVC", capabilities: { requiresReference: true } }
                ].map((engine) => (
                  <VtvEngineStatusCard
                    key={engine.id}
                    engine={engine}
                    state={health?.vtvEngines?.[engine.id] || {}}
                    targetState={selectedVtvTargetStates[engine.id] || {}}
                    selectedTargetId={engine.id === vtvRvcEngineId ? selectedRvcTargetId : engine.id === vtvYingMusicEngineId ? selectedYingTargetId : ""}
                    onTargetChange={engine.id === vtvSeedEngineId ? null : (artifactId) => selectVtvTarget(engine.id, artifactId)}
                    onBuildReference={engine.id === vtvYingMusicEngineId ? buildYingReference : null}
                    buildingReference={buildingYingReference}
                  />
                ))}
              </div>
            ) : null}

            <div className="voice-build-guide voice-v2v-guide" aria-label="Source audio conversion readiness">
              <div className="voice-build-header">
                <div>
                  <strong>{v2vIsSongReplacement ? "Song vocal replacement" : "Source audio conversion"}</strong>
                  <span>{v2vReadinessText}</span>
                </div>
                {!v2vIsSongReplacement || songUsesSeedTarget ? <AppButton
                  tone={v2vGuideActionIsInstall ? "accent" : "secondary"}
                  onClick={() => {
                    if (v2vGuideActionIsInstall) {
                      if (v2vIsSongReplacement && vtvPrimaryEngineId !== vtvSeedEngineId) {
                        onError(`Install and verify the pinned ${vtvPrimaryEngineId} runtime before generating.`);
                        return;
                      }
                      installVoiceModels(seedVcEngineId);
                      return;
                    }
                    startProfileJob("build", { qualityMode: "quick", engine: v2vBuildEngine });
                  }}
                  disabled={v2vBuildDisabled}
                >
                  <AudioWaveform size={18} />
                  {v2vBuildActionLabel}
                </AppButton> : null}
              </div>

              <div className="voice-build-steps" aria-label="Source audio conversion steps">
                <span className={classNames("voice-build-step", selectedProfile ? "voice-build-step-ready" : "voice-build-step-idle")}>
                  <strong>1</strong>
                  <small>Target</small>
                  <b>{profileLanguageLabel}</b>
                </span>
                <span className={classNames("voice-build-step", `voice-build-step-${v2vVersionStepTone}`)}>
                  <strong>2</strong>
                  <small>{v2vIsSongReplacement ? "Engine targets" : "Target version"}</small>
                  <b>{v2vIsSongReplacement ? `${vtvSelectedEngineIds.filter((engineId) => selectedVtvTargetStates[engineId]?.ready).length}/${vtvSelectedEngineIds.length} ready` : selectedV2vVersion ? voiceEngineLabel(selectedV2vVersion.engine) : "Needs build"}</b>
                </span>
                <span className={classNames("voice-build-step", `voice-build-step-${v2vConvertStepTone}`)}>
                  <strong>3</strong>
                  <small>{v2vIsSongReplacement ? "Source song" : "Source audio"}</small>
                  <b>{!sourceAudioFile ? (v2vIsSongReplacement ? "Needs song" : "Needs source") : "Ready"}</b>
                </span>
              </div>

              {v2vModelVersions.length && (!v2vIsSongReplacement || songUsesSeedTarget) ? (
                <label className="voice-version-select">
                  <span>{highQualityV2v ? "Target reference version" : "OpenVoice V2 version"}</span>
                  <select className="field" value={selectedV2vVersionId} onChange={(event) => setV2vModelVersionId(event.target.value)}>
                    {v2vModelVersions.map((version, index) => (
                      <option key={version.id || index} value={version.id}>
                        {version.label || `Voice version ${index + 1}`} - {voiceEngineLabel(version.engine || version.voiceModel?.engine)} - {formatDateTime(version.builtAt)}
                      </option>
                    ))}
                  </select>
                  {highQualityV2v ? (
                          <small>{v2vIsSongReplacement ? "Song VTV uses a native 44.1 kHz target-voice conversion and final-mix quality gate." : "Speech VTV uses complete target-voice conversion candidates; source waveform blending is disabled in Pipeline V2."} GPT-SoVITS Fine Training weights apply to Text to Voice only.</small>
                  ) : null}
                </label>
              ) : null}
            </div>

            <div className="voice-upload-row">
              <label className="voice-upload-box large">
                <FileAudio size={24} />
                <span>{sourceAudioFile?.name || (v2vIsSongReplacement ? "Choose Source Song" : "Choose Source Speech")}</span>
                <input
                  className="native-file-input"
                  type="file"
                  accept=".wav,.mp3,.m4a,.flac,.ogg,audio/*"
                  onChange={(event) => setSourceAudioFile(event.target.files?.[0] || null)}
                />
              </label>
              <select className="field" value={v2vLanguage} onChange={(event) => setV2vLanguage(event.target.value)}>
                <option value="auto">Auto-detect source speech</option>
                <option value={PROFILE_LANGUAGE_OPTION}>Profile language: {profileLanguageLabel}</option>
                {voiceLanguages.filter((language) => language.id !== "auto").map((language) => (
                  <option key={language.id} value={language.id}>{language.label}</option>
                ))}
              </select>
            </div>
            <div className="voice-conversion-status" aria-label="Conversion engine status">
              <span className={classNames(!v2vIsSongReplacement && "active")}>
                <strong>Speech conversion</strong>
                <small>{v2vProfileReady ? (highQualityV2v ? "Coverage-safe Seed-VC blend ready" : "OpenVoice ready") : "Target version needed"}</small>
              </span>
              <span className={classNames(v2vIsSongReplacement && "active")}>
                <strong>Song vocal replacement</strong>
                <small>{songReplacementReady ? `${selectedVtvEngineLabel} ready · sequential GPU` : "Selected runtime or target required"}</small>
              </span>
            </div>
            {sourcePreviewUrl ? (
              <div className="voice-ab-preview">
                <strong>Source Audio</strong>
                <audio controls src={sourcePreviewUrl} preload="metadata" />
              </div>
            ) : null}

            <div className="voice-toggle-grid">
              <label><input type="checkbox" checked={v2vSettings.preserveEmotion} onChange={(event) => setV2vSettings((current) => ({ ...current, preserveEmotion: event.target.checked }))} /> Preserve emotion</label>
              <label><input type="checkbox" checked={v2vSettings.preserveTiming} onChange={(event) => setV2vSettings((current) => ({ ...current, preserveTiming: event.target.checked }))} /> Preserve timing</label>
              <label><input type="checkbox" checked={v2vSettings.noiseReduction} onChange={(event) => setV2vSettings((current) => ({ ...current, noiseReduction: event.target.checked }))} /> Noise reduction</label>
              <label><input type="checkbox" disabled checked={v2vIsSongReplacement || v2vSettings.vocalIsolation} onChange={() => {}} /> Vocal isolation</label>
              <label>
                {songUsesYingTarget && !songUsesRvcTarget ? "Pitch matching" : "Pitch shift"}
                {songUsesYingTarget && !songUsesRvcTarget ? (
                  <select className="field" value={v2vSettings.pitchMode} onChange={(event) => setV2vSettings((current) => ({ ...current, pitchMode: event.target.value }))}>
                    <option value="auto">Auto-match source and target range</option>
                    <option value="manual">Manual semitone shift</option>
                  </select>
                ) : null}
                {(!songUsesYingTarget || songUsesRvcTarget || v2vSettings.pitchMode === "manual") ? (
                  <>
                    <input aria-label="Song pitch shift" type="range" min="-12" max="12" step="1" value={v2vSettings.pitchShift} onChange={(event) => setV2vSettings((current) => ({ ...current, pitchMode: "manual", pitchShift: Number(event.target.value) }))} />
                    <small>{v2vSettings.pitchShift > 0 ? "+" : ""}{v2vSettings.pitchShift} semitones{songUsesRvcTarget ? " · RVC uses this value directly" : ""}</small>
                  </>
                ) : <small>YingMusic will estimate the required shift from both voices.</small>}
              </label>
              {songUsesRvcTarget ? (
                <label>
                  RVC voice strength
                  <select className="field" value={vtvPresets[vtvRvcEngineId]} onChange={(event) => setVtvPresets((current) => ({ ...current, [vtvRvcEngineId]: event.target.value }))}>
                    <option value="clean">Clean · lighter index use</option>
                    <option value="balanced">Balanced</option>
                    <option value="identity">Identity · stronger target tone</option>
                  </select>
                </label>
              ) : null}
              {songUsesYingTarget ? (
                <label>
                  YingMusic quality
                  <select className="field" value={vtvPresets[vtvYingMusicEngineId]} onChange={(event) => setVtvPresets((current) => ({ ...current, [vtvYingMusicEngineId]: event.target.value }))}>
                    <option value="official">Official · 100 diffusion steps</option>
                    <option value="balanced">Balanced · 50 diffusion steps</option>
                    <option value="rawMelody">Raw melody · no automatic F0 shift</option>
                  </select>
                </label>
              ) : null}
              {highQualityV2v ? (
                <label>
                  Quality steps
                  <input type="range" min="12" max="50" step="2" value={v2vSettings.diffusionSteps} onChange={(event) => setV2vSettings((current) => ({ ...current, diffusionSteps: Number(event.target.value) }))} />
                  <small>{v2vSettings.diffusionSteps} {v2vIsSongReplacement ? "(50 recommended for singing)" : ""}</small>
                </label>
              ) : null}
              {highQualityV2v ? (
                <label>
                  Voice guidance
                  <input type="range" min="0.5" max="1" step="0.05" disabled={!v2vIsSongReplacement} value={v2vIsSongReplacement ? v2vSettings.inferenceCfgRate : 0.5} onChange={(event) => setV2vSettings((current) => ({ ...current, inferenceCfgRate: Number(event.target.value) }))} />
                  <small>{v2vIsSongReplacement ? v2vSettings.inferenceCfgRate.toFixed(2) : "0.50 speech-safe"}</small>
                </label>
              ) : null}
              {v2vIsSongReplacement ? (
                <>
                  <label>
                    Join smoothing
                    <input type="range" min="180" max="1200" step="50" value={v2vSettings.chunkCrossfadeMs} onChange={(event) => setV2vSettings((current) => ({ ...current, chunkCrossfadeMs: Number(event.target.value) }))} />
                    <small>{v2vSettings.chunkCrossfadeMs} ms</small>
                  </label>
                  <label>
                    Vocal mix
                    <input type="range" min="0" max="1.8" step="0.05" value={v2vSettings.vocalVolume} onChange={(event) => setV2vSettings((current) => ({ ...current, vocalVolume: Number(event.target.value) }))} />
                  </label>
                  <label>
                    BGM mix
                    <input type="range" min="0" max="1.8" step="0.05" value={v2vSettings.accompanimentVolume} onChange={(event) => setV2vSettings((current) => ({ ...current, accompanimentVolume: Number(event.target.value) }))} />
                  </label>
                </>
              ) : null}
            </div>

            <AppButton tone="accent" type="submit" disabled={v2vConvertDisabled}>
              <AudioWaveform size={19} />
              {v2vActionLabel}
            </AppButton>
          </form>
        ) : null}

        {voiceTab === "history" ? (
          <section className="voice-mode-panel">
            <div className="voice-mode-header">
              <div>
                <h3>Voice History</h3>
                <p>{voiceHistory.length} generated output(s)</p>
              </div>
              <AppButton tone="secondary" onClick={loadVoiceData} disabled={isVoiceLoading}>
                {isVoiceLoading ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
                Refresh
              </AppButton>
            </div>
            <div className="voice-history-list">
              {voiceHistory.length ? voiceHistory.map((output) => (
                <VoiceOutputCard
                  key={output.id}
                  output={output}
                  onDelete={deleteOutput}
                  onOpenFolder={onOpenPath}
                />
              )) : (
                <div className="empty-table-state compact-empty">
                  <History size={34} />
                  <h2>No voice outputs yet</h2>
                  <p>Generated audio will appear here.</p>
                </div>
              )}
            </div>
          </section>
        ) : null}
      </section>

      <SplitHandle
        className="voice-split-handle"
        label="Resize Voice Clone workspace and output sidebar"
        maximum={680}
        minimum={420}
        onReset={() => {
          setVoicePreviewWidth(500);
          storePaneSize(VOICE_PREVIEW_WIDTH_STORAGE_KEY, 500);
        }}
        onResize={resizeVoicePreview}
        testId="voice-split-handle"
        value={voicePreviewWidth}
      />

      <aside className="voice-preview-sidebar">
        <header className="voice-studio-monitor">
          <span className="voice-studio-monitor-icon">
            <Headphones size={22} />
          </span>
          <div>
            <strong>Studio Monitor</strong>
            <p>Job status, local engines, references, and generated audio.</p>
          </div>
          <StatusPill tone={engineReady ? "ready" : "busy"}>{engineReady ? "Online" : "Setup"}</StatusPill>
        </header>

        <VoiceJobProgress job={activeJob} onCancel={cancelVoiceJob} />
        <VtvComparisonResults results={lastVtvResults} />
        {preparationJobs.map((job) => (
          <VoiceJobProgress
            key={job.id}
            job={job}
            onCancel={() => cancelVoiceJob(job)}
            onDismiss={isVoiceJobTerminal(job) ? () => dismissPreparationJob(job) : null}
          />
        ))}

        <section className="voice-side-panel voice-engine-panel">
          <div className="voice-panel-title">
            <ShieldCheck size={20} />
            <h3>Local Engine</h3>
          </div>
          <div className="voice-health-grid">
            <span>Selected <strong>{voiceEngineLabel(selectedEngine)}</strong></span>
            <span>OpenVoice <strong>{health?.engines?.openVoiceV2Local?.available ? "Ready" : "Missing"}</strong></span>
            <span>GPT-SoVITS <strong>{health?.engines?.gptSoVitsLocal?.available ? "Ready" : "Missing"}</strong></span>
            <span>Voice preparation <strong>{voicePreparationReady ? "Ready" : "Missing"}</strong></span>
            <span>Vocal separation <strong>{voicePreparationEngineState?.separationReady ? "Ready" : "Missing"}</strong></span>
            <span>Local ASR <strong>{voicePreparationEngineState?.asrReady ? "Ready" : "Missing"}</strong></span>
            <span>Fine training <strong>{gptSoVitsEngineState?.device === "cuda" ? "GPU" : "CPU"}</strong></span>
            <span>High-quality VTV <strong>{health?.engines?.seedVcSingingLocal?.available ? "Ready" : "Missing"}</strong></span>
            <span>VTV device <strong>{health?.engines?.seedVcSingingLocal?.device === "cuda" ? "GPU" : "CPU"}</strong></span>
            <span>Preparation <strong>{voicePreparationEngineState?.device === "cuda" ? "GPU" : "CPU"}</strong></span>
            <span>Runtime <strong>{engineReady ? "Ready" : "Missing"}</strong></span>
            <span>GPU <strong>{health?.gpuAvailable ? "Available" : "CPU fallback"}</strong></span>
            <span>FFmpeg <strong>{health?.ffmpegAvailable ? (health.ffmpegSource === "bundled" ? "Bundled" : "Found") : "Missing"}</strong></span>
            <span>Profiles <strong>{profiles.length}</strong></span>
            <span>Outputs <strong>{voiceHistory.length}</strong></span>
          </div>
          {!engineReady ? (
            <p className="voice-warning">
              {`Install the ${voiceEngineLabel(selectedEngine)} local model package and worker before building or generating cloned voices.`}
            </p>
          ) : null}
          {!voicePreparationReady ? (
            <p className="voice-warning">
              Install Voice Preparation before training new or reprocessed profile sources. It runs BGM separation, speech review, and generated-audio integrity checks locally.
            </p>
          ) : null}
          {!health?.ffmpegAvailable ? (
            <p className="voice-warning">
              Bundled FFmpeg is required for trim, resample, normalization, and neural preprocessing.
            </p>
          ) : null}
          {seedCudaUpgradeNeeded ? (
            <p className="voice-warning">
              An NVIDIA GPU is available, but high-quality VTV is using CPU PyTorch. Upgrade the managed runtime to CUDA before converting long audio.
            </p>
          ) : null}
          {gptCudaUpgradeNeeded ? (
            <p className="voice-warning">
              GPT-SoVITS Fine Training is using CPU PyTorch. Upgrade it to CUDA for mixed-precision training and VRAM-sized batches.
            </p>
          ) : null}
          {voicePreparationCudaUpgradeNeeded ? (
            <p className="voice-warning">
              An NVIDIA GPU is available, but Voice Preparation is using CPU PyTorch. Upgrade it to CUDA before preparing longer sources with BGM.
            </p>
          ) : null}
          <details className="voice-model-manager">
            <summary>Manage local models</summary>
            <div className="voice-health-actions">
              <AppButton tone={(highQualityV2v && !v2vEngineReady) || seedCudaUpgradeNeeded ? "accent" : "secondary"} onClick={() => installVoiceModels(seedVcEngineId)} disabled={(Boolean(seedVcEngineState?.available) && !seedCudaUpgradeNeeded) || activeJobRunning}>
                {activeJobRunning && activeJob?.type === "model_install" ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
                {seedCudaUpgradeNeeded ? "Upgrade VTV to CUDA" : "Install High-Quality VTV"}
              </AppButton>
              <AppButton tone={!voicePreparationReady || voicePreparationCudaUpgradeNeeded ? "accent" : "secondary"} onClick={() => installVoiceModels(voicePreparationEngineId)} disabled={(Boolean(voicePreparationEngineState?.available) && !voicePreparationCudaUpgradeNeeded) || activeJobRunning}>
                {activeJobRunning && activeJob?.type === "model_install" ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
                {voicePreparationCudaUpgradeNeeded ? "Upgrade Voice Preparation to CUDA" : "Install Voice Preparation"}
              </AppButton>
              <AppButton tone={(selectedEngine === gptSoVitsEngineId && !engineReady) || gptCudaUpgradeNeeded ? "accent" : "secondary"} onClick={() => installVoiceModels(gptSoVitsEngineId)} disabled={(Boolean(gptSoVitsEngineState?.available) && !gptCudaUpgradeNeeded) || activeJobRunning}>
                {activeJobRunning && activeJob?.type === "model_install" ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
                {gptCudaUpgradeNeeded ? "Upgrade Fine Training to CUDA" : "Install GPT-SoVITS"}
              </AppButton>
              <AppButton tone={selectedEngine === openVoiceEngineId && !engineReady ? "accent" : "secondary"} onClick={() => installVoiceModels(openVoiceEngineId)} disabled={Boolean(health?.engines?.openVoiceV2Local?.available) || activeJobRunning}>
                {activeJobRunning && activeJob?.type === "model_install" ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
                Install OpenVoice
              </AppButton>
            </div>
          </details>
        </section>

        <section className="voice-side-panel voice-output-panel">
          <div className="voice-panel-title">
            <Headphones size={20} />
            <h3>Audio outputs</h3>
          </div>
          {referenceSampleUrl ? (
            <div className="voice-ab-preview">
              <strong>Reference sample</strong>
              <audio controls src={referenceSampleUrl} preload="metadata" />
            </div>
          ) : null}
          {displayedOutputs.length ? (
            <div className="voice-preview-output-list" aria-label="Generated voice outputs">
              {displayedOutputs.map((output) => (
                <VoiceOutputCard
                  key={output.id}
                  output={output}
                  onDelete={deleteOutput}
                  onOpenFolder={onOpenPath}
                />
              ))}
            </div>
          ) : (
            <p className="voice-muted">Generated audio will appear here.</p>
          )}
        </section>

        <section className="voice-side-panel voice-tip-panel">
          <img src="/assets/magic-box-sidebar-girl.png" alt="" aria-hidden="true" />
          <div>
            <strong>Style tags</strong>
            <p>{voiceStyles.filter((style) => style !== "neutral").slice(0, 5).map((style) => `(${style})`).join(" ")}</p>
          </div>
        </section>
      </aside>
      {modelVersionDeleteConfirmation ? (
        <AccessibleConfirmationDialog
          confirmation={modelVersionDeleteConfirmation}
          onClose={() => setModelVersionDeleteConfirmation(null)}
        />
      ) : null}
    </section>
  );
}

export default VoiceClonePage;
