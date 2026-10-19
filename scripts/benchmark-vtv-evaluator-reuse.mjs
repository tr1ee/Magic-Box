import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import assert from "node:assert/strict";

const root = process.cwd();
const output = path.join(root, "artifacts/ttv-strict-2026-09-06/vtv-speed");
await fs.mkdir(output, { recursive: true });
const data = path.join(root, "MagicBoxData/voice_clone");
const db = JSON.parse(await fs.readFile(path.join(data, "voice_clone.json"), "utf8"));
const profile = db.profiles.find(item => item.id === "voice-profile-1787531284835-22d3cc");
const references = profile.voiceModel.datasetSamples.map(item => item.audioPath).filter(Boolean).slice(0, 16);
const audio = path.join(root, "artifacts/vtv-quality-2026-09-06/rvc-seed31002-repeat1.wav");
const common = {
  modelDir: path.join(data, "voice_engine/seed-vc/models/seed-vc-svc-v1"),
  sourceAudioPath: audio, convertedAudioPath: audio, durationSeconds: 19.98,
  targetReferenceAudioPath: references[0], targetReferenceAudioPaths: references,
  settings: { pitchShift: 0, convertStyle: false }
};
const requests = [
  { ...common, action: "analyze-song-conversion" },
  { ...common, action: "analyze-speaker-identity-batch", candidates: [{ id: "historical-rvc-vocal", audioPath: audio }] }
];
function start(worker, label) {
  const child = spawn(path.join(data, "voice_engine/seed-vc/runtime/python/python.exe"), [worker], {
    cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: {
      ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
      MAGIC_BOX_SEED_VC_REPO: path.join(data, "voice_engine/seed-vc/runtime/seed-vc"),
      MAGIC_BOX_VOICE_QUALITY_EVALUATOR_DIR: path.join(data, "voice_engine/quality-evaluators"),
      NUMBA_CACHE_DIR: path.join(output, "numba"), TEMP: output, TMP: output
    }
  });
  let errorText = "";
  child.stderr.on("data", chunk => { errorText += chunk; });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on("line", line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    if (value.event || !pending.has(value.id)) return;
    const request = pending.get(value.id); pending.delete(value.id);
    value.ok ? request.resolve(value.result) : request.reject(new Error(value.error));
  });
  child.on("error", error => { for (const entry of pending.values()) entry.reject(error); });
  child.on("close", code => { for (const entry of pending.values()) entry.reject(new Error(`Worker closed: ${code} ${errorText.slice(-1000)}`)); });
  return {
    request(payload) { return new Promise((resolve, reject) => { const id = `${label}-${pending.size}-${Date.now()}`; pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`); }); },
    async close() { const exited = once(child, "close"); child.stdin.end(); await exited; lines.close(); await fs.writeFile(path.join(output, `${label}.log`), errorText); }
  };
}
const reports = [];
for (const reuse of [false, true]) {
  const label = reuse ? "reused" : "cold";
  const worker = reuse ? path.join(root, "server/voice_engine_worker_seed_vc.py") : path.join(root, "artifacts/ttv-strict-2026-09-06/before/seed-worker-before-reuse.py");
  const started = performance.now();
  const results = [];
  const stages = [];
  let session;
  try {
    for (const [index, request] of requests.entries()) {
      const stageStart = performance.now();
      session ||= start(worker, `${label}-${index}`);
      results.push(await session.request(request));
      if (!reuse) { await session.close(); session = null; }
      stages.push({ action: request.action, elapsedSec: (performance.now() - stageStart) / 1000 });
    }
  } finally { if (session) await session.close(); }
  reports.push({ label, elapsedSec: (performance.now() - started) / 1000, stages, results });
  console.log(JSON.stringify({ label, elapsedSec: reports.at(-1).elapsedSec, stages }));
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ reports }, null, 2));
}
assert.deepEqual(reports[1].results, reports[0].results, "Reusing evaluators must preserve all quality metrics and verdicts");
await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ identicalMetrics: true, speedup: reports[0].elapsedSec / reports[1].elapsedSec, reports }, null, 2));
