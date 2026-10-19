import { WebSocket } from "ws";
import { splitSpeechSegments } from "../shared/speech-planner.mjs";

const baseUrl = process.argv[2] || process.env.MAGIC_BOX_URL;
const profileId = process.argv[3] || process.env.MAGIC_BOX_VOICE_PROFILE_ID;
if (!baseUrl || !profileId) {
  console.error("Usage: node scripts/trace-live-voice-field.mjs <http://127.0.0.1:port> <profile-id>");
  process.exit(2);
}
const socketUrl = new URL("/api/assistant/live-voice", baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
const events = [];
const binary = [];
const socket = new WebSocket(socketUrl);
socket.binaryType = "arraybuffer";
socket.on("message", (data, isBinary) => {
  if (isBinary) binary.push({ at: performance.now(), bytes: Buffer.byteLength(data) });
  else {
    try { events.push({ at: performance.now(), event: JSON.parse(String(data)) }); } catch {}
  }
});
const send = (message) => socket.send(JSON.stringify(message));
async function waitFor(predicate, timeoutMs = 600000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Field trace timed out.");
}
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
send({ type: "session.start", profileId, speed: 1, expressiveness: 0.7, protocolVersion: 5 });
const ready = await waitFor(() => events.find(({ event }) => event.type === "session.ready"));
const persistent = Number(ready.event.protocolVersion) >= 5;
const texts = [
  "这是一条真实发布包语音 trace，用来定位连续语音链路中的首个可听断点。",
  "如果下一批 PCM 在上一批播放结束前没有到达，trace 会保留 planner、worker 和传输时间线。",
  "这条回复只用于现场观测，不把没有 Worklet 播放数据的结果标记为连续性通过。"
];
for (const [index, text] of texts.entries()) {
  const turnId = `field-trace-${Date.now()}-${index}`;
  const replyId = `${turnId}-reply`;
  const eventStart = events.length;
  const binaryStart = binary.length;
  const segments = splitSpeechSegments(text, { final: true });
  send({ type: "tts.reply.start", turnId, replyId, profileId, speed: 1, expressiveness: 0.7 });
  await waitFor(() => events.slice(eventStart).find(({ event }) => event.type === "tts.reply.ready" && event.turnId === turnId));
  for (let sequence = 0; sequence < segments.length; sequence += 1) {
    const segment = segments[sequence];
    if (persistent) {
      send({ type: "tts.text.append", turnId, replyId, segmentId: `${replyId}:${sequence + 1}`, sequence: sequence + 1, commitSeq: sequence + 1, text: segment.text, boundary: segment.boundary });
      await waitFor(() => events.slice(eventStart).find(({ event }) => ["tts.text.accepted", "tts.segment.completed"].includes(event.type) && event.turnId === turnId && Number(event.commitSeq || event.sequence) === sequence + 1));
    } else send({ type: "tts.segment", turnId, replyId, segmentId: `${replyId}:${sequence + 1}`, sequence: sequence + 1, text: segment.text, boundary: segment.boundary });
  }
  send(persistent ? { type: "tts.input.finish", turnId, replyId, commitSeq: segments.length } : { type: "tts.reply.commit", turnId, replyId, segmentCount: segments.length });
  await waitFor(() => events.slice(eventStart).find(({ event }) => event.type === "tts.reply.completed" && event.turnId === turnId));
  console.log(JSON.stringify({ replyId, segments: segments.length, events: events.length - eventStart, pcmFrames: binary.length - binaryStart }));
}
socket.close();
