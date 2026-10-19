import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import process from "node:process";
import { WebSocket } from "ws";

const baseUrl = process.argv[2];
const profileId = process.argv[3];
const wavPath = process.argv[4];
const outputWavPath = process.argv[5] || "";
const replyText = process.argv[6] || "The system is ready for a new conversation.";
const replySegments = replyText.split("||").map((value) => value.trim()).filter(Boolean);
if (!baseUrl || !profileId || !wavPath) {
  console.error("Usage: node scripts/smoke-live-voice-roundtrip.mjs <http://127.0.0.1:port> <profile-id> <16k-mono.wav>");
  process.exit(2);
}

function pcmFromWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("Expected a RIFF/WAVE microphone fixture.");
  let offset = 12;
  let format = null;
  let pcm = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") format = { codec: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4), bits: buffer.readUInt16LE(start + 14) };
    if (id === "data") pcm = buffer.subarray(start, Math.min(buffer.length, start + size));
    offset = start + size + (size % 2);
  }
  if (!format || format.codec !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bits !== 16 || !pcm) throw new Error("The microphone fixture must be 16 kHz mono PCM16 WAV.");
  return pcm;
}

function resample24kTo16k(pcm) {
  const inputSamples = Math.floor(pcm.length / 2);
  const outputSamples = Math.floor(inputSamples * 2 / 3);
  const output = Buffer.alloc(outputSamples * 2);
  for (let index = 0; index < outputSamples; index += 1) {
    const position = index * 1.5;
    const leftIndex = Math.min(inputSamples - 1, Math.floor(position));
    const rightIndex = Math.min(inputSamples - 1, leftIndex + 1);
    const mix = position - leftIndex;
    const sample = Math.round(pcm.readInt16LE(leftIndex * 2) * (1 - mix) + pcm.readInt16LE(rightIndex * 2) * mix);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index * 2);
  }
  return output;
}

function wavFromPcm(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const events = [];
const audioFrames = [];
const socketUrl = new URL("/api/assistant/live-voice", baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(socketUrl);
socket.binaryType = "arraybuffer";
socket.on("message", (data, isBinary) => {
  if (isBinary) audioFrames.push(Buffer.from(data));
  else events.push(JSON.parse(String(data)));
});
const send = (message) => socket.send(JSON.stringify(message));
const waitFor = async (predicate, timeoutMs = 120000) => {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the live voice round trip.");
};

await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
send({ type: "session.start", profileId, speed: 1, expressiveness: 0.7 });
await waitFor(() => events.find((event) => event.type === "session.ready"));

const inputTurnId = `smoke-input-${Date.now()}`;
send({ type: "input.start", turnId: inputTurnId });
const pcm = pcmFromWav(await fs.readFile(wavPath));
const frameBytes = 640;
const inputStartedAt = performance.now();
for (let offset = 0; offset < pcm.length; offset += frameBytes) {
  socket.send(pcm.subarray(offset, Math.min(pcm.length, offset + frameBytes)));
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (events.some((event) => event.type === "input.ended" && event.turnId === inputTurnId)) break;
}
for (let index = 0; index < 40 && !events.some((event) => event.type === "input.ended" && event.turnId === inputTurnId); index += 1) {
  socket.send(Buffer.alloc(frameBytes));
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const inputEnded = await waitFor(() => events.find((event) => event.type === "input.ended" && event.turnId === inputTurnId));
const transcript = await waitFor(() => events.find((event) => event.type === "transcript.final" && event.turnId === inputTurnId));
const inputRoundTripMs = Math.round(performance.now() - inputStartedAt);
if (!String(transcript.text || "").trim()) throw new Error("ASR returned an empty transcript for the known speech fixture.");

const ttsTurnId = `smoke-tts-${Date.now()}`;
const audioStart = audioFrames.length;
send({ type: "tts.start", turnId: ttsTurnId });
send({ type: "text.append", turnId: ttsTurnId, text: replySegments[0] || replyText });
for (const segment of replySegments.slice(1)) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  send({ type: "text.append", turnId: ttsTurnId, text: segment });
}
let firstAudioBeforeCommit = false;
try {
  await waitFor(() => audioFrames.length > audioStart, 5000);
  firstAudioBeforeCommit = true;
} catch {
  // Some very short replies may not reach CosyVoice's first token threshold
  // until commit; the completion check below still validates their audio.
}
send({ type: "text.commit", turnId: ttsTurnId });
await waitFor(() => audioFrames.length > audioStart, 180000);
await waitFor(() => events.find((event) => event.type === "tts.completed" && event.turnId === ttsTurnId), 180000);

const generatedPcm24k = Buffer.concat(audioFrames.slice(audioStart).map((frame) => frame.subarray(8)));
if (outputWavPath) await fs.writeFile(outputWavPath, wavFromPcm(generatedPcm24k));
const generatedPcm16k = resample24kTo16k(generatedPcm24k);
const leakCheckTurnId = `smoke-leak-check-${Date.now()}`;
send({ type: "input.start", turnId: leakCheckTurnId });
for (let offset = 0; offset < generatedPcm16k.length; offset += frameBytes) {
  socket.send(generatedPcm16k.subarray(offset, Math.min(generatedPcm16k.length, offset + frameBytes)));
  await new Promise((resolve) => setTimeout(resolve, 20));
}
for (let index = 0; index < 40 && !events.some((event) => event.type === "input.ended" && event.turnId === leakCheckTurnId); index += 1) {
  socket.send(Buffer.alloc(frameBytes));
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const leakTranscript = await waitFor(() => events.find((event) => event.type === "transcript.final" && event.turnId === leakCheckTurnId), 120000);
if (/(?:努力做一个)?快乐生活的学生/u.test(String(leakTranscript.text || ""))) throw new Error(`Cloned reply leaked its reference transcript: ${leakTranscript.text}`);

const result = {
  pass: true,
  profileId,
  endpointReason: inputEnded.reason,
  transcript: transcript.text,
  detectedLanguage: transcript.language,
  asrModel: transcript.asrModel,
  inputRoundTripMs,
  ttsAudioFrames: audioFrames.length - audioStart,
  streamedTextSegments: replySegments.length,
  firstAudioBeforeCommit,
  generatedReplyTranscript: leakTranscript.text,
  generatedAudioSha256: createHash("sha256").update(generatedPcm24k).digest("hex"),
  generatedAudioPath: outputWavPath || undefined,
  referenceTranscriptLeak: false
};
console.log(JSON.stringify(result, null, 2));
socket.close(1000, "Round trip complete");
