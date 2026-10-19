export default function VtvEngineStatusCard({ engine, state = {}, targetState = {}, selectedTargetId = "", onTargetChange, onBuildReference, buildingReference = false }) {
  const targets = Array.isArray(targetState.targets) ? targetState.targets : [];
  const runtimeReady = Boolean(state.available || state.workerReady);
  const selectedTarget = targets.find((target) => target.artifactId === selectedTargetId) || targetState.selectedTarget || null;
  const targetReady = selectedTarget?.ready === true || targetState.ready === true;
  return (
    <article className="voice-vtv-status-card">
      <strong>{engine?.displayName || engine?.id}</strong>
      <span>{runtimeReady ? "Runtime ready" : state.installed ? "Runtime unhealthy" : "Not installed"} · {state.runtimeVersion || "version unknown"}</span>
      <span>{targetReady ? "Target ready" : engine?.capabilities?.requiresTargetModel ? "Target model required" : "20–25 s reference required"}</span>
      {targets.length ? (
        <label>
          <span>{engine?.capabilities?.requiresTargetModel ? "Target model" : "Reference artifact"}</span>
          <select value={selectedTarget?.artifactId || ""} onChange={(event) => onTargetChange?.(event.target.value)}>
            {targets.map((target) => (
              <option key={target.artifactId} value={target.artifactId}>
                {target.artifactId}{target.ready ? " · ready" : " · invalid"}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {!targetReady && targetState.errors?.length ? <small className="voice-error">{targetState.errors.join("; ")}</small> : null}
      {!targetReady && targetState.action ? <small>{targetState.action}</small> : null}
      {onBuildReference ? (
        <button type="button" onClick={onBuildReference} disabled={buildingReference}>
          {buildingReference ? "Building reference…" : targetReady ? "Rebuild reference" : "Build reference"}
        </button>
      ) : null}
    </article>
  );
}
