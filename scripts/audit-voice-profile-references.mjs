import fs from "node:fs/promises";
import path from "node:path";

const dbPath = process.argv[2] || process.env.VOICE_DB_PATH;
const profileId = process.argv[3] || process.env.VOICE_PROFILE_ID;
const outputPath = process.argv[4] || process.env.VOICE_REFERENCE_AUDIT || "artifacts/voice-reference-audit.json";

if (!dbPath || !profileId) {
  console.error("Usage: node scripts/audit-voice-profile-references.mjs <voice_clone.json> <profile-id> [output.json]");
  process.exit(2);
}

function wavInfo(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && start + 16 <= buffer.length) {
      fmt = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      };
    }
    if (id === "data") data = { offset: start, size: Math.min(size, Math.max(0, buffer.length - start)) };
    offset = start + size + (size % 2);
  }
  if (!fmt || !data || fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) throw new Error("unsupported PCM WAV format");
  const bytesPerFrame = Math.max(1, fmt.channels * 2);
  const totalFrames = Math.floor(data.size / bytesPerFrame);
  const durationSeconds = fmt.sampleRate > 0 ? totalFrames / fmt.sampleRate : 0;
  const totalSamples = totalFrames * fmt.channels;
  const step = Math.max(1, Math.floor(totalSamples / 50000));
  let checked = 0;
  let silent = 0;
  let clipped = 0;
  let loudSum = 0;
  let squareSum = 0;
  let firstVoiced = -1;
  let lastVoiced = -1;
  const amplitudes = [];
  for (let index = 0; index < totalSamples; index += step) {
    const sampleOffset = data.offset + index * 2;
    if (sampleOffset + 2 > buffer.length) break;
    const value = buffer.readInt16LE(sampleOffset);
    const normalized = Math.abs(value) / 32768;
    if (normalized < 0.018) silent += 1;
    if (Math.abs(value) >= 32000) clipped += 1;
    loudSum += normalized;
    squareSum += normalized * normalized;
    amplitudes.push(normalized);
    if (normalized >= 0.018) {
      if (firstVoiced < 0) firstVoiced = checked;
      lastVoiced = checked;
    }
    checked += 1;
  }
  const sorted = [...amplitudes].sort((left, right) => left - right);
  const quietCount = Math.max(1, Math.floor(sorted.length * 0.1));
  const noiseSquare = sorted.slice(0, quietCount).reduce((sum, value) => sum + value * value, 0) / quietCount;
  const signalRms = checked ? Math.sqrt(squareSum / checked) : 0;
  const noiseRms = Math.max(1e-5, Math.sqrt(noiseSquare));
  return {
    durationSeconds: Number(durationSeconds.toFixed(3)),
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    silenceRatio: Number((checked ? silent / checked : 0).toFixed(3)),
    clippingRatio: Number((checked ? clipped / checked : 0).toFixed(6)),
    signalToNoiseDb: Number(Math.max(0, Math.min(60, 20 * Math.log10(Math.max(noiseRms, signalRms) / noiseRms))).toFixed(2)),
    leadingSilenceMs: Math.round(firstVoiced < 0 ? durationSeconds * 1000 : firstVoiced / checked * durationSeconds * 1000),
    trailingSilenceMs: Math.round(lastVoiced < 0 ? durationSeconds * 1000 : (checked - 1 - lastVoiced) / checked * durationSeconds * 1000)
  };
}

const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
const profile = (db.profiles || []).find((item) => item?.id === profileId);
if (!profile) throw new Error(`Voice profile not found: ${profileId}`);
const profileSamples = (db.samples || []).filter((item) => item?.profileId === profileId);
const currentIds = new Set(profile.conversationModel?.sourceSegmentIds || []);
const rawCandidates = profileSamples.flatMap((sample) => (sample.segments || []).map((segment) => ({ sample, segment }))).filter(({ segment }) => {
  const duration = Number(segment.durationSeconds) || 0;
  return Boolean(segment.audioPath && String(segment.transcript || "").trim() && duration >= 3 && duration <= 10 && segment.qualityVerdict === "eligible" && segment.boundary === "complete");
});

