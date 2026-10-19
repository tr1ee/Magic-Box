import { VTV_PIPELINE_VERSION } from "./constants.mjs";

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hardGate(candidate) {
  const identity = candidate?.identity || {};
  const encoderB = identity.encoderB || {};
  const perceptual = candidate?.perceptual || {};
  return identity.accepted === true
    && encoderB.passed === true
    && perceptual.available === true
    && finite(perceptual.score) !== null
    && candidate?.conversionStrictValidationAccepted === true;
}

export function rankVtvSpeechCandidates(candidates = [], { allowNeedsReview = true } = {}) {
  const reports = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const identityScore = finite(candidate?.identity?.targetSimilarity, 0);
    const encoderBScore = finite(candidate?.identity?.encoderB?.score, 0);
    const perceptualScore = finite(candidate?.perceptual?.score, 0);
    const hardPassed = hardGate(candidate);
    const reasons = [];
    if (!candidate?.conversionStrictValidationAccepted) reasons.push("content_or_timing_gate_failed");
    if (candidate?.identity?.accepted !== true) reasons.push("encoder_a_identity_failed");
    if (candidate?.identity?.encoderB?.passed !== true) reasons.push("encoder_b_identity_failed");
    if (candidate?.perceptual?.available !== true) reasons.push("perceptual_evaluator_unavailable");
    return {
      ...candidate,
      vtvQuality: {
        pipelineVersion: VTV_PIPELINE_VERSION,
        hardPassed,
        needsReview: !hardPassed && allowNeedsReview && reasons.every((reason) => reason === "perceptual_evaluator_unavailable"),
        reasons,
        score: Number((identityScore * 0.5 + encoderBScore * 0.3 + perceptualScore * 0.2).toFixed(6))
      }
    };
  });
  reports.sort((left, right) => (
    Number(right.vtvQuality?.hardPassed) - Number(left.vtvQuality?.hardPassed)
    || Number(right.vtvQuality?.score || 0) - Number(left.vtvQuality?.score || 0)
    || String(left.vtvCandidateId || left.id || "").localeCompare(String(right.vtvCandidateId || right.id || ""))
  ));
  return {
    selected: reports.find((candidate) => candidate.vtvQuality.hardPassed)
      || (allowNeedsReview ? reports.find((candidate) => candidate.vtvQuality.needsReview) : null),
    candidates: reports,
    rejectedCandidateIds: reports.filter((candidate) => !candidate.vtvQuality.hardPassed).map((candidate) => String(candidate.vtvCandidateId || candidate.id || ""))
  };
}
