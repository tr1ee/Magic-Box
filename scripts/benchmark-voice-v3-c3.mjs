import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { WebSocket } from "ws";
import { decodeAudioFrame, estimateSpokenTokens } from "../server/live_voice.mjs";
import { StreamingTextCommitter } from "../shared/speech-planner.mjs";

const baseUrl = process.argv[2] || process.env.MAGIC_BOX_URL;
const profileId = process.argv[3] || process.env.MAGIC_BOX_VOICE_PROFILE_ID;
const outputPath = path.resolve(process.argv[4] || "artifacts/voice-v3/trace-c3-qwen.json");
if (!baseUrl || !profileId) {
  console.error("Usage: node scripts/benchmark-voice-v3-c3.mjs <http://127.0.0.1:port> <profile-id> [output.json]");
  process.exit(2);
}

const prompt = "请用中文简要说明，本地优先处理为什么更能保护用户隐私，并保持语气自然。";
const socketUrl = new URL("/api/assistant/live-voice", baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(socketUrl);
socket.binaryType = "arraybuffer";
const events = [];
const binary = [];
const chatDeltas = [];
const commits = [];
let sequence = 0;

socket.on("message", (data, isBinary) => {
  if (isBinary) binary.push({ at: performance.now(), decoded: decodeAudioFrame(data) });
  else {
    try { events.push({ at: performance.now(), event: JSON.parse(String(data)) }); } catch { /* ignore malformed diagnostics */ }
  }
});

function send(message) { socket.send(JSON.stringify(message)); }
async function waitFor(predicate, timeoutMs = 600000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("C3 trace benchmark timed out.");
}
function timeline(turnId) {
  return events.filter(({ event }) => event.turnId === turnId).map(({ at, event }) => ({ at, ...event }));
}

async function streamChat() {
  const response = await fetch(new URL("/api/assistant/chat-stream", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: `voice-v3-c3-${Date.now()}`,
      message: prompt,
      onlineSearch: "auto",
      resourceProfile: "default"
    })
  });
  if (!response.ok || !response.body) throw new Error(`Chat stream failed with HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() || "";
    for (const line of lines) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
      if (!payload) continue;
      let event;
      try { event = JSON.parse(payload); } catch { continue; }
      if (event.type !== "answer.delta") continue;
      const delta = String(event.delta || "");
      if (!delta) continue;
      chatDeltas.push({ at: performance.now(), chars: delta.length, tokens: estimateSpokenTokens(delta) });
      const chunks = planner.append(delta);
      for (const chunk of chunks) {
        sequence += 1;
        commits.push({ at: performance.now(), sequence, chars: chunk.text.length, tokens: estimateSpokenTokens(chunk.text), boundary: chunk.boundary });
        send({ type: "tts.text.append", turnId, replyId, sequence, commitSeq: sequence, text: chunk.text, boundary: chunk.boundary });
      }
    }
    if (done) break;
  }
  for (const chunk of planner.finish()) {
    sequence += 1;
    commits.push({ at: performance.now(), sequence, chars: chunk.text.length, tokens: estimateSpokenTokens(chunk.text), boundary: chunk.boundary });
    send({ type: "tts.text.append", turnId, replyId, sequence, commitSeq: sequence, text: chunk.text, boundary: chunk.boundary });
  }
}

const planner = new StreamingTextCommitter({ textLeadController: true, adaptive: true });
const turnId = `v3-trace-C3-real-qwen-${Date.now()}`;
const replyId = `${turnId}-reply`;
try {
  await waitFor(() => socket.readyState === WebSocket.OPEN);
  send({ type: "session.start", profileId, speed: 1, expressiveness: 0.7 });
  const ready = await waitFor(() => events.find(({ event }) => event.type === "session.ready"));
  send({ type: "tts.reply.start", turnId, replyId, profileId, speed: 1, expressiveness: 0.7 });
  await waitFor(() => events.some(({ event }) => event.type === "tts.reply.ready" && event.turnId === turnId));
  await streamChat();
  send({ type: "tts.input.finish", turnId, replyId, commitSeq: sequence });
  await waitFor(() => events.some(({ event }) => event.type === "tts.reply.completed" && event.turnId === turnId));
  const trace = timeline(turnId);
  const completed = trace.find((event) => event.type === "tts.reply.completed") || {};
  const pcm = binary.filter(({ decoded }) => decoded.generation === trace.find((event) => event.type === "tts.reply.ready")?.generation);
  const pcmGaps = pcm.slice(1).map((item, index) => Math.round(item.at - pcm[index].at)).sort((a, b) => a - b);
  const deltaGaps = chatDeltas.slice(1).map((item, index) => Math.round(item.at - chatDeltas[index].at)).sort((a, b) => a - b);
  const commitGaps = commits.slice(1).map((item, index) => Math.round(item.at - commits[index].at)).sort((a, b) => a - b);
  const artifact = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    profileId,
    protocolVersion: ready.event.protocolVersion || null,
    schedulerMode: ready.event.schedulerMode || null,
    path: "C3-real-qwen-chat-stream",
    promptChars: prompt.length,
    qwenDeltaCount: chatDeltas.length,
    qwenDeltaChars: chatDeltas.reduce((sum, item) => sum + item.chars, 0),
    qwenDeltaTokens: chatDeltas.reduce((sum, item) => sum + item.tokens, 0),
    qwenDeltaGapP95Ms: deltaGaps.length ? deltaGaps[Math.floor((deltaGaps.length - 1) * 0.95)] : 0,
    plannerCommitCount: commits.length,
    plannerCommitChars: commits.reduce((sum, item) => sum + item.chars, 0),
    plannerCommitTokens: commits.reduce((sum, item) => sum + item.tokens, 0),
    plannerCommitGapP95Ms: commitGaps.length ? commitGaps[Math.floor((commitGaps.length - 1) * 0.95)] : 0,
    plannerCommits: commits,
    modelTtsCallCount: Number(completed.modelTtsCallCount || 0),
    workerLockWaitMs: Number(trace.find((event) => event.type === "worker_lock_acquired")?.workerLockWaitMs || 0),
    inferenceIds: completed.inferenceIds || [],
    inferenceIdStable: completed.inferenceIdStable === true,
    textGeneratorYieldCount: Number(completed.textGeneratorYieldCount || 0),
    textGeneratorTokens: Number(completed.textGeneratorTokens || 0),
    textNormalizationBypassed: trace.some((event) => event.type === "tts.text_generator_yielded" && event.textNormalizationBypassed === true),
    hopHistory: completed.hopHistory || [],
    pcmChunkCount: pcm.length,
    pcmBurstGapP95Ms: pcmGaps.length ? pcmGaps[Math.floor((pcmGaps.length - 1) * 0.95)] : 0,
    cudaCleanupCount: Number(completed.cudaCleanupCount || 0),
    orphanWorkCount: Number(completed.orphanWorkCount || 0),
    completed: trace.some((event) => event.type === "tts.reply.completed"),
    errorCodes: trace.filter((event) => event.type === "error").map((event) => event.code || event.message),
    notes: ["C3 uses the real /api/assistant/chat-stream Qwen answer path and the same StreamingTextCommitter thresholds as Assistant.jsx.", "PCM gaps are IPC arrival gaps; actual AudioWorklet playhead telemetry remains a separate gate."]
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
} finally {
  socket.close();
}
