import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { WebSocket } from "ws";
import { decodeAudioFrame } from "../server/live_voice.mjs";
import { coalesceSpeechSegments, StreamingSpeechPlanner, splitSpeechSegments } from "../shared/speech-planner.mjs";

const baseUrl = process.argv[2] || process.env.MAGIC_BOX_URL;
const profileId = process.argv[3] || process.env.MAGIC_BOX_VOICE_PROFILE_ID;
const outputPath = path.resolve(process.argv[4] || process.env.MAGIC_BOX_LIVE_VOICE_BENCHMARK || "artifacts/live-voice-benchmark.json");
if (!baseUrl || !profileId) {
  console.error("Usage: node scripts/benchmark-live-voice.mjs <http://127.0.0.1:port> <profile-id> [output.json]");
  process.exit(2);
}

const events = [];
const binary = [];
let negotiatedProtocolVersion = 4;
let persistentSession = false;
const socketUrl = new URL("/api/assistant/live-voice", baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(socketUrl);
socket.binaryType = "arraybuffer";
socket.on("message", (data, isBinary) => {
  if (isBinary) binary.push({ at: performance.now(), data: Buffer.from(data), decoded: decodeAudioFrame(data) });
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
  throw new Error("Benchmark timed out waiting for a live voice event.");
}

const percentile = (values, ratio) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] || 0;
};

function simulateBrowserPlayback(frames) {
  if (!frames.length) return { starvationDurationMs: 0, maxStarvationMs: 0, playbackStartMs: 0 };
  let bufferedMs = 0;
  let targetMs = 1000;
  let playing = false;
  let starvedAt = 0;
  let totalStarvation = 0;
  let maxStarvation = 0;
  let playbackStart = 0;
  let previousAt = frames[0].at;
  for (const frame of frames) {
    const elapsed = frame.at - previousAt;
    previousAt = frame.at;
    if (playing) {
      bufferedMs -= elapsed;
      if (bufferedMs <= 0) {
        starvedAt = frame.at + bufferedMs;
        playing = false;
        bufferedMs = 0;
        targetMs = Math.min(2400, Math.max(1000, targetMs + 300));
      }
    }
    bufferedMs += frame.decoded.pcm.length / 2 / 24;
    if (!playing && bufferedMs >= targetMs) {
      playing = true;
      if (!playbackStart) playbackStart = frame.at;
      if (starvedAt) {
        const duration = Math.max(0, frame.at - starvedAt);
        totalStarvation += duration;
        maxStarvation = Math.max(maxStarvation, duration);
        starvedAt = 0;
      }
    }
  }
  return {
    starvationDurationMs: Math.round(totalStarvation),
    maxStarvationMs: Math.round(maxStarvation),
    playbackStartMs: playbackStart
  };
}

function waveformMetrics(results) {
  let clipped = 0;
  let samples = 0;
  let maxJoinDiscontinuity = 0;
  for (const { result } of results) {
    const grouped = [];
    for (const frame of result.frames) {
      const sequence = frame.decoded.segmentSequence;
      let group = grouped.at(-1);
      if (!group || group.sequence !== sequence) {
        group = { sequence, chunks: [] };
        grouped.push(group);
      }
      group.chunks.push(frame.decoded.pcm);
      const pcm = new Int16Array(frame.decoded.pcm.buffer, frame.decoded.pcm.byteOffset, frame.decoded.pcm.byteLength / 2);
      for (const value of pcm) {
        samples += 1;
        if (Math.abs(value) >= 32760) clipped += 1;
      }
    }
    for (let index = 1; index < grouped.length; index += 1) {
      const leftBuffer = Buffer.concat(grouped[index - 1].chunks);
      const rightBuffer = Buffer.concat(grouped[index].chunks);
      const left = new Int16Array(leftBuffer.buffer, leftBuffer.byteOffset, leftBuffer.byteLength / 2);
      const right = new Int16Array(rightBuffer.buffer, rightBuffer.byteOffset, rightBuffer.byteLength / 2);
      const count = Math.min(600, left.length, right.length);
      if (!count) continue;
      let previous = left[Math.max(0, left.length - count - 1)] / 32768;
      for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
        const phase = (sampleIndex + 1) / (count + 1) * Math.PI / 2;
        const joined = (left[left.length - count + sampleIndex] * Math.cos(phase) + right[sampleIndex] * Math.sin(phase)) / 32768;
        maxJoinDiscontinuity = Math.max(maxJoinDiscontinuity, Math.abs(joined - previous));
        previous = joined;
      }
    }
  }
  return { clippingRatio: clipped / Math.max(1, samples), maxJoinDiscontinuityFullScale: maxJoinDiscontinuity };
}

