import { normalizeVoiceQualityMode } from "./voiceClonePipeline.mjs";

export const voiceQualityPolicyVersion = "voice-quality-v2";

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function percentile(values, ratio) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

export function identityReferenceCalibration(scores = [], {
  margin = 0.05,
  centroidFloor = 0.65,
  allowedVariance = 0.18,
  allowedDisagreement = 0.18
} = {}) {
  const values = (Array.isArray(scores) ? scores : []).map((value) => finite(value, NaN)).filter(Number.isFinite);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const sorted = [...values].sort((left, right) => left - right);
  const median = percentile(values, 0.5);
  const p10 = percentile(values, 0.1);
  const p25 = percentile(values, 0.25);
  const variance = values.length && mean !== null
    ? Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length)
    : null;
  return {
    referenceCount: values.length,
    centroidScore: mean,
    medoidScore: median,
    medianScore: median,
    p10Score: p10,
    p25Score: p25,
    standardDeviation: variance,
    lowerBound: p10 === null ? null : p10 - margin,
    centroidFloor,
    allowedVariance,
    allowedDisagreement,
    outlierIndexes: sorted.length > 2
      ? values.map((value, index) => ({ value, index })).filter(({ value }) => value < (median ?? value) - Math.max(margin, (variance || 0) * 0.75)).map(({ index }) => index)
      : []
  };
}

export function evaluateIdentityPolicy({
  encoderA = null,
  encoderB = null,
  calibrationA = null,
  calibrationB = null,
  required = false,
  qualityMode = "strict",
  maxDisagreement = 0.18
} = {}) {
  const mode = normalizeVoiceQualityMode(qualityMode);
  const aScore = finite(encoderA?.score, NaN);
  const bScore = finite(encoderB?.score, NaN);
  const hasA = Number.isFinite(aScore);
  const hasB = Number.isFinite(bScore);
  const disagreement = hasA && hasB ? Math.abs(aScore - bScore) : null;
  const aFloor = finite(calibrationA?.lowerBound, 0.65);
  const bFloor = finite(calibrationB?.lowerBound, 0.65);
  const aPass = hasA && (encoderA?.passed !== false) && aScore >= aFloor && aScore >= finite(calibrationA?.centroidFloor, 0.65);
  const bPass = hasB && (encoderB?.passed !== false) && bScore >= bFloor && bScore >= finite(calibrationB?.centroidFloor, 0.65);
  const unavailable = required && (!hasA || !hasB);
  const reasons = [];
  if (unavailable) reasons.push("speaker_evaluator_unavailable");
  if (required && !aPass) reasons.push("encoder_a_below_calibration");
  if (required && !bPass) reasons.push("encoder_b_below_calibration");
  if (disagreement !== null && disagreement > maxDisagreement) reasons.push("encoder_disagreement");
  const passed = required
    ? !reasons.length
    : (hasA ? aPass || encoderA?.passed === true : true);
  return {
    status: unavailable ? "unavailable" : (required ? (passed ? "pass" : "fail") : "shadow"),
    passed: mode === "strict" ? passed : passed || (!unavailable && reasons.every((reason) => reason === "encoder_disagreement")),
    required,
    encoderA: { ...encoderA, score: hasA ? aScore : null, passed: aPass },
    encoderB: { ...encoderB, score: hasB ? bScore : null, passed: bPass },
    disagreement,
    reasons
  };
}

export function evaluateArtifactPolicy(waveformHealth = {}, {
  required = true,
  qualityMode = "strict"
} = {}) {
  const source = waveformHealth && typeof waveformHealth === "object" ? waveformHealth : {};
  const artifacts = {
    criticalArtifactDetected: source.criticalArtifactDetected === true,
    clipping: source.clipping === true || finite(source.clippingRatio, 0) > 0.01,
    clickPop: source.clickPop === true || source.clickPopDetected === true,
    lineHum: source.lineHum === true || source.lineHumDetected === true || finite(source.lineHumRatio, 0) > 0.25,
    boundaryDiscontinuity: source.boundaryDiscontinuity === true || source.exceedsModulationBaseline === true,
    dcOffset: source.dcOffsetDetected === true,
    electronicRoughness: source.electronicRoughnessDetected === true
  };
  const reasons = Object.entries(artifacts).filter(([, detected]) => detected).map(([key]) => key);
  return {
    ...artifacts,
    status: reasons.length ? "fail" : (required ? "pass" : "shadow"),
    passed: qualityMode === "balanced" ? reasons.every((reason) => reason === "dcOffset") : reasons.length === 0,
    reasons
  };
}

