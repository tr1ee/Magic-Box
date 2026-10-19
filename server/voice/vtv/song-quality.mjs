function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function evaluateDualF0Gate({ rmvpe = null, fcpe = null, maxEstimatorDisagreementCents = 80 } = {}) {
  const rmvpeFrames = Math.max(0, Math.round(Number(rmvpe?.voicedFrames) || 0));
  const fcpeFrames = Math.max(0, Math.round(Number(fcpe?.voicedFrames) || 0));
  const disagreement = finite(fcpe?.medianDisagreementCents, null);
  const available = rmvpeFrames > 0 && fcpeFrames > 0 && disagreement !== null;
  const passed = available && disagreement <= maxEstimatorDisagreementCents;
  return {
    available,
    passed,
    status: passed ? "passed" : available ? "rejected" : "unavailable",
    rmvpeVoicedFrames: rmvpeFrames,
    fcpeVoicedFrames: fcpeFrames,
    medianDisagreementCents: disagreement,
    reasons: passed ? [] : [available ? "f0_estimator_disagreement" : "fcpe_evaluator_unavailable"]
  };
}

export function evaluateStemGate({ vocal = {}, accompaniment = {}, reconstruction = {} } = {}) {
  const reasons = [];
  if (vocal.clipping === true) reasons.push("vocal_clipping");
  if (accompaniment.clipping === true) reasons.push("accompaniment_clipping");
  if (reconstruction.clipping === true) reasons.push("reconstruction_clipping");
  if (finite(vocal.durationSeconds, 0) <= 0) reasons.push("vocal_duration_missing");
  if (finite(accompaniment.durationSeconds, 0) <= 0) reasons.push("accompaniment_duration_missing");
  if (finite(reconstruction.errorDb, null) === null) reasons.push("reconstruction_metrics_missing");
  if (finite(reconstruction.errorDb, 0) > 3) reasons.push("reconstruction_error_high");
  const alignmentCorrelation = finite(reconstruction.alignmentCorrelation, null);
  if (alignmentCorrelation !== null && alignmentCorrelation < 0.2) reasons.push("reconstruction_alignment_low");
  const backgroundLeakRatio = finite(vocal.backgroundLeakRatio, finite(reconstruction.backgroundLeakRatio, 0));
  const vocalResidualRatio = finite(accompaniment.vocalResidualRatio, finite(reconstruction.vocalResidualRatio, 0));
  if (backgroundLeakRatio > 0.35) reasons.push("vocal_background_leak_high");
  if (vocalResidualRatio > 0.25) reasons.push("accompaniment_vocal_residual_high");
  return { passed: reasons.length === 0, reasons };
}

export function evaluateFinalMixGateMetrics({ truePeakDbfs, loudnessDeltaLu, vocalAudibility, clipping = false, pumpScore = 0 } = {}) {
  const reasons = [];
  const peak = finite(truePeakDbfs, null);
  const loudnessDelta = finite(loudnessDeltaLu, null);
  const audibility = finite(vocalAudibility, null);
  if (clipping === true || (peak !== null && peak > -0.1)) reasons.push("true_peak_exceeded");
  if (loudnessDelta !== null && Math.abs(loudnessDelta) > 3) reasons.push("loudness_delta_exceeded");
  if (audibility !== null && audibility < 0.5) reasons.push("vocal_audibility_low");
  if (finite(pumpScore, 0) > 0.25) reasons.push("limiter_pumping_detected");
  return { passed: reasons.length === 0, reasons, truePeakDbfs: peak, loudnessDeltaLu: loudnessDelta, vocalAudibility: audibility };
}
