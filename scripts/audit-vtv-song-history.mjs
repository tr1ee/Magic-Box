import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { buildSongMixPlan, resolveSongPitchShift } from "../server/voice/vtv/song-mix.mjs";

const databasePath = path.resolve(process.argv[2] || "MagicBoxData/voice_clone/voice_clone.json");
const outputDir = path.resolve(process.argv[3] || "artifacts/vtv-quality-2026-09-06");
await fs.mkdir(outputDir, { recursive: true });
const database = JSON.parse((await fs.readFile(databasePath, "utf8")).replace(/^\uFEFF/, ""));
const outputs = (database.outputs || []).filter(o => o.mode === "song-v2v")
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 3);
const records = [];
for (const output of outputs) {
  const metadata = JSON.parse(await fs.readFile(output.metadataPath, "utf8"));
  const quality = metadata.quality || {};
  const pitchShift = resolveSongPitchShift({ engineId: output.engine, settings: metadata.settings });
  const plan = buildSongMixPlan({ vocalPitchShiftSemitones: pitchShift });
  const audio = await fs.readFile(output.outputPath);
  const clipPath = path.join(outputDir, `${output.id}-35s-40s.wav`);
  execFileSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", "35", "-i", output.outputPath, "-t", "5", "-c:a", "pcm_s16le", clipPath], { windowsHide: true });
  records.push({
    id: output.id, engineId: output.engine, createdAt: output.createdAt, sourceAudioName: output.sourceAudioName,
    audioPath: output.outputPath, sha256: createHash("sha256").update(audio).digest("hex"),
    excerptPath: clipPath, excerptRangeSec: [35, 40],
    configuredVocalPitchShiftSemitones: pitchShift,
    historicalAccompanimentPitchShiftSemitones: 0,
    historicalPitchClassMismatchCents: Math.abs(plan.accompanimentPitchShiftSemitones) * 100,
    correctedAccompanimentPitchShiftSemitones: plan.accompanimentPitchShiftSemitones,
    pitchEvidence: "Historical settings plus inspected mixer: vocal conversion shifted; accompaniment only received a volume filter. This is not an independent F0 measurement of the final mix.",
    qualityStatus: metadata.qualityStatus, metrics: quality.songIntegrity?.metrics,
    rejectionReasons: quality.songIntegrity?.reasons, problemIntervals: quality.songIntegrity?.problemIntervals,
    identity: quality.identity, finalMixGate: quality.finalMixGate,
    limitations: ["Metrics are retained generation-time measurements, not newly evaluated scores.", "Excerpts contain the historical mix, not corrected audio."]
  });
}
await fs.writeFile(path.join(outputDir, "history-audit.json"), JSON.stringify({ databasePath, records }, null, 2));
console.log(JSON.stringify(records.map(({ id, engineId, historicalPitchClassMismatchCents, metrics }) => ({ id, engineId, historicalPitchClassMismatchCents, targetSimilarity: metrics?.targetSimilarity, voicedDropoutPercent: metrics?.voicedDropoutPercent, abruptPitchJumpCount: metrics?.abruptPitchJumpCount })), null, 2));
