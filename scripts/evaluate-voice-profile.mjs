import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const profilePath = process.argv[2];
const outputPath = process.argv[3] || "artifacts/voice-profile-evaluation.json";
if (!profilePath) {
  console.error("Usage: node scripts/evaluate-voice-profile.mjs <profile.json> [output.json]");
  process.exit(2);
}
const source = JSON.parse(await fs.readFile(path.resolve(profilePath), "utf8"));
const profile = Array.isArray(source.profiles)
  ? source.profiles.find((candidate) => candidate.id === process.env.VOICE_PROFILE_ID) || source.profiles[0] || {}
  : source;
const conversation = profile.conversationModel || {};
const referencePaths = Array.isArray(conversation.referenceAudioPaths) ? conversation.referenceAudioPaths : conversation.referenceAudioPath ? [conversation.referenceAudioPath] : [];
const referenceTranscripts = Array.isArray(conversation.referenceTranscripts) ? conversation.referenceTranscripts : conversation.referenceTranscript ? [conversation.referenceTranscript] : [];
const diagnostics = Array.isArray(conversation.referenceDiagnostics) ? conversation.referenceDiagnostics : [];
async function referenceMetadata(audioPath, index) {
  const row = { audioPath, transcript: referenceTranscripts[index] || "", ...(diagnostics[index] || {}) };
  const bytes = await fs.readFile(audioPath).catch(() => null);
  if (bytes?.length >= 44 && bytes.toString("ascii", 0, 4) === "RIFF") {
    let offset = 12;
    let dataBytes = 0;
    while (offset + 8 <= bytes.length) {
      const chunk = bytes.toString("ascii", offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      if (chunk === "fmt " && offset + 36 <= bytes.length) {
        row.channels = bytes.readUInt16LE(offset + 10);
        row.sampleRate = bytes.readUInt32LE(offset + 12);
        row.bitsPerSample = bytes.readUInt16LE(offset + 22);
      }
      if (chunk === "data") { dataBytes = size; break; }
      offset += 8 + size + (size % 2);
    }
    row.durationMs = row.sampleRate && row.channels && row.bitsPerSample ? Math.round(dataBytes / (row.sampleRate * row.channels * (row.bitsPerSample / 8)) * 1000) : 0;
  }
  if (bytes) row.audioSha256 = createHash("sha256").update(bytes).digest("hex");
  return row;
}
const samples = Array.isArray(profile.samples)
  ? profile.samples
  : await Promise.all(referencePaths.map(referenceMetadata));
const references = Array.isArray(profile.referenceSet) ? profile.referenceSet : samples;
const durations = samples.map((sample) => Number(sample.durationMs)).filter(Number.isFinite);
const transcriptChars = samples.map((sample) => String(sample.transcript || "").length).filter(Boolean);
const complete = samples.filter((sample) => sample.audioSha256 && sample.transcript && Number(sample.durationMs) > 0);
const result = {
  schemaVersion: 1,
  evaluatedAt: new Date().toISOString(),
  profileId: profile.id || profile.profileId || null,
  profileRevision: profile.revision || profile.modelVersion || null,
  integrity: {
    sampleCount: samples.length,
    completeSampleCount: complete.length,
    referenceCount: references.length,
    allSamplesHaveTranscript: complete.length === samples.length,
    allSamplesHaveAudioHash: samples.length > 0 && complete.length === samples.length
  },
  coverage: {
    durationMs: { min: durations.length ? Math.min(...durations) : 0, max: durations.length ? Math.max(...durations) : 0, total: durations.reduce((sum, value) => sum + value, 0) },
    transcriptChars: transcriptChars.reduce((sum, value) => sum + value, 0)
  },
  metrics: {
    embeddingCosineSimilarity: null,
    speakerSimilarityAb: null,
    pronunciationErrorRate: null,
    reason: "Audio embeddings and human AB judgments require a pinned local benchmark run; no value is fabricated by this metadata gate."
  },
  decision: complete.length >= Math.max(1, samples.length) && references.length > 0 ? "ready-for-pinned-ab" : "blocked-integrity"
};
await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await fs.writeFile(path.resolve(outputPath), JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify(result, null, 2));
if (result.decision === "blocked-integrity") process.exitCode = 1;