let turnCounter = 0;
async function runTurn(text, label = "case") {
  const turnId = `benchmark-${label}-${++turnCounter}-${Date.now()}`;
  const replyId = `${turnId}-reply`;
  const frameStart = binary.length;
  const eventStart = events.length;
  const segments = coalesceSpeechSegments(splitSpeechSegments(text, { final: true }));
  send({ type: "tts.reply.start", turnId, replyId, profileId, speed: 1, expressiveness: 0.7 });
  const committedAt = performance.now();
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (persistentSession) {
      const sequence = index + 1;
      send({ type: "tts.text.append", turnId, replyId, segmentId: `${replyId}:${sequence}`, sequence, commitSeq: sequence, text: segment.text, boundary: segment.boundary });
      await waitFor(() => {
        const turnEvents = events.slice(eventStart).map(({ event }) => event).filter((event) => event.turnId === turnId);
        const failure = turnEvents.find((event) => event.type === "error");
        if (failure) throw new Error(`Persistent TTS append failed at commit ${sequence}: ${failure.code || failure.message}`);
        return turnEvents.find((event) => event.type === "tts.text.accepted" && Number(event.commitSeq || event.sequence) === sequence);
      });
      continue;
    }
    while (index - events.slice(eventStart).filter(({ event }) => (persistentSession ? event.type === "tts.text.accepted" : event.type === "tts.segment.completed") && event.turnId === turnId).length >= (persistentSession ? 8 : 3)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    send({ type: "tts.segment", turnId, replyId, segmentId: `${replyId}:${index + 1}`, sequence: index + 1, text: segment.text, boundary: segment.boundary });
  }
  send(persistentSession ? { type: "tts.input.finish", turnId, replyId, commitSeq: segments.length } : { type: "tts.reply.commit", turnId, replyId, segmentCount: segments.length });
  const firstFrame = await waitFor(() => binary[frameStart]);
  await waitFor(() => events.slice(eventStart).find(({ event }) => event.type === "tts.reply.completed" && event.turnId === turnId));
  const frames = binary.slice(frameStart).filter((frame) => frame.decoded.generation === firstFrame.decoded.generation);
  const segmentEvents = events.slice(eventStart).map(({ event }) => event).filter((event) => event.turnId === turnId && (persistentSession ? event.type === "tts.text.accepted" : event.type === "tts.segment.completed"));
  return {
    turnId,
    committedAt,
    firstAudioMs: firstFrame.at - committedAt,
    frames,
    pcm: Buffer.concat(frames.map((frame) => frame.decoded.pcm)),
    segmentEvents,
    playback: simulateBrowserPlayback(frames)
  };
}

function resample24kTo16k(pcm) {
  const source = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const output = Buffer.alloc(Math.floor(source.length * 2 / 3) * 2);
  for (let index = 0; index < output.length / 2; index += 1) {
    const position = index * 1.5;
    const left = Math.floor(position);
    const right = Math.min(source.length - 1, left + 1);
    const value = Math.round(source[left] + (source[right] - source[left]) * (position - left));
    output.writeInt16LE(value, index * 2);
  }
  return output;
}

