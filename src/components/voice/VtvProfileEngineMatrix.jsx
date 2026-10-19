import { useState } from "react";
import { ArrowRight, CheckCircle2, ChevronDown, FileArchive, ListChecks, Music2, Sparkles, Upload } from "lucide-react";
import { vtvRvcEngineId, vtvSeedEngineId, vtvYingMusicEngineId } from "../../../shared/voiceClone.mjs";
import { AppButton, classNames } from "../AppButton.jsx";

const engines = [
  {
    id: vtvSeedEngineId,
    label: "Seed-VC",
    icon: Sparkles,
    target: "Existing TTV voice reference",
    setup: "No separate training required",
    requirement: "A ready TTV profile with at least one usable reference model."
  },
  {
    id: vtvRvcEngineId,
    label: "RVC v2",
    icon: FileArchive,
    target: "Trained .pth + matching .index",
    setup: "Trained automatically from approved Profile clips",
    requirement: "At least 10 minutes of clean approved voice. MagicBox generates the .pth model and matching .index automatically."
  },
  {
    id: vtvYingMusicEngineId,
    label: "YingMusic-SVC",
    icon: Music2,
    target: "20–25 second song reference",
    setup: "Built automatically from prepared clips",
    requirement: "3–6 clean, eligible clips with 20–25 seconds of usable voice in total."
  }
];

function runtimeLabel(state = {}) {
  if (state.available || state.workerReady) return `Runtime ready${state.runtimeVersion ? ` · ${state.runtimeVersion}` : ""}`;
  return state.installed ? "Runtime needs attention" : "Runtime not installed";
}

function durationLabel(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  return value >= 60 ? `${(value / 60).toFixed(1)} min` : `${value.toFixed(1)} s`;
}

