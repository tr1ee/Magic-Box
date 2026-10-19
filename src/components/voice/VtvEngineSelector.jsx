import { vtvRvcEngineId, vtvSeedEngineId, vtvYingMusicEngineId } from "../../../shared/voiceClone.mjs";
import { classNames } from "../AppButton.jsx";

const ENGINE_OPTIONS = [
  { id: vtvSeedEngineId, label: "Seed-VC", description: "Existing compatible engine" },
  { id: vtvRvcEngineId, label: "RVC v2", description: "Requires a target .pth + .index model" },
  { id: vtvYingMusicEngineId, label: "YingMusic-SVC", description: "Singing zero-shot; needs a 20–25 s reference" }
];

export default function VtvEngineSelector({ mode, selectedEngineIds, onModeChange, onToggleEngine, health = {}, targets = {} }) {
  const selected = new Set(selectedEngineIds || []);
  return (
    <section className="voice-vtv-engine-selector" aria-label="Song VTV engine selection">
      <div className="voice-mode-switch" aria-label="Song VTV conversion mode">
        <button type="button" className={classNames(mode === "single" && "active")} onClick={() => onModeChange("single")}>Single model</button>
        <button type="button" className={classNames(mode === "compare" && "active")} onClick={() => onModeChange("compare")}>Compare models</button>
      </div>
      <div className="voice-vtv-engine-options">
        {ENGINE_OPTIONS.map((engine) => {
          const state = health?.[engine.id] || {};
          const runtimeReady = Boolean(state.available || state.workerReady);
          const targetReady = engine.id === vtvSeedEngineId ? targets?.[engine.id]?.ready !== false : targets?.[engine.id]?.ready === true;
          return (
            <label key={engine.id} className={classNames("voice-vtv-engine-option", selected.has(engine.id) && "active")}>
              <input
                type={mode === "single" ? "radio" : "checkbox"}
                name="vtv-engine"
                checked={selected.has(engine.id)}
                onChange={() => onToggleEngine(engine.id)}
              />
              <span><strong>{engine.label}</strong><small>{engine.description}</small></span>
              <em>{!runtimeReady ? "Runtime missing" : targetReady ? "Ready" : "Target required"}</em>
            </label>
          );
        })}
      </div>
      <small className="voice-muted">Compare mode runs engines sequentially on the GPU. A failed engine never falls back silently.</small>
    </section>
  );
}