function normalizedUnits(text, kind) {
  const normalized = String(text || "").toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, kind === "word" ? " " : "").trim();
  return kind === "word" ? normalized.split(/\s+/u).filter(Boolean) : [...normalized];
}

function errorRate(expected, actual, kind) {
  const left = normalizedUnits(expected, kind);
  const right = normalizedUnits(actual, kind);
  const row = Array.from({ length: right.length + 1 }, (_item, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[right.length] / Math.max(1, left.length);
}

async function loopbackTranscript(result, label) {
  const turnId = `benchmark-asr-${label}-${Date.now()}`;
  const eventStart = events.length;
  send({ type: "input.start", turnId });
  // Give the local VAD an explicit 200 ms release tail, matching the browser
  // capture path instead of stopping on the last non-zero PCM packet.
  const pcm16 = Buffer.concat([resample24kTo16k(result.pcm), Buffer.alloc(16_000 * 2 / 5)]);
  for (let offset = 0; offset < pcm16.length; offset += 32000) socket.send(pcm16.subarray(offset, Math.min(pcm16.length, offset + 32000)));
  const stoppedAt = performance.now();
  send({ type: "input.stop", turnId });
  const transcript = await waitFor(() => events.slice(eventStart).find(({ event }) => event.type === "transcript.final" && event.turnId === turnId));
  return { text: transcript.event.text || "", finalizationMs: transcript.at - stoppedAt };
}

async function readNdjson(response, onEvent) {
  if (!response.ok || !response.body) throw new Error(`Combined chat benchmark failed with HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) await onEvent(JSON.parse(line));
    }
    if (done) break;
  }
}

async function runCombinedChatTurn() {
  const turnId = `benchmark-combined-${Date.now()}`;
  const replyId = `${turnId}-reply`;
  const planner = new StreamingSpeechPlanner();
  const frameStart = binary.length;
  const eventStart = events.length;
  let sequence = 0;
  let firstDeltaAt = 0;
  send({ type: "tts.reply.start", turnId, replyId, profileId, speed: 1, expressiveness: 0.7 });
  const submitSegments = async (segments) => {
    for (const segment of segments) {
      if (persistentSession) {
        sequence += 1;
        send({ type: "tts.text.append", turnId, replyId, segmentId: `${replyId}:${sequence}`, sequence, commitSeq: sequence, text: segment.text, boundary: segment.boundary });
        await waitFor(() => {
          const turnEvents = events.slice(eventStart).map(({ event }) => event).filter((event) => event.turnId === turnId);
          const failure = turnEvents.find((event) => event.type === "error");
          if (failure) throw new Error(`Persistent chat TTS append failed at commit ${sequence}: ${failure.code || failure.message}`);
          return turnEvents.find((event) => event.type === "tts.text.accepted" && Number(event.commitSeq || event.sequence) === sequence);
        });
        continue;
      }
      while (sequence - events.slice(eventStart).filter(({ event }) => (persistentSession ? event.type === "tts.text.accepted" : event.type === "tts.segment.completed") && event.turnId === turnId).length >= (persistentSession ? 8 : 3)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      sequence += 1;
      send({ type: "tts.segment", turnId, replyId, segmentId: `${replyId}:${sequence}`, sequence, text: segment.text, boundary: segment.boundary });
    }
  };
  const response = await fetch(new URL("/api/assistant/chat-stream", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      message: "Give a concise spoken overview of improving focus in Chinese and English. Use two short sentences and one compact Markdown list; keep the answer under 120 words.",
      onlineSearch: "off",
      resourceProfile: "voice"
    })
  });
  await readNdjson(response, async (event) => {
    if (event.type === "answer.delta") {
      if (!firstDeltaAt) firstDeltaAt = performance.now();
      const sentenceDelay = /[.!?\u3002\uff01\uff1f]\s*$/u.test(event.delta) ? 200 + Math.floor(Math.random() * 501) : 0;
      await new Promise((resolve) => setTimeout(resolve, sentenceDelay + 20 + Math.floor(Math.random() * 61)));
      await submitSegments(planner.append(event.delta));
    } else if (event.type === "answer.reset") {
      throw new Error("Combined benchmark answer reset; rerun with a stable local model response.");
    } else if (event.type === "error") throw new Error(event.message || "Combined local chat failed.");
  });
  await submitSegments(planner.finish());
  send(persistentSession ? { type: "tts.input.finish", turnId, replyId, commitSeq: sequence } : { type: "tts.reply.commit", turnId, replyId, segmentCount: sequence });
  const firstFrame = await waitFor(() => binary[frameStart]);
  await waitFor(() => events.slice(eventStart).find(({ event }) => event.type === "tts.reply.completed" && event.turnId === turnId));
  const frames = binary.slice(frameStart).filter((frame) => frame.decoded.generation === firstFrame.decoded.generation);
  const playback = simulateBrowserPlayback(frames);
  return { frames, playbackFromFirstDeltaMs: playback.playbackStartMs ? playback.playbackStartMs - firstDeltaAt : Number.POSITIVE_INFINITY, playback };
}

async function sampleVoiceVram() {
  const response = await fetch(new URL("/api/assistant/live-voice/health?warm=1", baseUrl));
  if (!response.ok) throw new Error(`VRAM sampling failed with HTTP ${response.status}.`);
  const health = await response.json();
  return Number(health.runtime?.peakVramMB) || 0;
}

await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
send({ type: "session.start", profileId, speed: 1, expressiveness: 0.7, protocolVersion: process.env.VOICE_BENCHMARK_PROTOCOL === "5" ? 5 : 4 });
const sessionReady = await waitFor(() => events.find(({ event }) => event.type === "session.ready"));
negotiatedProtocolVersion = Number(sessionReady.event.protocolVersion) || 4;
persistentSession = negotiatedProtocolVersion >= 5;

const englishText = "The local voice should begin quickly, stay coherent, and finish every useful clause.";
const chineseText = "本地语音应该快速开始，连贯地说完每个有用的句子，并保持稳定的说话人身份。";
const longCaseRepeats = Math.max(8, Math.min(45, Number(process.env.VOICE_BENCHMARK_LONG_REPEATS || 12) || 12));
const directCases = [
  ["short-en", englishText],
  ["short-zh", chineseText],
  ["mixed", "本地处理 keeps the selected speaker stable, even when 中文和 English 出现在同一个回答里。"],
  ["markdown", "## Result\n- Read [the local guide](https://example.com).\n- `resourceProfile` stays on the CPU.\n```js\nconsole.log('screen only');\n```"],
  ["punctuation-free", "this deliberately long answer has no punctuation and must still be divided into bounded natural utterances without waiting for the complete paragraph to finish"],
  ["zh-long", "这是一次较长的连续语音压力测试。".repeat(longCaseRepeats)]
];
const directResults = [];
const vramSamplesMB = [];
for (const [label, text] of directCases) {
  console.error(`[benchmark] direct case ${label}`);
  directResults.push({ label, text, result: await runTurn(text, label) });
  vramSamplesMB.push(await sampleVoiceVram());
}
for (let index = 0; index < 4; index += 1) {
  console.error(`[benchmark] repeat case ${index + 1}/4`);
  directResults.push({ label: `repeat-${index}`, text: englishText, result: await runTurn(englishText, `repeat-${index}`) });
  vramSamplesMB.push(await sampleVoiceVram());
}

const englishLoopback = await loopbackTranscript(directResults[0].result, "english");
const chineseLoopback = await loopbackTranscript(directResults[1].result, "chinese");
console.error("[benchmark] combined chat");
const combined = await runCombinedChatTurn();

const cancellationLatencies = [];
const cancellationQuiescence = [];
for (let index = 0; index < 20; index += 1) {
  if (index === 0 || index === 10) console.error(`[benchmark] cancellation cycles ${index}/20`);
  const turnId = `benchmark-cancel-${index}-${Date.now()}`;
  const replyId = `${turnId}-reply`;
  const eventStart = events.length;
  send({ type: "tts.reply.start", turnId, replyId });
  send(persistentSession
    ? { type: "tts.text.append", turnId, replyId, segmentId: `${replyId}:1`, sequence: 1, commitSeq: 1, text: "This interrupted local turn must stop cleanly.", boundary: "strong" }
    : { type: "tts.segment", turnId, replyId, segmentId: `${replyId}:1`, sequence: 1, text: "This interrupted local turn must stop cleanly.", boundary: "strong" });
  const cancelAt = performance.now();
  send({ type: "turn.cancel", turnId });
  const acknowledged = await waitFor(() => events.slice(eventStart).find(({ event }) => event.type === "turn.cancelled" && event.turnId === turnId));
  const quiesced = await waitFor(() => events.slice(eventStart).find(({ event }) => ["tts.cancel.quiesced", "runtime.restart.required"].includes(event.type) && event.turnId === turnId));
  cancellationLatencies.push(acknowledged.at - cancelAt);
  cancellationQuiescence.push(Number(quiesced.event.cancellationQuiescenceMs) || (quiesced.at - cancelAt));
}

// Speaker embeddings are unstable on a single short sentence. Use the same
// pinned profile and generated voice across the direct cases, capped at 20 s,
// so the similarity gate measures voice identity rather than clip length.
const combinedPcm = Buffer.concat((combined.frames || []).map((frame) => frame.decoded.pcm));
const similaritySource = Buffer.concat([...directResults.map(({ result }) => result.pcm), combinedPcm]).subarray(0, 24_000 * 2 * 20);
const similarityEventStart = events.length;
send({
  type: "benchmark.speaker",
  referenceText: chineseText,
  pcm: similaritySource.toString("base64")
});
const similarity = await waitFor(() => events.slice(similarityEventStart).find(({ event }) => event.type === "benchmark.speaker"));

const healthResponse = await fetch(new URL("/api/assistant/live-voice/health?warm=1", baseUrl));
const health = await healthResponse.json();
const firstAudioSamples = directResults.map(({ result }) => result.firstAudioMs);
const segmentRtf = events.map(({ event }) => event).filter((event) => event.type === "tts.segment.completed").map((event) => Number(event.rtf) || 0);
const persistentRtf = events.map(({ event }) => event).filter((event) => event.type === "tts.reply.completed" && Number(event.audioDurationMs) > 0).map((event) => Number(event.synthesisMs || 0) / Number(event.audioDurationMs));
const allPlayback = [...directResults.map(({ result }) => result.playback), combined.playback];
const waveform = waveformMetrics(directResults);
const peakVramMB = Number(health.runtime?.peakVramMB) || 0;
const vramTrendMB = vramSamplesMB.length > 1 ? vramSamplesMB.at(-1) - vramSamplesMB[0] : 0;
const metrics = {
  schemaVersion: persistentSession ? 3 : 2,
  measuredAt: new Date().toISOString(),
  profileId,
  schedulerMode: health.runtime?.schedulerMode || "bounded-segments",
  protocolVersion: negotiatedProtocolVersion,
  persistentTtsSession: persistentSession,
  combinedChatActive: true,
  browserPlaybackSimulationActive: true,
  activeModelRevisions: health.runtime?.activeModelRevisions || {},
  modelVersions: { tts: health.tts?.modelVersion, asr: health.asr?.modelVersion, activeAsr: health.runtime?.asrModel },
  firstAudioP50Ms: Math.round(percentile(firstAudioSamples, 0.5)),
  firstAudioP95Ms: Math.round(percentile(firstAudioSamples, 0.95)),
  firstAudioSamplesMs: firstAudioSamples.map(Math.round),
  playbackFromFirstDeltaP95Ms: Math.round(combined.playbackFromFirstDeltaMs),
  perSegmentRtfP95: Number(percentile(persistentSession ? persistentRtf : segmentRtf, 0.95).toFixed(4)),
  perSegmentRtf: segmentRtf,
  starvationDurationMs: Math.max(...allPlayback.map((item) => item.starvationDurationMs), 0),
  maxStarvationMs: Math.max(...allPlayback.map((item) => item.maxStarvationMs), 0),
  cancellationLatencyP95Ms: Math.round(percentile(cancellationLatencies, 0.95)),
  cancellationQuiescenceP95Ms: Math.round(percentile(cancellationQuiescence, 0.95)),
  orphanWorkCount: Number(health.runtime?.orphanWorkCount) || 0,
  peakVramMB: Math.round(peakVramMB),
  vramSamplesMB: vramSamplesMB.map(Math.round),
  vramTrendMB: Math.round(vramTrendMB),
  chineseCer: Number(errorRate(chineseText, chineseLoopback.text, "character").toFixed(4)),
  englishWer: Number(errorRate(englishText, englishLoopback.text, "word").toFixed(4)),
  asrTranscripts: {
    chineseExpected: chineseText,
    chineseActual: chineseLoopback.text,
    englishExpected: englishText,
    englishActual: englishLoopback.text,
  },
  asrFinalizationP95Ms: Math.round(Math.max(chineseLoopback.finalizationMs, englishLoopback.finalizationMs)),
  speakerSimilarity: Number(similarity.event.speakerSimilarity) || 0,
  nonStreamingReferenceSimilarity: Number(similarity.event.nonStreamingReferenceSimilarity) || 0,
  rawReferenceSimilarity: Number(similarity.event.rawReferenceSimilarity) || 0,
  nonStreamingReferenceAudioBytes: Number(similarity.event.nonStreamingAudioBytes) || 0,
  speakerDiagnostics: {
    generatedToPrimaryReferenceSimilarity: Number(similarity.event.generatedToPrimaryReferenceSimilarity) || 0,
    generatedToReferenceSimilarities: Array.isArray(similarity.event.generatedToReferenceSimilarities) ? similarity.event.generatedToReferenceSimilarities : [],
    referenceToTargetSimilarities: Array.isArray(similarity.event.referenceToTargetSimilarities) ? similarity.event.referenceToTargetSimilarities : [],
  },
  clippingRatio: Number(waveform.clippingRatio.toFixed(6)),
  maxJoinDiscontinuityFullScale: Number(waveform.maxJoinDiscontinuityFullScale.toFixed(6)),
  caseCount: directResults.length + 1,
  cancellationCycles: cancellationLatencies.length,
  audioFrames: binary.length
  ,benchmarkMode: process.env.VOICE_BENCHMARK_MODE || "default"
  ,longCaseRepeats
};
metrics.pass = metrics.firstAudioP50Ms <= 1000
  && metrics.firstAudioP95Ms <= 1500
  && metrics.playbackFromFirstDeltaP95Ms <= 2500
  && metrics.perSegmentRtfP95 < 0.9
  && metrics.starvationDurationMs === 0
  && metrics.maxStarvationMs === 0
  && metrics.cancellationLatencyP95Ms <= 150
  && metrics.cancellationQuiescenceP95Ms <= 500
  && metrics.orphanWorkCount === 0
  && metrics.peakVramMB > 0
  && metrics.peakVramMB < 10.5 * 1024
  && metrics.vramSamplesMB.length === 10
  && metrics.vramTrendMB <= 64
  && metrics.chineseCer <= 0.06
  && metrics.englishWer <= 0.10
  && metrics.speakerSimilarity >= 0.80
  && metrics.speakerSimilarity >= metrics.nonStreamingReferenceSimilarity - 0.02
  && metrics.clippingRatio < 0.001
  && metrics.maxJoinDiscontinuityFullScale <= 0.08
  && metrics.cancellationCycles === 20;
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(metrics, null, 2), "utf8");
console.log(JSON.stringify(metrics, null, 2));
socket.close(1000, "Benchmark complete");
if (!metrics.pass) process.exitCode = 1;