function TargetPicker({ state, onChange }) {
  const targets = Array.isArray(state?.targets) ? state.targets : [];
  if (!targets.length) return null;
  return (
    <label className="voice-profile-engine-target-picker">
      <span>Target used by Voice to Voice</span>
      <select value={state.selectedTarget?.artifactId || ""} onChange={(event) => onChange?.(event.target.value)}>
        {targets.map((target) => (
          <option key={target.artifactId} value={target.artifactId}>
            {target.label || target.artifactId}{target.ready ? " · ready" : " · invalid"}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function VtvProfileEngineMatrix({
  profileName,
  profileStats = {},
  health = {},
  states = {},
  summary = {},
  onBuildSeed,
  seedBuildDisabled = false,
  onImportRvc,
  importingRvc = false,
  onTrainRvc,
  trainingRvc = false,
  onBuildYing,
  buildingYing = false,
  onTargetChange,
  onOpenProfiles,
  onContinue
}) {
  const [rvcFiles, setRvcFiles] = useState({ modelFile: null, indexFile: null });
  const readyCount = Number.isFinite(Number(summary.readyCount))
    ? Number(summary.readyCount)
    : engines.filter((engine) => states[engine.id]?.ready).length;
  const rvcState = states[vtvRvcEngineId] || {};
  const rvcTraining = rvcState.migration?.trainingReadiness || {};
  const materialClipCount = Number.isFinite(Number(rvcState.migration?.eligibleClipCount))
    ? Number(rvcState.migration.eligibleClipCount)
    : Number(profileStats.eligibleClipCount) || 0;
  const materialDurationSeconds = Number.isFinite(Number(rvcTraining.voicedDurationSec))
    ? Number(rvcTraining.voicedDurationSec)
    : Number(profileStats.eligibleSpeechSeconds) || 0;
  const yingState = states[vtvYingMusicEngineId] || {};
  const yingMigration = yingState.migration || {};
  const canImportRvc = Boolean(rvcFiles.modelFile && rvcFiles.indexFile && !importingRvc);

  async function importRvc() {
    if (!canImportRvc) return;
    const imported = await onImportRvc?.(rvcFiles);
    if (imported !== false) setRvcFiles({ modelFile: null, indexFile: null });
  }

  if (!profileName) {
    return (
      <section className="voice-profile-engine-matrix voice-vtv-setup-empty" aria-label="VTV model setup">
        <Music2 size={34} />
        <h3>Create a TTV profile first</h3>
        <p>VTV targets belong to a voice profile, but they are created and managed separately on this page.</p>
        <AppButton tone="accent" onClick={onOpenProfiles}>Open TTV Profiles</AppButton>
      </section>
    );
  }

  return (
    <section className="voice-profile-engine-matrix" aria-label={`${profileName} VTV model setup`}>
      <header>
        <div>
          <span className="voice-profile-engine-kicker">Voice to Voice · model setup</span>
          <h3>VTV Models for {profileName}</h3>
          <p>Set up conversion targets here. This page does not retrain or replace the model used by Text to Voice.</p>
        </div>
        <span className={classNames("voice-profile-engine-summary", readyCount === 3 && "complete")}>
          <strong>{readyCount}/3</strong>
          <small>VTV targets ready</small>
        </span>
      </header>

      <div className="voice-vtv-boundary-note">
        <div><strong>TTV Profiles</strong><span>Upload voice sources and build the speaking voice.</span></div>
        <ArrowRight size={18} />
        <div><strong>VTV Models</strong><span>Create or bind targets for voice conversion.</span></div>
        <ArrowRight size={18} />
        <div><strong>Voice to Voice</strong><span>Select a ready engine and convert audio.</span></div>
      </div>

      <section className="voice-vtv-setup-steps" aria-label="VTV setup steps">
        <div className="voice-vtv-setup-step">
          <b>1</b>
          <div><strong>Prepare target voice material</strong><span>Use TTV Profiles to upload, separate, review, and approve clean clips.</span></div>
        </div>
        <div className="voice-vtv-setup-step">
          <b>2</b>
          <div><strong>Create the engine targets you need</strong><span>Seed reuses a voice reference, RVC trains from approved clips, and YingMusic builds a short reference.</span></div>
        </div>
        <div className="voice-vtv-setup-step">
          <b>3</b>
          <div><strong>Verify and convert</strong><span>Only engines marked Ready can be selected on the Voice to Voice page.</span></div>
        </div>
      </section>

      <section className="voice-vtv-source-summary" aria-label="Prepared source summary">
        <div>
          <ListChecks size={20} />
          <div><strong>Material available from TTV Profiles</strong><span>These clips can be reused where a VTV engine accepts references or training data.</span></div>
        </div>
        <dl>
          <div><dt>Uploaded</dt><dd>{profileStats.sampleCount || 0}</dd></div>
          <div><dt>Prepared</dt><dd>{profileStats.preparedSourceCount || 0}</dd></div>
          <div><dt>Eligible clips</dt><dd>{materialClipCount}</dd></div>
          <div><dt>Eligible voice</dt><dd>{durationLabel(materialDurationSeconds)}</dd></div>
        </dl>
        <AppButton tone="secondary" onClick={onOpenProfiles}>Manage source material</AppButton>
      </section>

      <section className="voice-vtv-requirements" aria-label="VTV model requirements">
        <div className="voice-vtv-section-heading">
          <span>What each engine needs</span>
          <p>You do not choose the same files for every model. Each engine has a different setup method.</p>
        </div>
        <div className="voice-vtv-requirement-grid">
          {engines.map((engine) => {
            const Icon = engine.icon;
            return (
              <article key={engine.id}>
                <span><Icon size={18} /></span>
                <div><strong>{engine.label}</strong><small>{engine.setup}</small></div>
                <p>{engine.requirement}</p>
              </article>
            );
          })}
        </div>
      </section>

      {summary.legacyProfile ? (
        <div className="voice-profile-engine-upgrade-note">
          <Upload size={19} />
          <div>
            <strong>Older profile · optional VTV upgrade</strong>
            <p>Your existing TTV and Seed targets stay unchanged. Add RVC or YingMusic support below only when you want to use those conversion engines.</p>
          </div>
        </div>
      ) : null}

      <div className="voice-vtv-section-heading">
        <span>Engine targets for {profileName}</span>
        <p>Complete only the engines you plan to use. One target never replaces another.</p>
      </div>

      <div className="voice-profile-engine-grid">
        {engines.map((engine) => {
          const Icon = engine.icon;
          const state = states[engine.id] || {};
          const runtime = health[engine.id] || {};
          const ready = state.ready === true;
          return (
            <article key={engine.id} className={classNames("voice-profile-engine-card", ready && "ready")}>
              <div className="voice-profile-engine-card-heading">
                <span><Icon size={19} /></span>
                <div><strong>{engine.label}</strong><small>{engine.target}</small></div>
                <em>{ready ? <><CheckCircle2 size={15} /> Ready</> : "Action needed"}</em>
              </div>
              <p>{runtimeLabel(runtime)}</p>
              <p>{ready ? `Target ready · ${state.selectedTarget?.label || state.selectedTarget?.artifactId || "bound"}` : state.errors?.[0] || state.action || "A target is required."}</p>
              {engine.id === vtvSeedEngineId ? null : (
                <TargetPicker state={state} onChange={(artifactId) => onTargetChange?.(engine.id, artifactId)} />
              )}

              {engine.id === vtvSeedEngineId ? (
                <div className="voice-vtv-engine-action">
                  <small>Uses a ready reference model already built on TTV Profiles. No separate Seed training files are required here.</small>
                  <AppButton tone={ready ? "secondary" : "accent"} onClick={onBuildSeed} disabled={seedBuildDisabled}>
                    <Sparkles size={16} />
                    {ready ? "Refresh Seed reference" : state.migration?.canBuild ? "Create Seed reference" : "Prepare TTV profile first"}
                  </AppButton>
                </div>
              ) : null}

              {engine.id === vtvRvcEngineId ? (
                <div className="voice-profile-rvc-import">
                  <div className="voice-rvc-training-readiness">
                    <div>
                      <strong>{rvcTraining.ready ? "Profile is ready for RVC training" : "More approved voice is required"}</strong>
                      <small>
                        {durationLabel(rvcTraining.voicedDurationSec)} of 10 min minimum · {rvcState.migration?.eligibleClipCount || 0} approved transcript clips
                      </small>
                    </div>
                    <small>RVC trains directly from approved Profile clips. You do not need to rebuild the Text to Voice model.</small>
                    {!rvcTraining.songCapable ? <small>Current material is speech-only. It can train RVC, but singing similarity across a very different vocal range is not guaranteed until real target singing is included.</small> : null}
                    <span><i style={{ width: `${Math.min(100, Math.round((Number(rvcTraining.voicedDurationSec) || 0) / 6))}%` }} /></span>
                    <p>{rvcTraining.ready
                      ? ready
                        ? "New clips do not change the currently bound RVC model automatically. Train a new RVC model to include them; MagicBox will then replace the bound target after validation."
                        : "MagicBox will create the dataset snapshot, extract RMVPE pitch and HuBERT features, train RVC v2, build the index, validate the result, and bind it automatically."
                      : `${durationLabel(rvcTraining.missingVoicedDurationSec)} more approved voice is needed. Add audio or verify transcripts on TTV Profiles.`}</p>
                    {rvcTraining.ready ? (
                      <AppButton tone="accent" onClick={onTrainRvc} disabled={trainingRvc || importingRvc}>
                        {trainingRvc ? "Training RVC model…" : ready ? "Train a new RVC model" : "Train RVC from this Profile"}
                      </AppButton>
                    ) : (
                      <AppButton tone="accent" onClick={onOpenProfiles}>Add audio or verify transcripts</AppButton>
                    )}
                  </div>
                  <details>
                    <summary><span>Advanced · import a model trained elsewhere</span><ChevronDown size={16} /></summary>
                    <div className="voice-profile-rvc-import-fields">
                      <p>This is only for an existing RVC training bundle. Choose the two files from the same training run. The approved Profile clip checks that the runtime and files work; real cross-speaker song quality is evaluated after conversion.</p>
                      <label>
                        <span>Trained model (.pth)</span>
                        <small>The main model produced after RVC training.</small>
                        <input aria-label="Trained model (.pth)" type="file" accept=".pth" onChange={(event) => setRvcFiles((current) => ({ ...current, modelFile: event.target.files?.[0] || null }))} />
                      </label>
                      <label>
                        <span>Matching feature index (.index)</span>
                        <small>The index produced by the same training run as the .pth file.</small>
                        <input aria-label="Matching feature index (.index)" type="file" accept=".index" onChange={(event) => setRvcFiles((current) => ({ ...current, indexFile: event.target.files?.[0] || null }))} />
                      </label>
                      <AppButton tone="accent" onClick={importRvc} disabled={!canImportRvc}>
                        {importingRvc ? "Inspecting and verifying…" : "Verify and bind RVC model"}
                      </AppButton>
                    </div>
                  </details>
                </div>
              ) : null}

              {engine.id === vtvYingMusicEngineId ? (
                <div className="voice-vtv-engine-action">
                  <small>{yingMigration.canBuild
                    ? `${yingMigration.eligibleClipCount || 0} eligible clips provide ${durationLabel(yingMigration.availableDurationSec)}. Magic Box will select and combine them automatically.`
                    : `Available clean voice: ${durationLabel(yingMigration.availableDurationSec)}. Prepare 3–6 clips totaling 20–25 seconds.`}</small>
                  <AppButton tone={ready ? "secondary" : "accent"} onClick={onBuildYing} disabled={buildingYing || !yingMigration.canBuild}>
                    <Music2 size={16} />
                    {buildingYing ? "Creating reference…" : ready ? "Recreate YingMusic reference" : yingMigration.canBuild ? "Create reference automatically" : "Prepare more clean clips"}
                  </AppButton>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      <footer className="voice-vtv-setup-footer">
        <div><strong>{readyCount ? "At least one VTV engine is ready" : "Finish one engine target to continue"}</strong><span>You only need the engine or engines you intend to use.</span></div>
        <AppButton tone="accent" onClick={onContinue} disabled={!readyCount}>Continue to Voice to Voice <ArrowRight size={16} /></AppButton>
      </footer>
    </section>
  );
}
