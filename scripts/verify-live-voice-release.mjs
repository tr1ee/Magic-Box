import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const benchmarkPath = path.resolve(process.env.MAGIC_BOX_LIVE_VOICE_BENCHMARK || "artifacts/live-voice-benchmark.json");
let benchmark;
try {
  benchmark = JSON.parse(await fs.readFile(benchmarkPath, "utf8"));
} catch {
  console.error(`Streaming voice release is blocked: benchmark evidence is missing at ${benchmarkPath}.`);
  process.exit(1);
}
const ageMs = Date.now() - new Date(benchmark.measuredAt || 0).getTime();
const revisionsMatch = benchmark.modelVersions?.tts === "fun-cosyvoice3-0.5b-2512-29e01c4"
  && benchmark.modelVersions?.asr === "whisper-large-v3-turbo-0a363e9";
const validV2Evidence = benchmark.schemaVersion === 2
  && benchmark.schedulerMode === "bounded-segments"
  && benchmark.combinedChatActive === true
  && benchmark.browserPlaybackSimulationActive === true
  && benchmark.cancellationCycles === 20
  && Number(benchmark.orphanWorkCount) === 0;
const validV3Evidence = benchmark.schemaVersion === 3
  && benchmark.protocolVersion >= 5
  && benchmark.persistentTtsSession === true
  && benchmark.schedulerMode === "persistent-stream"
  && benchmark.combinedChatActive === true
  && benchmark.browserPlaybackSimulationActive === true
  && benchmark.cancellationCycles === 20
  && Number(benchmark.orphanWorkCount) === 0;
if (!benchmark.pass || (!validV2Evidence && !validV3Evidence) || !revisionsMatch || ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) {
  const failures = [];
  if (!benchmark.pass) failures.push(`benchmark.pass=false (rtfP95=${benchmark.perSegmentRtfP95}, speaker=${benchmark.speakerSimilarity}, CER=${benchmark.chineseCer})`);
  if (!validV2Evidence && !validV3Evidence) failures.push("evidence schema/protocol fields are incomplete");
  if (!revisionsMatch) failures.push("model revisions are not the pinned CosyVoice3/Whisper revisions");
  if (ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) failures.push("benchmark is missing or older than 24 hours");
  console.error(`Streaming voice release is blocked: ${failures.join("; ")}.`);
  process.exit(1);
}
console.log(`Streaming voice release gate passed with benchmark ${benchmarkPath}.`);