const candidates = [];
for (const candidate of rawCandidates) {
  let audio = {};
  try {
    audio = wavInfo(await fs.readFile(candidate.segment.audioPath));
  } catch (error) {
    audio = { error: error.message };
  }
  const speechConfidence = Math.max(0, Math.min(1, Number(candidate.segment.speechConfidence) || 0));
  const transcriptConfidence = Math.max(0, Math.min(1, Number(candidate.segment.transcriptConfidence) || 0));
  const durationSeconds = Number(candidate.segment.durationSeconds) || Number(audio.durationSeconds) || 0;
  const signalToNoiseDb = Math.max(0, Number(audio.signalToNoiseDb) || Number(candidate.segment.signalToNoiseDb) || 0);
  const clippingRatio = Math.max(0, Number(audio.clippingRatio) || 0);
  const silenceRatio = Math.max(0, Number(audio.silenceRatio) || 0);
  const leadingSilenceMs = Math.max(0, Number(audio.leadingSilenceMs) || 0);
  const trailingSilenceMs = Math.max(0, Number(audio.trailingSilenceMs) || 0);
  const explicitPreference = profile.conversationPrimaryReferenceSegmentId === candidate.segment.id ? 2 : candidate.segment.preferredPrompt ? 1 : 0;
  const durationScore = Math.max(0, 1 - Math.abs(durationSeconds - 6) / 4);
  const boundaryScore = Math.max(0, 1 - Math.min(1, (leadingSilenceMs + trailingSilenceMs) / 800));
  const rankScore = explicitPreference * 100
    + speechConfidence * 0.32
    + transcriptConfidence * 0.25
    + Math.min(1, signalToNoiseDb / 40) * 0.15
    + Math.max(0, 1 - silenceRatio) * 0.08
    + boundaryScore * 0.08
    + durationScore * 0.12
    - Math.min(1, clippingRatio * 100) * 0.5;
  candidates.push({
    id: candidate.segment.id,
    sampleId: candidate.sample.id,
    transcript: String(candidate.segment.transcript || "").trim(),
    durationSeconds: Number(durationSeconds.toFixed(3)),
    speechConfidence,
    transcriptConfidence,
    qualityVerdict: candidate.segment.qualityVerdict,
    boundary: candidate.segment.boundary,
    audio,
    rankScore: Number(rankScore.toFixed(6)),
    current: currentIds.has(candidate.segment.id),
    primary: profile.conversationModel?.primaryReferenceSegmentId === candidate.segment.id
  });
}

candidates.sort((left, right) => right.rankScore - left.rankScore || left.id.localeCompare(right.id));
const selected = [];
const selectedIds = new Set();
for (const candidate of candidates) {
  if (selected.some((item) => item.sampleId === candidate.sampleId)) continue;
  selected.push(candidate);
  selectedIds.add(candidate.id);
  if (selected.length >= 5) break;
}
for (const candidate of candidates) {
  if (selectedIds.has(candidate.id)) continue;
  selected.push(candidate);
  if (selected.length >= 5) break;
}

const report = {
  schemaVersion: 1,
  auditedAt: new Date().toISOString(),
  profileId,
  profileName: profile.name,
  current: {
    sourceSegmentIds: [...currentIds],
    primaryReferenceSegmentId: profile.conversationModel?.primaryReferenceSegmentId || "",
    referenceCount: Number(profile.conversationModel?.referenceCount) || 0,
    promptSchemaVersion: Number(profile.conversationModel?.promptSchemaVersion) || 0
  },
  selection: {
    eligibleCandidateCount: candidates.length,
    runtimeRankedTopFive: selected.map((item) => item.id),
    currentSetIsRuntimeRankedTopFive: selected.length === currentIds.size && selected.every((item) => currentIds.has(item.id)),
    currentSetRankScores: candidates.filter((item) => currentIds.has(item.id)).map((item) => ({ id: item.id, rankScore: item.rankScore, audio: item.audio })),
    alternativesAboveCurrent: candidates.filter((item) => !currentIds.has(item.id) && item.rankScore > Math.min(...candidates.filter((candidate) => currentIds.has(candidate.id)).map((candidate) => candidate.rankScore))).slice(0, 10)
  },
  candidates
};
await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  profileId,
  eligibleCandidateCount: report.selection.eligibleCandidateCount,
  runtimeRankedTopFive: report.selection.runtimeRankedTopFive,
  currentSetIsRuntimeRankedTopFive: report.selection.currentSetIsRuntimeRankedTopFive,
  alternativesAboveCurrent: report.selection.alternativesAboveCurrent.map((item) => ({ id: item.id, rankScore: item.rankScore }))
}, null, 2));
