import fs from "node:fs/promises";
import path from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/analyze-audible-gaps.mjs <reply.jsonl>");
  process.exitCode = 2;
} else {
  const lines = (await fs.readFile(path.resolve(input), "utf8")).split(/\r?\n/u).filter(Boolean);
  const intervals = [];
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.event === "playback.non_silent_started" && event.playheadMs !== undefined) intervals.push({ startMs: Number(event.playheadMs) || 0 });
    if (event.event === "playback.non_silent_ended" && intervals.at(-1) && intervals.at(-1).endMs === undefined) {
      intervals.at(-1).endMs = Number(event.playheadMs) || 0;
      intervals.at(-1).semanticSilence = event.semanticSilence === true;
    }
  }
  const gaps = intervals.slice(1).map((current, index) => {
    const previous = intervals[index];
    return previous.endMs === undefined ? null : { gapMs: Math.max(0, Math.round(current.startMs - previous.endMs)), semanticSilence: previous.semanticSilence === true };
  }).filter(Boolean);
  const midClause = gaps.filter((gap) => !gap.semanticSilence).map((gap) => gap.gapMs).sort((a, b) => a - b);
  const percentile = (value) => midClause.length ? midClause[Math.min(midClause.length - 1, Math.floor((midClause.length - 1) * value))] : 0;
  console.log(JSON.stringify({
    schemaVersion: 1,
    replyId: path.basename(input, path.extname(input)),
    intervalCount: intervals.length,
    gaps,
    midClauseAudibleGapMs: midClause,
    midClauseAudibleGapP50Ms: percentile(0.5),
    midClauseAudibleGapP95Ms: percentile(0.95),
    unexpectedZeroRunMs: midClause
  }, null, 2));
}
