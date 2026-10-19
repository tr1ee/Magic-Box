export default function VtvComparisonResults({ results = [] }) {
  if (!results.length) return null;
  return (
    <section className="voice-vtv-comparison-results" aria-label="VTV comparison results">
      {results.map((result) => (
        <article key={result.outputId || result.engineId}>
          <strong>{result.engineDisplayName || result.engineId}</strong>
          <span>{result.executionStatus || "queued"} · {result.qualityStatus || "not-evaluated"}</span>
          {Number.isFinite(Number(result.identity?.targetSimilarity)) ? (
            <small>
              Target identity A {Number(result.identity.targetSimilarity).toFixed(3)}
              {Number.isFinite(Number(result.identity?.targetSimilarityFloor)) ? ` / required ${Number(result.identity.targetSimilarityFloor).toFixed(3)}` : ""}
            </small>
          ) : null}
          {Number.isFinite(Number(result.identity?.encoderB?.score)) ? (
            <small>
              Target identity B {Number(result.identity.encoderB.score).toFixed(3)}
              {Number.isFinite(Number(result.identity.encoderB?.targetSimilarityFloor)) ? ` / required ${Number(result.identity.encoderB.targetSimilarityFloor).toFixed(3)}` : ""}
            </small>
          ) : null}
          {Number.isFinite(Number(result.pitch?.expectedShiftSemitones)) ? <small>Applied pitch {Number(result.pitch.expectedShiftSemitones) > 0 ? "+" : ""}{Number(result.pitch.expectedShiftSemitones)} semitones</small> : null}
          {result.error ? <small>{result.error.message || result.error.code}</small> : null}
        </article>
      ))}
    </section>
  );
}
