import fs from "node:fs/promises";
import path from "node:path";

const input = process.argv[2];
const output = process.argv[3] || process.env.VOICE_CONTINUITY_REPORT || "";
const maxGapMs = Number(process.env.VOICE_MAX_MID_CLAUSE_GAP_MS || 180) || 180;
const minSamples = Number(process.env.VOICE_MIN_CONTINUITY_SAMPLES || 1) || 1;

if (!input) {
  console.error("Usage: node scripts/verify-live-voice-continuity.mjs <trace.jsonl|trace-directory>");
  process.exit(2);
}

const stat = await fs.stat(path.resolve(input));
const files = stat.isDirectory()
  ? (await fs.readdir(path.resolve(input))).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(input, name))
  : [input];
const intervals = [];
for (const file of files) {
  const lines = (await fs.readFile(path.resolve(file), "utf8")).split(/\r?\n/u).filter(Boolean);
  let active = null;
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.event === "playback.non_silent_started") active = { startMs: Number(event.playheadMs) || 0, file };
    if (event.event === "playback.non_silent_ended" && active) {
      active.endMs = Number(event.playheadMs) || active.startMs;
      active.semanticSilence = event.semanticSilence === true;
      intervals.push(active);
      active = null;
    }
  }
}
const gaps = intervals.slice(1).map((current, index) => {
  const previous = intervals[index];
  return previous.endMs === undefined ? null : {
    gapMs: Math.max(0, Math.round(current.startMs - previous.endMs)),
    semanticSilence: previous.semanticSilence === true,
    file: current.file
  };
}).filter(Boolean);
const audible = gaps.filter((gap) => !gap.semanticSilence);
const failures = audible.filter((gap) => gap.gapMs > maxGapMs);
const result = {
  schemaVersion: 1,
  files,
  intervalCount: intervals.length,
  audibleGapCount: audible.length,
  maxMidClauseAudibleGapMs: Math.max(0, ...audible.map((gap) => gap.gapMs)),
  thresholdMs: maxGapMs,
  minimumSamples: minSamples,
  failures,
  status: intervals.length < minSamples ? "insufficient-samples" : failures.length ? "failed" : "passed"
};
console.log(JSON.stringify(result, null, 2));
if (output) {
  const outputPath = path.resolve(output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
}
if (result.status !== "passed") process.exitCode = 1;
