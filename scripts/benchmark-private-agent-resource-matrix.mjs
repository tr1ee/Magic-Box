import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const baseUrl = process.argv[2] || process.env.MAGIC_BOX_URL;
const output = process.argv[3] || process.env.PRIVATE_AGENT_RESOURCE_MATRIX || "artifacts/private-agent-resource-matrix.json";
if (!baseUrl) {
  console.error("Usage: node scripts/benchmark-private-agent-resource-matrix.mjs <http://127.0.0.1:port> [output.json]");
  process.exit(2);
}

const scenarios = [
  { name: "text_interactive", resourceProfile: "default", voice: false },
  { name: "voice_warming", resourceProfile: "voice", voice: true },
  { name: "voice_responding", resourceProfile: "voice", voice: true },
  { name: "idle_memory_saver", resourceProfile: "default", voice: false }
];
async function readNdjson(response) {
  if (!response.body) return { firstTokenMs: null, totalMs: null, events: 0, tokenGapP95Ms: null, tokenGapP99Ms: null, tokensPerSec: null };
  const started = performance.now();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenMs = null;
  let lastTokenMs = null;
  const tokenGaps = [];
  let events = 0;
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      events += 1;
      const event = JSON.parse(line);
      if (event.type === "answer.delta") {
        const now = performance.now();
        if (firstTokenMs === null) firstTokenMs = Math.round(now - started);
        if (lastTokenMs !== null) tokenGaps.push(Math.round(now - lastTokenMs));
        lastTokenMs = now;
      }
    }
    if (done) break;
  }
  const totalMs = Math.round(performance.now() - started);
  const sortedGaps = [...tokenGaps].sort((left, right) => left - right);
  const percentile = (value) => sortedGaps.length ? sortedGaps[Math.min(sortedGaps.length - 1, Math.floor((sortedGaps.length - 1) * value))] : null;
  return {
    firstTokenMs,
    totalMs,
    events,
    tokenGapP95Ms: percentile(0.95),
    tokenGapP99Ms: percentile(0.99),
    tokensPerSec: firstTokenMs !== null && totalMs > firstTokenMs ? Number((Math.max(0, tokenGaps.length + 1) / ((totalMs - firstTokenMs) / 1000)).toFixed(2)) : null
  };
}
const results = [];
for (const scenario of scenarios) {
  const started = performance.now();
  let status = "not-run";
  let detail = "Requires an installed local generation model and, for voice rows, a ready voice profile.";
  try {
    const [response, modelResponse] = await Promise.all([
      fetch(new URL("/api/assistant/status", baseUrl)),
      fetch(new URL("/api/assistant/models", baseUrl))
    ]);
    const payload = await response.json().catch(() => ({}));
    const modelPayload = await modelResponse.json().catch(() => ({}));
    status = response.ok ? "observed" : "unavailable";
    detail = { httpStatus: response.status, capabilities: payload.capabilities || null, modelStatus: modelPayload.status || null };
    if (process.env.PRIVATE_AGENT_MATRIX_EXECUTE === "1" && ["text_interactive", "voice_responding"].includes(scenario.name)) {
      try {
        const chatResponse = await fetch(new URL("/api/assistant/chat-stream", baseUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(Number(process.env.PRIVATE_AGENT_MATRIX_TIMEOUT_MS || 20000) || 20000),
          body: JSON.stringify({ requestId: crypto.randomUUID(), message: "Reply with one short sentence for a local performance smoke test.", onlineSearch: "off", resourceProfile: scenario.resourceProfile })
        });
        detail.chat = { httpStatus: chatResponse.status, ...(await readNdjson(chatResponse)) };
        status = chatResponse.ok && detail.chat.firstTokenMs !== null ? "executed" : "unavailable";
      } catch (error) {
        detail.chat = { error: error.message };
        status = "unavailable";
      }
    }
  } catch (error) {
    status = "unavailable";
    detail = error.message;
  }
  results.push({ ...scenario, status, elapsedMs: Math.round(performance.now() - started), detail });
}
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  baseUrl,
  matrix: results,
  notes: [
    "This matrix records server capability observations; it does not invent GPU/VRAM measurements.",
    "Run scripts/benchmark-live-voice.mjs for actual voice PCM, playback, and cancellation metrics."
  ]
};
await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
