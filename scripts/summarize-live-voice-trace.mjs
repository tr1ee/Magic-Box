import fs from "node:fs/promises";
import path from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/summarize-live-voice-trace.mjs <trace-directory>");
  process.exit(2);
}
const files = (await fs.readdir(path.resolve(input))).filter((name) => name.endsWith(".jsonl") && name !== "session.jsonl");
const eventCounts = new Map();
const replies = [];
for (const name of files) {
  const events = [];
  for (const line of (await fs.readFile(path.join(input, name), "utf8")).split(/\r?\n/u).filter(Boolean)) {
    try { events.push(JSON.parse(line)); } catch {}
  }
  for (const event of events) eventCounts.set(event.event, (eventCounts.get(event.event) || 0) + 1);
  const inferenceIds = [...new Set(events.map((event) => event.inferenceInstanceId).filter(Boolean))];
  const profileIds = [...new Set(events.map((event) => event.profileId).filter(Boolean))];
  const promptHashes = [...new Set(events.map((event) => event.speakerPromptHash).filter(Boolean))];
  const referenceHashes = [...new Set(events.map((event) => event.referenceSetHash).filter(Boolean))];
  replies.push({ replyId: path.basename(name, ".jsonl"), eventCount: events.length, inferenceInstanceIds: inferenceIds, profileIds, speakerPromptHashes: promptHashes, referenceSetHashes: referenceHashes, firstPcmMs: events.find((event) => event.event === "tts.first_pcm")?.processMonotonicMs || null, lastPcmMs: [...events].reverse().find((event) => event.event === "tts.last_pcm")?.processMonotonicMs || null, workletTelemetry: events.some((event) => event.event?.startsWith("playback.")) });
}
const workletAvailable = replies.some((reply) => reply.workletTelemetry);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  traceDirectory: path.resolve(input),
  replyCount: replies.length,
  replies,
  eventCounts: Object.fromEntries([...eventCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
  audibleGapMetrics: { status: workletAvailable ? "available" : "missing-worklet-playback", midClauseAudibleGapMs: [], note: workletAvailable ? "Browser Worklet playback telemetry was received; run verify-live-voice-continuity.mjs for the threshold result." : "Server/PCM trace is real, but no browser Worklet telemetry was received in this run; no audible continuity pass is inferred." }
};
await fs.writeFile(path.join(path.resolve(input), "summary.json"), JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify(result, null, 2));
