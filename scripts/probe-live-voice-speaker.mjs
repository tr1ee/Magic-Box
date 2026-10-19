import { WebSocket } from "ws";
import { decodeAudioFrame } from "../server/live_voice.mjs";

const baseUrl = process.argv[2] || process.env.MAGIC_BOX_URL;
const profileId = process.argv[3] || process.env.MAGIC_BOX_VOICE_PROFILE_ID;
const text = process.argv[4] || "这是一个用于验证持续语音说话人身份的长句子。我们需要保持自然、稳定并清晰地完成整段回答。";
const outputPath = process.argv[5] || "";
const expressiveness = Number(process.env.VOICE_PROBE_EXPRESSIVENESS || 0.7);
if (!baseUrl || !profileId) throw new Error("Usage: node scripts/probe-live-voice-speaker.mjs <url> <profileId> [text]");
const socketUrl = new URL("/api/assistant/live-voice", baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(socketUrl);
socket.binaryType = "arraybuffer";
const events = [];
const frames = [];
socket.on("message", (data, isBinary) => {
  if (isBinary) frames.push(decodeAudioFrame(data));
  else events.push(JSON.parse(String(data)));
});
const waitFor = async (fn, timeout = 180000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for live voice probe.");
};
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
socket.send(JSON.stringify({ type: "session.start", profileId, protocolVersion: 5, speed: 1, expressiveness }));
const ready = await waitFor(() => events.find((event) => event.type === "session.ready"));
if (Number(ready.protocolVersion) < 5) throw new Error(`Protocol ${ready.protocolVersion} was not negotiated.`);
const turnId = `speaker-probe-${Date.now()}`;
const replyId = `${turnId}-reply`;
socket.send(JSON.stringify({ type: "tts.reply.start", turnId, replyId, profileId, speed: 1, expressiveness }));
socket.send(JSON.stringify({ type: "tts.text.append", turnId, replyId, segmentId: `${replyId}:1`, sequence: 1, commitSeq: 1, text, boundary: "strong" }));
await waitFor(() => events.find((event) => event.type === "tts.text.accepted" && event.turnId === turnId));
socket.send(JSON.stringify({ type: "tts.input.finish", turnId, replyId, commitSeq: 1 }));
await waitFor(() => events.find((event) => event.type === "tts.reply.completed" && event.turnId === turnId));
const payload = Buffer.concat(frames.map((frame) => frame.pcm));
if (outputPath) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + payload.length, 4);
  header.write("WAVEfmt ", 8, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36, "ascii"); header.writeUInt32LE(payload.length, 40);
  const fs = await import("node:fs/promises");
  await fs.writeFile(outputPath, Buffer.concat([header, payload]));
}
const benchmarkAt = events.length;
function trimSilence(pcm) {
  const windowSamples = Math.max(1, Math.floor(24000 * 0.02));
  let first = 0;
  let last = Math.floor(pcm.length / 2);
  const energy = (start, end) => {
    let sum = 0;
    for (let index = start; index < end; index += 1) {
      const value = pcm.readInt16LE(index * 2);
      sum += value * value;
    }
    return Math.sqrt(sum / Math.max(1, end - start));
  };
  while (first + windowSamples < last && energy(first, first + windowSamples) < 220) first += windowSamples;
  while (last - windowSamples > first && energy(last - windowSamples, last) < 220) last -= windowSamples;
  return pcm.subarray(first * 2, last * 2);
}
const benchmarkPcm = trimSilence(payload);
socket.send(JSON.stringify({ type: "benchmark.speaker", referenceText: text, pcm: benchmarkPcm.toString("base64") }));
const similarity = await waitFor(() => events.slice(benchmarkAt).find((event) => event.type === "benchmark.speaker"));
function resample24kTo16k(pcm) {
  const source = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const outputSamples = Math.floor(source.length * 2 / 3);
  const output = Buffer.alloc(outputSamples * 2);
  const ratio = 1.5;
  const cutoff = 1 / 3;
  const halfTaps = 8;
  const sinc = (value) => Math.abs(value) < 1e-8 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value);
  for (let index = 0; index < outputSamples; index += 1) {
    const position = index * ratio;
    const center = Math.floor(position);
    let sum = 0;
    let weightSum = 0;
    for (let tap = center - halfTaps + 1; tap <= center + halfTaps; tap += 1) {
      const sampleIndex = Math.max(0, Math.min(source.length - 1, tap));
      const distance = tap - position;
      const window = 0.54 + 0.46 * Math.cos(Math.PI * distance / halfTaps);
      const weight = 2 * cutoff * sinc(2 * cutoff * distance) * window;
      sum += source[sampleIndex] * weight;
      weightSum += weight;
    }
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / Math.max(1e-8, weightSum)))), index * 2);
  }
  return output;
}
const asrTurnId = `speaker-probe-asr-${Date.now()}`;
const asrStart = events.length;
socket.send(JSON.stringify({ type: "input.start", turnId: asrTurnId }));
const asrPcm = Buffer.concat([resample24kTo16k(payload), Buffer.alloc(6400)]);
for (let offset = 0; offset < asrPcm.length; offset += 32000) socket.send(asrPcm.subarray(offset, Math.min(asrPcm.length, offset + 32000)));
socket.send(JSON.stringify({ type: "input.stop", turnId: asrTurnId }));
const transcript = await waitFor(() => events.slice(asrStart).find((event) => event.type === "transcript.final" && event.turnId === asrTurnId), 120000);
console.log(JSON.stringify({ frameCount: frames.length, bytes: payload.length, trimmedBytes: benchmarkPcm.length, similarity, highQualityAsr: transcript.text || "" }, null, 2));
socket.close(1000, "speaker probe complete");