export function evaluatePerceptualPolicy(perceptual = {}, {
  required = false,
  qualityMode = "strict",
  baseline = null
} = {}) {
  const source = perceptual && typeof perceptual === "object" ? perceptual : {};
  const available = source.available === true || source.status === "pass" || source.status === "shadow";
  const score = finite(source.utmos ?? source.mos ?? source.score, NaN);
  const regression = baseline && Number.isFinite(score) && Number.isFinite(Number(baseline.score))
    ? score - Number(baseline.score)
    : null;
  const reasons = [];
  if (required && !available) reasons.push("perceptual_evaluator_unavailable");
  if (source.nisqa?.discontinuityRegression === true) reasons.push("nisqa_discontinuity_regression");
  if (source.nisqa?.colorationRegression === true) reasons.push("nisqa_coloration_regression");
  if (regression !== null && regression < -0.15) reasons.push("naturalness_regression");
  const passed = reasons.length === 0 && (!required || available);
  return {
    status: !available && required ? "unavailable" : (passed ? (required ? "pass" : "shadow") : "fail"),
    passed: qualityMode === "balanced" ? passed || reasons.every((reason) => reason === "naturalness_regression") : passed,
    available,
    dnsMos: source.dnsMos || source.dnsmos || null,
    nisqa: source.nisqa || null,
    utmos: Number.isFinite(score) ? score : null,
    regression,
    reasons
  };
}

export function evaluateContentPolicy({
  primaryAsr = null,
  secondaryAsr = null,
  expectedText = "",
  forcedAlignmentPass = null,
  requiredSecondary = false,
  qualityMode = "strict"
} = {}) {
  const primaryCoverage = finite(primaryAsr?.coverage, NaN);
  const secondaryCoverage = finite(secondaryAsr?.coverage, NaN);
  const secondaryAuthoritative = primaryAsr?.secondaryAuthoritative === true;
  const repeatedText = /(.)\1{2,}/u.test(String(expectedText || "").replace(/[\s\p{P}\p{S}]+/gu, ""));
  const reasons = [];
  if (!secondaryAuthoritative && (!Number.isFinite(primaryCoverage) || primaryCoverage < 0.92)) {
    reasons.push("primary_asr_coverage_low");
  }
  if (requiredSecondary && !Number.isFinite(secondaryCoverage)) reasons.push("secondary_asr_unavailable");
  if (Number.isFinite(secondaryCoverage) && secondaryCoverage < 0.92) reasons.push("secondary_asr_coverage_low");
  if (repeatedText && forcedAlignmentPass !== true) reasons.push("repeated_token_alignment_required");
  if (!secondaryAuthoritative && Number.isFinite(primaryCoverage) && Number.isFinite(secondaryCoverage) && Math.abs(primaryCoverage - secondaryCoverage) > 0.12) {
    reasons.push("asr_disagreement");
  }
  const passed = reasons.length === 0;
  return {
    status: passed ? "pass" : (qualityMode === "balanced" ? "warning" : "fail"),
    passed: qualityMode === "balanced" ? passed || reasons.every((reason) => reason === "asr_disagreement") : passed,
    primaryAsr: primaryAsr || null,
    secondaryAsr: secondaryAsr || null,
    mixedScriptSecondaryAuthoritative: secondaryAuthoritative,
    primaryAsrRawCoverage: finite(primaryAsr?.rawCoverage, null),
    orderedCoverage: (() => {
      const coverages = [primaryCoverage, secondaryCoverage].filter(Number.isFinite);
      return coverages.length ? Math.min(...coverages) : 0;
    })(),
    forcedAlignmentPass: forcedAlignmentPass === true,
    repeatedTokenCase: repeatedText,
    reasons
  };
}

export function createVoiceQualityReport({
  qualityMode = "strict",
  flags = {},
  content = {},
  identity = {},
  perceptual = {},
  artifacts = {},
  evaluatorVersions = {}
} = {}) {
  const mode = normalizeVoiceQualityMode(qualityMode);
  const identityReport = identity.status ? identity : evaluateIdentityPolicy({ required: flags.dualSpeakerGate === true, qualityMode: mode });
  const perceptualReport = perceptual.status ? perceptual : evaluatePerceptualPolicy({}, { required: flags.perceptualGate === true, qualityMode: mode });
  const artifactReport = artifacts.status ? artifacts : evaluateArtifactPolicy({}, { qualityMode: mode });
  const contentReport = content.status ? content : evaluateContentPolicy({ qualityMode: mode });
  const reasons = [...new Set([
    ...(contentReport.reasons || []),
    ...(identityReport.reasons || []),
    ...(perceptualReport.reasons || []),
    ...(artifactReport.reasons || [])
  ])];
  const accepted = [contentReport, identityReport, perceptualReport, artifactReport]
    .filter((report) => report.required !== false || report.status !== "shadow")
    .every((report) => report.passed === true);
  return {
    qualityReportId: `quality_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    policyVersion: voiceQualityPolicyVersion,
    qualityMode: mode,
    evaluatorVersions: { ...evaluatorVersions },
    content: contentReport,
    identity: identityReport,
    perceptual: perceptualReport,
    artifacts: artifactReport,
    decision: { accepted, reasons }
  };
}
