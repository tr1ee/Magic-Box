import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { WebSocket } from "ws";
import { decodeAudioFrame, estimateSpokenTokens } from "../server/live_voice.mjs";

const baseUrl = process.argv[2] || process.env.MAGIC_BOX_URL;
const profileId = process.argv[3] || process.env.MAGIC_BOX_VOICE_PROFILE_ID;
const outputPath = path.resolve(process.argv[4] || "artifacts/voice-v3/trace-c0-c3.json");
if (!baseUrl || !profileId) {
  console.error("Usage: node scripts/benchmark-voice-v3-trace.mjs <http://127.0.0.1:port> <profile-id> [output.json]");
  process.exit(2);
}

const fixedText = "这是一次固定的中文连续语音测试，用来观察同一个回答是否只创建一次 CosyVoice 推理，以及文本追加、文本生成器、音频输出和播放前 PCM 之间是否保持稳定的因果顺序。我们会继续说完这一整段内容，并记录每个阶段的调用次数、文本 token 数量、队列深度和音频间隔。";
const events = [];
const binary = [];
const socketUrl = new URL("/api/assistant/live-voice", baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(socketUrl);
socket.binaryType = "arraybuffer";
socket.on("message", (data, isBinary) => {
  if (isBinary) binary.push({ at: performance.now(), decoded: decodeAudioFrame(data) });
  else events.push({ at: performance.now(), event: JSON.parse(String(data)) });
});

function send(message) { socket.send(JSON.stringify(message)); }
async function waitFor(predicate, timeoutMs = 600000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("V3 trace benchmark timed out.");
}

function eventsFor(turnId) {
  return events.filter(({ event }) => event.turnId === turnId).map(({ at, event }) => ({ at, ...event }));
}

function summarize(turnId, caseName, appendTexts) {
  const timeline = eventsFor(turnId);
  const modelCalls = timeline.filter((event) => event.type === "tts.model_call_started");
  const generatorYields = timeline.filter((event) => event.type === "tts.text_generator_yielded");
  const pcm = binary.filter(({ decoded }) => decoded.generation === timeline.find((event) => event.type === "tts.reply.ready")?.generation);
  const pcmGaps = [];
  for (let index = 1; index < pcm.length; index += 1) pcmGaps.push(Math.round(pcm[index].at - pcm[index - 1].at));
  const completed = timeline.find((event) => event.type === "tts.reply.completed") || {};
  return {
    case: caseName,
    turnId,
    inputAppendCount: appendTexts.length,
    inputChars: appendTexts.reduce((sum, text) => sum + text.length, 0),
    inputTokens: appendTexts.reduce((sum, text) => sum + estimateSpokenTokens(text), 0),
    modelTtsCallCount: Number(completed.modelTtsCallCount || modelCalls.at(-1)?.modelTtsCallCount || 0),
    inferenceIds: completed.inferenceIds || [...new Set(modelCalls.map((event) => event.inferenceInstanceId).filter(Boolean))],
    inferenceIdStable: completed.inferenceIdStable === true,
    promptExtractionCount: Number(completed.promptExtractionCount || modelCalls.at(-1)?.promptExtractionCount || 0),
    textGeneratorYieldCount: Number(completed.textGeneratorYieldCount || generatorYields.length || 0),
    textGeneratorTokens: Number(completed.textGeneratorTokens || generatorYields.reduce((sum, event) => sum + Number(event.textTokens || 0), 0)),
    textNormalizationBypassed: generatorYields.some((event) => event.textNormalizationBypassed === true),
    normalizerStages: [...new Set(generatorYields.map((event) => event.normalizerStage).filter(Boolean))],
    hopHistory: completed.hopHistory || [],
    capabilityProbe: completed.capabilityProbe || timeline.find((event) => event.type === "runtime.health")?.capabilities || null,
    pcmChunkCount: pcm.length,
    pcmBurstGapP95Ms: pcmGaps.length ? pcmGaps.sort((left, right) => left - right)[Math.floor((pcmGaps.length - 1) * 0.95)] : 0,
    completed: timeline.some((event) => event.type === "tts.reply.completed"),
    errorCodes: timeline.filter((event) => event.type === "error").map((event) => event.code || event.message)
  };
}

async function runCase(caseName, appendTexts) {
  const turnId = `v3-trace-${caseName}-${Date.now()}`;
  const replyId = `${turnId}-reply`;
  const startAt = events.length;
  send({ type: "tts.reply.start", turnId, replyId, profileId, speed: 1, expressiveness: 0.7 });
  await waitFor(() => events.slice(startAt).some(({ event }) => event.type === "tts.reply.ready" && event.turnId === turnId));
  for (let index = 0; index < appendTexts.length; index += 1) {
    const sequence = index + 1;
    send({ type: "tts.text.append", turnId, replyId, sequence, commitSeq: sequence, text: appendTexts[index], boundary: index === appendTexts.length - 1 ? "final" : "strong" });
    await waitFor(() => events.slice(startAt).some(({ event }) => event.type === "tts.text.accepted" && event.turnId === turnId && Number(event.commitSeq || event.sequence) === sequence));
  }
  send({ type: "tts.input.finish", turnId, replyId, commitSeq: appendTexts.length });
  await waitFor(() => events.slice(startAt).some(({ event }) => event.type === "tts.reply.completed" && event.turnId === turnId));
  return summarize(turnId, caseName, appendTexts);
}

try {
  await waitFor(() => socket.readyState === WebSocket.OPEN);
  send({ type: "session.start", profileId, speed: 1, expressiveness: 0.7 });
  const ready = await waitFor(() => events.find(({ event }) => event.type === "session.ready"));
  const midpoint = Math.floor(fixedText.length / 3);
  const c1 = await runCase("C1-full-text-single-append", [fixedText]);
  const c2 = await runCase("C2-prepared-three-appends", [fixedText.slice(0, midpoint), fixedText.slice(midpoint, midpoint * 2), fixedText.slice(midpoint * 2)]);
  const artifact = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    profileId,
    protocolVersion: ready.event.protocolVersion || null,
    schedulerMode: ready.event.schedulerMode || null,
    fixedTextChars: fixedText.length,
    fixedTextTokens: estimateSpokenTokens(fixedText),
    paths: {
      C0: { status: "not_exercised", reason: "The live WebSocket path does not expose a separate non-streaming audio endpoint." },
      C1: c1,
      C2: c2,
      C3: { status: "not_exercised", reason: "The standalone benchmark does not own the Qwen token generator; use the Assistant UI trace for this path." }
    },
    notes: [
      "PCM burst gaps are IPC arrival gaps; this script does not replace actual AudioWorklet playhead/starvation telemetry.",
      "No prompt, reference set, model revision, style strength, or buffer target is changed by this benchmark."
    ]
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
} finally {
  socket.close();
}
