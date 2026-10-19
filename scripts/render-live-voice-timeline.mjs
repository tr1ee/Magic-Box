import fs from "node:fs/promises";
import path from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/render-live-voice-timeline.mjs <trace-directory>");
  process.exit(2);
}
const files = (await fs.readdir(path.resolve(input))).filter((name) => name.endsWith(".jsonl") && name !== "session.jsonl");
const rows = [];
for (const name of files) {
  for (const line of (await fs.readFile(path.join(input, name), "utf8")).split(/\r?\n/u).filter(Boolean)) {
    try { const event = JSON.parse(line); rows.push({ replyId: path.basename(name, ".jsonl"), event: event.event, ms: event.processMonotonicMs, seq: event.audioFrameSeq, commit: event.commitSeq, inference: event.inferenceInstanceId, profile: event.profileId }); } catch {}
  }
}
rows.sort((left, right) => Number(left.ms || 0) - Number(right.ms || 0));
const escaped = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const body = rows.map((row) => `<tr><td>${escaped(row.ms)}</td><td>${escaped(row.replyId)}</td><td>${escaped(row.event)}</td><td>${escaped(row.commit)}</td><td>${escaped(row.seq)}</td><td>${escaped(row.inference)}</td><td>${escaped(row.profile)}</td></tr>`).join("\n");
const html = `<!doctype html><meta charset="utf-8"><title>Live voice causal trace</title><style>body{font:13px system-ui;margin:24px;background:#101318;color:#eef}table{border-collapse:collapse;width:100%}th,td{border:1px solid #39404b;padding:5px;text-align:left}th{position:sticky;top:0;background:#202632}code{color:#9fe}</style><h1>Live voice causal trace</h1><p>Server/PCM timeline. Browser Worklet playback must be present before audible continuity is considered.</p><table><thead><tr><th>monotonic ms</th><th>reply</th><th>event</th><th>commit</th><th>frame</th><th>inference</th><th>profile</th></tr></thead><tbody>${body}</tbody></table>`;
const output = path.join(path.resolve(input), "timeline.html");
await fs.writeFile(output, html, "utf8");
console.log(output);
