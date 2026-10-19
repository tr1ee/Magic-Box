import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { naturalizeSpeechText, punctuationPauseMs } from "../shared/speech-planner.mjs";
import { renderSpokenText } from "../shared/spoken-text-renderer.mjs";
import { VoiceTraceRecorder } from "./voice-trace.mjs";
import { getTtsProvider, TTS_PROVIDER_IDS } from "./tts/providers.mjs";

export const LIVE_VOICE_PATH = "/api/assistant/live-voice";
export const LIVE_VOICE_INPUT_FORMAT = Object.freeze({ encoding: "pcm_s16le", sampleRate: 16000, channels: 1 });
export const LIVE_VOICE_OUTPUT_FORMAT = Object.freeze({ encoding: "pcm_s16le", sampleRate: 24000, channels: 1 });

const MAX_INPUT_BYTES = 16000 * 2 * 60;
const MAX_TEXT_CHARS = 32000;
const MAX_SEGMENT_CHARS = 1200;
const MAX_QUEUED_SEGMENTS = 3;
const MAX_UNACKED_COMMITS = 8;
const MAX_UNACKED_TEXT_CHARS = 600;
const MAX_ESTIMATED_AUDIO_AHEAD_MS = 6000;
const MAX_SOCKET_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
export const LIVE_VOICE_PROTOCOL_VERSION = 4;
export const LIVE_VOICE_PERSISTENT_PROTOCOL_VERSION = 5;

export function estimateSpokenTokens(value) {
  const text = String(value || "");
  const cjk = [...text].filter((character) => /[\u4e00-\u9fff]/u.test(character)).length;
  const latin = text.match(/[A-Za-z]+(?:['-][A-Za-z]+)?|\d+(?:[.,:/-]\d+)*/gu)?.length || 0;
  return Math.max(0, cjk + latin);
}

/** Per-reply flow-control state shared by segmented and persistent TTS. */
export class VoiceReplySession {
  constructor({ maxUnackedCommits = MAX_UNACKED_COMMITS, maxUnackedTextChars = MAX_UNACKED_TEXT_CHARS, maxEstimatedAudioAheadMs = MAX_ESTIMATED_AUDIO_AHEAD_MS } = {}) {
    this.maxUnackedCommits = maxUnackedCommits;
    this.maxUnackedTextChars = maxUnackedTextChars;
    this.maxEstimatedAudioAheadMs = maxEstimatedAudioAheadMs;
    this.reset();
  }

  reset() {
    this.nextCommitSeq = 1;
    this.lastAcceptedCommitSeq = 0;
    this.unackedCommits = 0;
    this.unackedTextChars = 0;
    this.estimatedAudioAheadMs = 0;
  }

  canAccept(textChars, estimatedAudioMs = 0) {
    return this.unackedCommits < this.maxUnackedCommits
      && this.unackedTextChars + Math.max(0, Number(textChars) || 0) <= this.maxUnackedTextChars
      && this.estimatedAudioAheadMs + Math.max(0, Number(estimatedAudioMs) || 0) <= this.maxEstimatedAudioAheadMs;
  }

  append(commitSeq, textChars, estimatedAudioMs = 0) {
    const sequence = Number(commitSeq) || this.nextCommitSeq;
    if (!this.canAccept(textChars, estimatedAudioMs)) return false;
    if (sequence !== this.lastAcceptedCommitSeq + 1) return false;
    this.lastAcceptedCommitSeq = sequence;
    this.nextCommitSeq = sequence + 1;
    this.unackedCommits += 1;
    this.unackedTextChars += Math.max(0, Number(textChars) || 0);
    this.estimatedAudioAheadMs += Math.max(0, Number(estimatedAudioMs) || 0);
    return true;
  }

  acknowledge(textChars = 0, estimatedAudioMs = 0) {
    this.unackedCommits = Math.max(0, this.unackedCommits - 1);
    this.unackedTextChars = Math.max(0, this.unackedTextChars - Math.max(0, Number(textChars) || 0));
    this.estimatedAudioAheadMs = Math.max(0, this.estimatedAudioAheadMs - Math.max(0, Number(estimatedAudioMs) || 0));
  }
}

function containsUnsupportedScript(value) {
  const text = String(value || "");
  if (!text) return false;
  const supported = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Number}\p{Punctuation}\p{Separator}\p{Symbol}\p{Mark}]/gu;
  return text.replace(supported, "").trim().length > 0;
}

function typedError(code, message, retryable = false, details = undefined) {
  return { type: "error", code, message, retryable, ...(details ? { details } : {}) };
}

function safeSendJson(socket, value) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function parseJson(value) {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function encodeAudioFrame(generation, sequence, pcm, { segmentSequence = 0, boundaryPauseMs = 0, first = false } = {}) {
  const header = Buffer.allocUnsafe(16);
  header.writeUInt32LE(generation >>> 0, 0);
  header.writeUInt32LE(sequence >>> 0, 4);
  header.writeUInt32LE(segmentSequence >>> 0, 8);
  header.writeUInt16LE(Math.max(0, Math.min(900, Number(boundaryPauseMs) || 0)), 12);
  header.writeUInt16LE(first ? 1 : 0, 14);
  return Buffer.concat([header, pcm]);
}

export function decodeAudioFrame(frame) {
  const value = Buffer.from(frame);
  if (value.length < 8) throw new Error("Live voice audio frame is missing its header.");
  return {
    generation: value.readUInt32LE(0),
    sequence: value.readUInt32LE(4),
    segmentSequence: value.length >= 16 ? value.readUInt32LE(8) : 0,
    boundaryPauseMs: value.length >= 16 ? value.readUInt16LE(12) : 0,
    first: value.length >= 16 ? Boolean(value.readUInt16LE(14) & 1) : false,
    headerBytes: value.length >= 16 ? 16 : 8,
    pcm: value.subarray(value.length >= 16 ? 16 : 8)
  };
}

class ProcessWorker extends EventEmitter {
  constructor(command, runtime = {}) {
    super();
    this.command = command;
    this.runtime = runtime;
    this.child = null;
    this.buffer = "";
    this.binaryBuffer = Buffer.alloc(0);
    this.binaryIpc = runtime.binaryWorkerIpc === true || process.env.VOICE_BINARY_WORKER_IPC === "1";
    this.closing = false;
  }

  start() {
    if (this.child) return;
    this.closing = false;
    this.child = spawn(this.command.command, this.command.args || [], {
      cwd: this.command.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(this.command.env || {}),
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        MAGIC_BOX_WORKER_BINARY_IPC: this.binaryIpc ? "1" : "0",
        MAGIC_BOX_LIVE_VOICE_RUNTIME: JSON.stringify(this.runtime)
      }
    });
    if (this.binaryIpc) {
      this.child.stdout.on("data", (chunk) => this.consumeBinary(Buffer.from(chunk)));
    } else this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      if (this.binaryIpc) return;
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const event = parseJson(line);
        if (event) this.emit("event", event);
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.emit("diagnostic", String(chunk).trim()));
    this.child.once("error", (error) => this.emit("crash", error));
    this.child.once("exit", (code, signal) => {
      const error = new Error(`Live voice worker exited (${signal || code || 0}).`);
      error.code = "LIVE_VOICE_WORKER_EXIT";
      this.child = null;
      if (!this.closing) this.emit("crash", error);
    });
  }

  consumeBinary(chunk) {
    this.binaryBuffer = Buffer.concat([this.binaryBuffer, chunk]);
    const magic = Buffer.from("MBV5");
    while (this.binaryBuffer.length >= 12) {
      if (!this.binaryBuffer.subarray(0, 4).equals(magic)) {
        const newline = this.binaryBuffer.indexOf(10);
        if (newline < 0) return;
        const line = this.binaryBuffer.subarray(0, newline).toString("utf8").trim();
        this.binaryBuffer = this.binaryBuffer.subarray(newline + 1);
        const event = parseJson(line);
        if (event) this.emit("event", event);
        continue;
      }
      const headerLength = this.binaryBuffer.readUInt32LE(4);
      const payloadLength = this.binaryBuffer.readUInt32LE(8);
      const total = 12 + headerLength + payloadLength;
      if (this.binaryBuffer.length < total) return;
      const event = parseJson(this.binaryBuffer.subarray(12, 12 + headerLength).toString("utf8"));
      const payload = this.binaryBuffer.subarray(12 + headerLength, total);
      this.binaryBuffer = this.binaryBuffer.subarray(total);
      if (event) {
        if (payload.length) event.pcm = payload;
        this.emit("event", event);
      }
    }
  }

  writeBinary(message, payload = Buffer.alloc(0), target = this.child) {
    const encoded = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.allocUnsafe(12 + encoded.length + payload.length);
    frame.write("MBV5", 0, 4, "ascii");
    frame.writeUInt32LE(encoded.length, 4);
    frame.writeUInt32LE(payload.length, 8);
    encoded.copy(frame, 12);
    if (payload.length) payload.copy(frame, 12 + encoded.length);
    target?.stdin?.write(frame);
  }

  send(message) {
    this.start();
    if (!this.child?.stdin?.writable) throw new Error("Live voice worker is unavailable.");
    if (this.binaryIpc) {
      let payload = Buffer.alloc(0);
      const next = { ...message };
      for (const key of ["pcm", "audio"]) {
        if (typeof next[key] === "string" && next[key].length > 0) {
          try { payload = Buffer.from(next[key], "base64"); delete next[key]; break; } catch {}
        }
      }
      this.writeBinary(next, payload);
    } else this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close() {
    const child = this.child;
    this.closing = true;
    this.child = null;
    if (!child) return;
    try {
      if (this.binaryIpc) this.writeBinary({ type: "runtime.close" }, Buffer.alloc(0), child);
      else child.stdin.write(`${JSON.stringify({ type: "runtime.close" })}\n`);
    } catch {}
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (process.platform === "win32") {
          // A venv's python.exe is a launcher with a child interpreter.
          // Killing only the launcher can leave the model resident forever.
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", resolve);
          killer.once("exit", resolve);
        } else {
          child.kill("SIGKILL");
          resolve();
        }
      }, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.inputs = new Map();
    this.replies = new Map();
    this.cancelled = new Set();
  }

  completeReply(key, message) {
    const reply = this.replies.get(key);
    if (!reply?.committed || reply.pending > 0 || reply.completed || this.cancelled.has(key)) return;
    reply.completed = true;
    queueMicrotask(() => this.emit("event", {
      type: "tts.reply.completed", sessionId: message.sessionId, turnId: message.turnId,
      replyId: reply.replyId, segmentCount: reply.segmentCount, orphanWorkCount: 0
    }));
  }

  send(message) {
    const key = `${message.sessionId || ""}:${message.turnId || ""}`;
    if (message.type === "runtime.health") {
      queueMicrotask(() => this.emit("event", { type: "runtime.health", requestId: message.requestId, tts: "ready", asr: "ready", warm: true, fake: true, schemaVersion: 2, schedulerMode: "bounded-segments", orphanWorkCount: 0 }));
    } else if (message.type === "session.start") {
      queueMicrotask(() => this.emit("event", { type: "session.warm", sessionId: message.sessionId, profileId: message.profileId, warm: true }));
    } else if (message.type === "input.start") {
      this.inputs.set(key, []);
    } else if (message.type === "input.audio") {
      this.inputs.get(key)?.push(message.pcm);
    } else if (message.type === "input.stop") {
      queueMicrotask(() => {
        this.emit("event", { type: "input.ended", sessionId: message.sessionId, turnId: message.turnId, reason: "endpoint" });
        this.emit("event", { type: "transcript.final", sessionId: message.sessionId, turnId: message.turnId, text: "Microphone input received.", language: "en", languageProbability: 1, noSpeech: false });
      });
    } else if (message.type === "tts.reply.start") {
      this.cancelled.delete(key);
      this.replies.set(key, { replyId: message.replyId, pending: 0, committed: false, completed: false, segmentCount: 0, persistent: message.persistent === true });
      queueMicrotask(() => this.emit("event", { type: "tts.reply.ready", sessionId: message.sessionId, turnId: message.turnId, replyId: message.replyId, schedulerMode: "bounded-segments" }));
    } else if (message.type === "tts.segment") {
      const reply = this.replies.get(key);
      if (!reply) return;
      if (reply.persistent) {
        reply.segmentCount = Number(message.commitSeq || message.sequence) || reply.segmentCount + 1;
        queueMicrotask(() => this.emit("event", { type: "tts.text.accepted", sessionId: message.sessionId, turnId: message.turnId, replyId: message.replyId, sequence: reply.segmentCount, commitSeq: reply.segmentCount, queueDepth: 0 }));
      }
      reply.pending += 1;
      reply.segmentCount += 1;
      const samples = Math.max(960, Math.min(4800, String(message.text || "").length * 240));
      const pcm = Buffer.alloc(samples * 2);
      for (let index = 0; index < samples; index += 1) pcm.writeInt16LE(Math.round(Math.sin(index * 0.055) * 2200), index * 2);
      queueMicrotask(() => this.emit("event", {
        type: "tts.segment.started", sessionId: message.sessionId, turnId: message.turnId,
        replyId: message.replyId, segmentId: message.segmentId, sequence: message.sequence, queueDepth: reply.pending
      }));
      setTimeout(() => {
        if (this.cancelled.has(key)) return;
        this.emit("event", {
          type: "tts.audio", sessionId: message.sessionId, turnId: message.turnId, replyId: message.replyId,
          segmentId: message.segmentId, sequence: message.sequence, first: true, boundary: message.boundary,
          queueDepth: Math.max(0, reply.pending - 1), firstAudioLatencyMs: 10, pcm: pcm.toString("base64")
        });
        reply.pending -= 1;
        this.emit("event", {
          type: "tts.segment.completed", sessionId: message.sessionId, turnId: message.turnId, replyId: message.replyId,
          segmentId: message.segmentId, sequence: message.sequence, queueDepth: reply.pending,
          synthesisMs: 10, audioDurationMs: Math.round(samples / 24), rtf: 0.1
        });
        this.completeReply(key, message);
      }, 10);
    } else if (message.type === "tts.reply.commit" || message.type === "tts.input.finish") {
      const reply = this.replies.get(key);
      if (reply) {
        reply.committed = true;
        reply.segmentCount = Number(message.segmentCount ?? message.commitSeq) || reply.segmentCount;
        this.completeReply(key, message);
      }
    } else if (message.type === "tts.text.append") {
      const reply = this.replies.get(key);
      if (!reply) return;
      reply.persistent = true;
      reply.segmentCount = Number(message.commitSeq || message.sequence) || reply.segmentCount + 1;
      reply.pending += 1;
      const samples = Math.max(960, Math.min(4800, String(message.text || "").length * 240));
      const pcm = Buffer.alloc(samples * 2);
      for (let index = 0; index < samples; index += 1) pcm.writeInt16LE(Math.round(Math.sin(index * 0.055) * 2200), index * 2);
      queueMicrotask(() => this.emit("event", { type: "tts.text.accepted", sessionId: message.sessionId, turnId: message.turnId, replyId: message.replyId, sequence: reply.segmentCount, commitSeq: reply.segmentCount, queueDepth: reply.pending }));
      setTimeout(() => {
        if (this.cancelled.has(key)) return;
        this.emit("event", { type: "tts.audio", sessionId: message.sessionId, turnId: message.turnId, replyId: message.replyId, segmentId: `${message.replyId}:persistent`, sequence: reply.segmentCount, commitSeq: reply.segmentCount, first: reply.pending === 1, boundary: "stream", queueDepth: Math.max(0, reply.pending - 1), firstAudioLatencyMs: 10, pcm: pcm.toString("base64") });
        reply.pending -= 1;
        this.completeReply(key, message);
      }, 10);
    } else if (message.type === "turn.cancel") {
      this.cancelled.add(key);
      this.replies.delete(key);
      queueMicrotask(() => {
        this.emit("event", { type: "turn.cancelled", sessionId: message.sessionId, turnId: message.turnId, acknowledgementMs: 1 });
        this.emit("event", { type: "tts.cancel.quiesced", sessionId: message.sessionId, turnId: message.turnId, cancellationQuiescenceMs: 1, orphanWorkCount: 0 });
      });
    } else if (message.type === "runtime.unload") {
      queueMicrotask(() => this.emit("event", { type: "runtime.unloaded", requestId: message.requestId }));
    } else if (message.type === "profile.warm") {
      queueMicrotask(() => this.emit("event", { type: "profile.warm", requestId: message.requestId, profileId: message.profileId, warmed: true, speakerFeaturesCached: true, firstAudioLatencyMs: 120 }));
    }
  }

  async close() {}
}

export function createLiveVoiceService({
  server,
  getProfile,
  getHealth,
  workerCommand,
  runtime = {},
  logger = () => {},
  fake = process.env.MAGIC_BOX_LIVE_VOICE_FAKE === "1" || process.env.MAGIC_BOX_VOICE_ENGINE_FAKE === "1",
  featureFlags = {},
  traceRoot,
  setRuntimeMode = () => {}
}) {
  if (!server) throw new Error("createLiveVoiceService requires the local HTTP server.");
  const socketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES + 1024 });
  const sessions = new Map();
  let worker = null;
  let workerHealth = null;
  let generation = 0;
  let workerRestartPromise = null;
  let workerUnloadPromise = null;
  const pendingRequests = new Map();
  const warmProfileRequests = new Map();
  const flags = Object.freeze({
    traceV2: featureFlags.traceV2 ?? process.env.VOICE_TRACE_V2 === "1",
    statefulResampler: featureFlags.statefulResampler ?? process.env.VOICE_STATEFUL_RESAMPLER === "1",
    persistentTtsSession: (featureFlags.persistentTtsSession ?? process.env.VOICE_PERSISTENT_TTS_SESSION === "1")
      && (runtime.ttsProvider === TTS_PROVIDER_IDS.QWEN3 || (featureFlags.trueBistream ?? process.env.VOICE_TRUE_BISTREAM !== "0")),
    trueBistream: featureFlags.trueBistream ?? process.env.VOICE_TRUE_BISTREAM !== "0",
    binaryWorkerIpc: featureFlags.binaryWorkerIpc ?? process.env.VOICE_BINARY_WORKER_IPC === "1",
    autoGpuLayers: featureFlags.autoGpuLayers ?? process.env.VOICE_AUTO_GPU_LAYERS === "1",
    adaptiveCommit: featureFlags.adaptiveCommit ?? process.env.VOICE_ADAPTIVE_COMMIT !== "0",
    textLeadController: featureFlags.textLeadController ?? process.env.VOICE_TEXT_LEAD_CONTROLLER !== "0",
    partialAsr: featureFlags.partialAsr ?? process.env.VOICE_PARTIAL_ASR === "1",
    bargeIn: featureFlags.bargeIn ?? process.env.VOICE_BARGE_IN === "1",
    spokenRenderer: featureFlags.spokenRenderer ?? (process.env.VOICE_SPOKEN_RENDERER !== "0")
  });
  const provider = getTtsProvider(featureFlags.providerId || process.env.VOICE_TTS_PROVIDER || TTS_PROVIDER_IDS.COSYVOICE3);
  const trace = new VoiceTraceRecorder({
    enabled: flags.traceV2,
    captureAudio: process.env.VOICE_TRACE_AUDIO === "1",
    ...(traceRoot ? { rootDir: traceRoot } : {})
  });

  function traceContext(session) {
    return {
      sessionId: session.id,
      turnId: session.activeTurnId,
      replyId: session.replyId,
      generationId: session.generation,
      ttsSessionId: session.ttsSessionId,
      inferenceInstanceId: session.inferenceInstanceId || "",
      profileId: session.profileId || "",
      speakerPromptHash: session.speakerPromptHash || "",
      referenceSetHash: session.referenceSetHash || "",
      textLeadTokens: Number(session.textLeadTokens) || 0
    };
  }

  function ensureWorker() {
    if (worker) return worker;
    const instance = fake ? new FakeWorker() : new ProcessWorker(workerCommand(), { ...runtime, binaryWorkerIpc: flags.binaryWorkerIpc });
    worker = instance;
    instance.on("diagnostic", (message) => logger(`live-voice: ${message}`));
    instance.on("crash", (error) => {
      if (worker !== instance) return;
      logger(`live-voice: ${error.message}`);
      workerHealth = { ok: false, error: error.message };
      rejectWorkerRequests(instance, error);
      for (const session of sessions.values()) {
        safeSendJson(session.socket, typedError("voice_worker_crashed", "Local voice stopped unexpectedly. Written chat is still available.", true));
      }
      worker = null;
    });
    instance.on("event", handleWorkerEvent);
    return instance;
  }

  function handleWorkerEvent(event) {
    if (event.requestId && pendingRequests.has(event.requestId)) {
      const request = pendingRequests.get(event.requestId);
      pendingRequests.delete(event.requestId);
      clearTimeout(request.timer);
      request.resolve(event);
      return;
    }
    const session = sessions.get(event.sessionId);
    if (!session) return;
    if (event.turnId && event.turnId !== session.activeTurnId) return;
    if (event.type === "tts.audio") {
      if (!event.pcm || session.cancelled) return;
      if (session.socket.bufferedAmount > MAX_SOCKET_BACKPRESSURE_BYTES) {
        cancelTurn(session, "backpressure");
        safeSendJson(session.socket, typedError("audio_backpressure", "Audio playback could not keep up with synthesis. The spoken turn was cancelled; written chat continues.", true));
        return;
      }
      const pcm = Buffer.isBuffer(event.pcm) ? event.pcm : Buffer.from(event.pcm, "base64");
      session.audioSequence += 1;
      const context = traceContext(session);
      const now = performance.now();
      const previousPcmAt = session.lastPcmAt;
      session.lastPcmAt = now;
      if (!session.firstPcmTraced) {
        session.firstPcmTraced = true;
        const commitMeta = session.commitMeta.get(Number(event.sequence) || 0);
        trace.record("tts.first_pcm", context, { commitSeq: Number(event.sequence) || 0, audioFrameSeq: session.audioSequence, pcmSamples: pcm.length / 2, sampleRate: LIVE_VOICE_OUTPUT_FORMAT.sampleRate, provider: provider.engine, appendToFirstPcmMs: commitMeta?.enqueuedAt ? Math.round(now - commitMeta.enqueuedAt) : 0 });
      }
      trace.record("ipc.pcm_received", context, { commitSeq: Number(event.sequence) || 0, audioFrameSeq: session.audioSequence, pcmSamples: pcm.length / 2, queueDepth: Number(event.queueDepth) || 0, sampleRate: LIVE_VOICE_OUTPUT_FORMAT.sampleRate, pcmBurstGapMs: previousPcmAt ? Math.round(now - previousPcmAt) : 0, inferenceInstanceId: event.inferenceInstanceId || context.inferenceInstanceId, speakerPromptHash: event.speakerPromptHash || context.speakerPromptHash, referenceSetHash: event.referenceSetHash || context.referenceSetHash });
      trace.record("tts.audio_chunk", context, { commitSeq: Number(event.sequence) || 0, audioFrameSeq: session.audioSequence, pcmSamples: pcm.length / 2, queueDepth: Number(event.queueDepth) || 0, sampleRate: LIVE_VOICE_OUTPUT_FORMAT.sampleRate, provider: provider.engine });
      trace.appendAudio(context, pcm);
      const priorBoundary = session.segmentBoundaries.get((Number(event.sequence) || 0) - 1);
      session.socket.send(encodeAudioFrame(session.generation, session.audioSequence, pcm, {
        segmentSequence: Number(event.sequence) || 0,
        boundaryPauseMs: event.first ? punctuationPauseMs(priorBoundary) : 0,
        first: event.first === true
      }), { binary: true });
      trace.record("ws.pcm_sent", context, { commitSeq: Number(event.sequence) || 0, audioFrameSeq: session.audioSequence, pcmSamples: pcm.length / 2, sampleRate: LIVE_VOICE_OUTPUT_FORMAT.sampleRate });
      return;
    }
    const context = traceContext(session);
    if (event.type === "tts.reply.ready") {
      session.ttsReadyAt = Date.now();
      session.inferenceInstanceId = String(event.inferenceInstanceId || session.inferenceInstanceId || "");
      session.speakerPromptHash = String(event.speakerPromptHash || session.speakerPromptHash || "");
      session.referenceSetHash = String(event.referenceSetHash || session.referenceSetHash || "");
      trace.record("tts.session_started", traceContext(session), { provider: provider.engine, providerId: provider.id, resourceProfile: "voice", inferenceInstanceId: session.inferenceInstanceId, speakerPromptHash: session.speakerPromptHash, referenceSetHash: session.referenceSetHash });
    }
    if (event.type === "tts.segment.started") trace.record("speech.commit_acked", context, { commitSeq: Number(event.sequence) || 0, queueDepth: Number(event.queueDepth) || 0 });
    if (event.type === "tts.segment.completed") {
      session.queuedSegments = Math.max(0, session.queuedSegments - 1);
      trace.record("speech.commit_acked", context, { commitSeq: Number(event.sequence) || 0, queueDepth: Number(event.queueDepth) || 0, synthesisMs: Number(event.synthesisMs) || 0 });
    }
    if (event.type === "tts.text.accepted") {
      session.queuedSegments = Math.max(0, session.queuedSegments - 1);
      const acceptedSeq = Number(event.commitSeq || event.sequence) || 0;
      const acceptedMeta = session.commitMeta.get(acceptedSeq);
      session.replySession.acknowledge(acceptedMeta?.textChars || 0, acceptedMeta?.estimatedAudioMs || 0);
      session.commitMeta.delete(acceptedSeq);
      trace.record("tts.append_acked", context, { commitSeq: acceptedSeq, queueDepth: Number(event.queueDepth) || 0, persistent: true, appendAckMs: Number(event.appendAckMs) || (acceptedMeta?.enqueuedAt ? Math.round(performance.now() - acceptedMeta.enqueuedAt) : 0) });
      trace.record("speech.commit_acked", context, { commitSeq: acceptedSeq, queueDepth: Number(event.queueDepth) || 0, persistent: true });
    }
    if (event.type === "tts.text_generator_yielded") {
      session.textLeadTokens = Math.max(0, session.textLeadTokens - (Number(event.textTokens) || 0));
      trace.record("tts.text_generator_yielded", traceContext(session), {
        textChars: Number(event.textChars) || 0,
        textTokens: Number(event.textTokens) || 0,
        textGeneratorYieldCount: Number(event.textGeneratorYieldCount) || 0,
        textQueueDepth: Number(event.textQueueDepth) || 0,
        textLeadTokens: session.textLeadTokens,
        textNormalizationBypassed: event.textNormalizationBypassed === true,
        normalizerStage: String(event.normalizerStage || "")
      });
    }
    if (event.type === "vad.speech.started") trace.record("vad.speech_started", context, {});
    if (event.type === "vad.speech.ended") trace.record("vad.speech_ended", context, {});
    if (event.type === "asr.final.started") trace.record("asr.final_started", context, { pcmSamples: Number(event.pcmSamples) || 0 });
    if (event.type === "transcript.partial") trace.record("asr.partial", context, { textChars: String(event.text || "").length });
    if (event.type === "transcript.final") trace.record("asr.final_completed", context, { textChars: String(event.text || "").length });
    if (event.type === "tts.reply.completed") {
      session.replyCommitted = true;
      trace.record("tts.last_pcm", context, { audioFrameSeq: session.audioSequence, queueDepth: 0, provider: provider.engine, providerId: provider.id, modelTtsCallCount: Number(event.modelTtsCallCount) || 0 });
      trace.record("tts.append_finished", context, {
        commitSeq: Number(event.segmentCount) || session.lastSegmentSequence,
        queueDepth: 0,
        synthesisMs: Number(event.synthesisMs) || 0,
        audioDurationMs: Number(event.audioDurationMs) || 0,
        modelTtsCallCount: Number(event.modelTtsCallCount) || 0,
        promptExtractionCount: Number(event.promptExtractionCount) || 0,
        inferenceIdStable: event.inferenceIdStable === true,
        textGeneratorYieldCount: Number(event.textGeneratorYieldCount) || 0,
        textGeneratorTokens: Number(event.textGeneratorTokens) || 0,
        hopHistory: Array.isArray(event.hopHistory) ? event.hopHistory : [],
        capabilityProbe: event.capabilityProbe || null
      });
      trace.record("tts.session_finished", context, { queueDepth: 0, provider: provider.engine, providerId: provider.id });
      trace.finishAudio(context, LIVE_VOICE_OUTPUT_FORMAT.sampleRate);
    }
    if (event.type.startsWith("worker.") || event.type === "tts.inference_started" || event.type === "tts.inference_reused" || event.type === "tts.model_call_started") {
      trace.record(event.type, context, {
        commitSeq: Number(event.commitSeq || event.sequence) || 0,
        queueDepth: Number(event.queueDepth) || 0,
        workerLockWaitMs: Number(event.workerLockWaitMs) || 0,
        inferenceInstanceId: event.inferenceInstanceId || context.inferenceInstanceId,
        speakerPromptHash: event.speakerPromptHash || context.speakerPromptHash,
        referenceSetHash: event.referenceSetHash || context.referenceSetHash,
        modelTtsCallCount: Number(event.modelTtsCallCount) || 0,
        promptExtractionCount: Number(event.promptExtractionCount) || 0,
        phase: String(event.phase || ""),
        textNormalizationBypassed: event.textNormalizationBypassed === true
      });
    }
    if (event.type === "tts.cancel.quiesced") trace.record("tts.cancel_completed", context, { cancellationQuiescenceMs: Number(event.cancellationQuiescenceMs) || 0 });
    safeSendJson(session.socket, { ...event, pcm: undefined, generation: session.generation });
    if (event.type === "runtime.restart.required") void restartWorker(event.code || "watchdog");
  }

  async function restartWorker(reason = "watchdog") {
    if (workerRestartPromise) return workerRestartPromise;
    workerRestartPromise = (async () => {
      const previous = worker;
      worker = null;
      rejectWorkerRequests(previous, new Error("Voice runtime restarted; please prepare the voice again."));
      await previous?.close?.();
      workerHealth = null;
      const activeSessions = [...sessions.values()].filter((session) => session.profileId && session.conversationModel);
      if (!activeSessions.length) return;
      const replacement = ensureWorker();
      for (const session of activeSessions) {
        session.cancelled = true;
        session.queuedSegments = 0;
        safeSendJson(session.socket, { type: "session.preparing", sessionId: session.id, profileId: session.profileId, reason: `worker-${reason}` });
        replacement.send({
          type: "session.start", sessionId: session.id, profileId: session.profileId,
          speed: session.speed, expressiveness: session.expressiveness, conversationModel: session.conversationModel
        });
      }
      const uniqueProfiles = new Map(activeSessions.map((session) => [session.profileId, session.conversationModel]));
      for (const [profileId, conversationModel] of uniqueProfiles) {
        await workerRequest("profile.warm", { profileId, conversationModel }, 600000);
      }
      for (const session of activeSessions) {
        safeSendJson(session.socket, {
          type: "session.ready", sessionId: session.id, profileId: session.profileId,
          protocolVersion: flags.persistentTtsSession ? LIVE_VOICE_PERSISTENT_PROTOCOL_VERSION : LIVE_VOICE_PROTOCOL_VERSION, schedulerMode: flags.persistentTtsSession ? "persistent-stream" : "bounded-segments",
          inputFormat: LIVE_VOICE_INPUT_FORMAT, outputFormat: LIVE_VOICE_OUTPUT_FORMAT, features: flags, recovered: true
        });
      }
    })().catch((error) => {
      for (const session of sessions.values()) safeSendJson(session.socket, typedError("voice_worker_restart_failed", "The local cloned voice could not recover. Windows system voice remains available.", true, { reason: error.message }));
    }).finally(() => { workerRestartPromise = null; });
    return workerRestartPromise;
  }

  function rejectWorkerRequests(owner, error) {
    for (const [requestId, pending] of pendingRequests) {
      if (pending.owner !== owner) continue;
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      pending.reject(error);
    }
  }

  async function workerRequest(type, payload = {}, timeoutMs = 15000) {
    if (workerUnloadPromise) await workerUnloadPromise;
    const owner = ensureWorker();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`Live voice worker timed out during ${type}.`));
        if (type === "profile.warm" && worker === owner) {
          worker = null;
          rejectWorkerRequests(owner, new Error("Voice preparation timed out. Please try again."));
          workerUnloadPromise = owner.close().finally(() => { workerUnloadPromise = null; });
        }
      }, timeoutMs);
      pendingRequests.set(requestId, { resolve, reject, timer, owner });
      try { owner.send({ type, requestId, ...payload }); }
      catch (error) { clearTimeout(timer); pendingRequests.delete(requestId); reject(error); }
    });
  }

  async function warmProfileRequest(profile) {
    if (runtime.ttsProvider === TTS_PROVIDER_IDS.QWEN3 && profile?.id) profile = await getProfile(profile.id) || profile;
    if (!profile?.conversationModel || profile.conversationModel.state !== "ready") {
      throw new Error("Prepare this profile's conversation voice before warming it.");
    }
    const model = profile.conversationModel;
    const warmKey = `${profile.id}\0${model.modelVersion || model.revision || ""}\0${model.speakerPromptId || ""}\0${model.referenceSetHash || ""}\0${model.qualityReferenceAudioPath || ""}\0${model.qualityReferenceTranscript || ""}`;
    if (warmProfileRequests.has(warmKey)) return warmProfileRequests.get(warmKey);
    const request = workerRequest("profile.warm", {
      profileId: profile.id,
      warmupKey: warmKey,
      conversationModel: profile.conversationModel
    }, 120000).finally(() => {
      if (warmProfileRequests.get(warmKey) === request) warmProfileRequests.delete(warmKey);
    });
    warmProfileRequests.set(warmKey, request);
    return request;
  }

  function cancelTurn(session, reason = "cancelled") {
    if (!session.activeTurnId) return;
    const turnId = session.activeTurnId;
    session.cancelled = true;
    session.textBuffer = "";
    session.queuedSegments = 0;
    session.replySession.reset();
    session.commitMeta.clear();
    session.replySession.reset();
    session.commitMeta.clear();
    trace.record("tts.cancel_requested", traceContext(session), { reason });
    trace.discardAudio(traceContext(session));
    setRuntimeMode("VOICE_READY", { reason, profileId: session.profileId || null });
    worker?.send({ type: "turn.cancel", sessionId: session.id, turnId, reason });
  }

  function startTurn(session, message, workerType) {
    if (session.activeTurnId) cancelTurn(session, "superseded");
    session.activeTurnId = String(message.turnId || randomUUID());
    session.replyId = String(message.replyId || session.activeTurnId);
    session.generation = ++generation;
    session.audioSequence = 0;
    session.lastPcmAt = 0;
    session.inferenceInstanceId = "";
    session.speakerPromptHash = "";
    session.referenceSetHash = "";
    session.textLeadTokens = 0;
    session.inputBytes = 0;
    session.cancelled = false;
    session.replyCommitted = false;
    session.unsupportedLanguageWarned = false;
    session.queuedSegments = 0;
    session.lastSegmentSequence = 0;
    session.segmentBoundaries.clear();
    session.textBuffer = "";
    session.ttsSessionId = workerType === "tts.reply.start" ? randomUUID() : "";
    session.firstPcmTraced = false;
    if (workerType === "tts.reply.start") trace.record("tts.session_requested", traceContext(session), { resourceProfile: "voice", provider: provider.engine, providerId: provider.id });
    ensureWorker().send({
      type: workerType, sessionId: session.id, turnId: session.activeTurnId,
      replyId: session.replyId, generation: session.generation,
      persistent: workerType === "tts.reply.start" && flags.persistentTtsSession,
      playbackPaced: message.playbackPaced === true,
    });
  }

  function warnUnsupportedLanguage(session, text) {
    if (session.unsupportedLanguageWarned || !containsUnsupportedScript(text)) return;
    session.unsupportedLanguageWarned = true;
    safeSendJson(session.socket, {
      type: "warning", code: "tts_language_best_effort", turnId: session.activeTurnId,
      message: "This language is outside the nine guaranteed streaming languages. MagicBox will keep the selected speaker and try it best-effort."
    });
  }

  function enqueueSegment(session, message) {
    if (session.replyCommitted) return;
    const text = flags.spokenRenderer ? renderSpokenText(message.text, { mode: "spoken", final: true }) : naturalizeSpeechText(message.text, { final: true });
    if (!text || text.length > MAX_SEGMENT_CHARS) {
      safeSendJson(session.socket, typedError("invalid_tts_segment", "A spoken segment must contain a bounded useful utterance."));
      return;
    }
    const sequence = Number(message.sequence) || session.lastSegmentSequence + 1;
    if (sequence !== session.lastSegmentSequence + 1) {
      safeSendJson(session.socket, typedError("segment_out_of_order", "Spoken segments must arrive in sequence."));
      return;
    }
    const queueLimit = flags.persistentTtsSession ? MAX_UNACKED_COMMITS : MAX_QUEUED_SEGMENTS;
    if (session.queuedSegments >= queueLimit) {
      safeSendJson(session.socket, typedError("tts_segment_backpressure", "The local speech queue is full; retry this segment after a segment completes.", true, { queueDepth: session.queuedSegments }));
      return;
    }
    const estimatedAudioMs = Math.min(MAX_ESTIMATED_AUDIO_AHEAD_MS, Math.max(40, text.length * 24));
    const textTokens = estimateSpokenTokens(text);
    if (flags.persistentTtsSession && !session.replySession.append(sequence, text.length, estimatedAudioMs)) {
      safeSendJson(session.socket, typedError("tts_text_backpressure", "The persistent speech input window is full; wait for accepted audio before committing more text.", true, {
        maxUnackedCommits: MAX_UNACKED_COMMITS, maxUnackedTextChars: MAX_UNACKED_TEXT_CHARS, maxEstimatedAudioAheadMs: MAX_ESTIMATED_AUDIO_AHEAD_MS
      }));
      return;
    }
    warnUnsupportedLanguage(session, text);
    session.lastSegmentSequence = sequence;
    session.textLeadTokens += textTokens;
    session.queuedSegments += 1;
    const boundary = ["strong", "weak", "forced", "final"].includes(message.boundary) ? message.boundary : "strong";
    session.segmentBoundaries.set(sequence, boundary);
    session.commitMeta.set(sequence, { textChars: text.length, textTokens, estimatedAudioMs, enqueuedAt: performance.now() });
    trace.record("speech.commit_created", traceContext(session), { commitSeq: sequence, textChars: text.length, textTokens, textLeadTokens: session.textLeadTokens, queueDepth: session.queuedSegments });
    trace.record("tts.append_enqueued", traceContext(session), { commitSeq: sequence, textChars: text.length, textTokens, textLeadTokens: session.textLeadTokens, queueDepth: session.queuedSegments, plannerWaitMs: 0 });
    ensureWorker().send(flags.persistentTtsSession ? {
      type: "tts.text.append", sessionId: session.id, turnId: session.activeTurnId, replyId: session.replyId,
      segmentId: String(message.segmentId || `${session.replyId}:${sequence}`), commitSeq: sequence, sequence, text,
      boundary, queueDepth: session.queuedSegments, enqueuedAtMs: Date.now()
    } : {
      type: "tts.segment", sessionId: session.id, turnId: session.activeTurnId, replyId: session.replyId,
      segmentId: String(message.segmentId || `${session.replyId}:${sequence}`), sequence, text,
      boundary,
      queueDepth: session.queuedSegments
    });
    trace.record("speech.commit_sent", traceContext(session), { commitSeq: sequence, textChars: text.length, queueDepth: session.queuedSegments });
  }

  async function handleControl(session, message) {
    if (!message?.type) {
      safeSendJson(session.socket, typedError("invalid_message", "A live voice control message needs a type."));
      return;
    }
    if (message.type === "session.start") {
      if (session.activeTurnId) {
        cancelTurn(session, "profile-switch");
        session.activeTurnId = "";
      }
      const profileId = String(message.profileId || "");
      const profile = profileId ? await getProfile(profileId) : null;
      if (!profile?.conversationModel || profile.conversationModel.state !== "ready") {
        safeSendJson(session.socket, typedError("conversation_voice_not_ready", "Prepare this profile's conversation voice before using it.", true));
        return;
      }
      const health = await getHealth();
      if (!health?.available) {
        safeSendJson(session.socket, typedError("voice_model_unhealthy", health?.tts?.error || health?.asr?.error || "Install or repair the local streaming voice models before use.", true, { tts: health?.tts, asr: health?.asr }));
        return;
      }
      session.profileId = profileId;
      session.conversationModel = profile.conversationModel;
      session.speed = Math.max(0.7, Math.min(1.3, Number(message.speed) || 1));
      session.expressiveness = Math.max(0, Math.min(1, Number(message.expressiveness) || 0.7));
      ensureWorker().send({
        type: "session.start",
        sessionId: session.id,
        profileId,
        speed: session.speed,
        expressiveness: session.expressiveness,
        conversationModel: profile.conversationModel
      });
      safeSendJson(session.socket, { type: "session.preparing", sessionId: session.id, profileId });
      const warmed = await warmProfileRequest(profile);
      if (!warmed?.warmed) {
        safeSendJson(session.socket, typedError("conversation_voice_warm_failed", warmed?.error || "The local conversation voice could not be prepared.", true));
        return;
      }
      safeSendJson(session.socket, {
        type: "session.ready",
        sessionId: session.id,
        profileId,
        inputFormat: LIVE_VOICE_INPUT_FORMAT,
        outputFormat: LIVE_VOICE_OUTPUT_FORMAT,
        asr: health.asr,
        tts: health.tts,
        protocolVersion: flags.persistentTtsSession ? LIVE_VOICE_PERSISTENT_PROTOCOL_VERSION : LIVE_VOICE_PROTOCOL_VERSION,
        schedulerMode: flags.persistentTtsSession ? "persistent-stream" : "bounded-segments",
        features: flags
      });
      return;
    }
    if (!session.profileId) {
      safeSendJson(session.socket, typedError("session_not_started", "Start the live voice session first."));
      return;
    }
    if (message.type === "benchmark.speaker") {
      const pcm = String(message.pcm || "");
      if (!pcm || pcm.length > 1_800_000) {
        safeSendJson(session.socket, typedError("invalid_benchmark_audio", "The local speaker benchmark audio is missing or too long."));
        return;
      }
      const result = await workerRequest("benchmark.speaker", {
        profileId: session.profileId,
        conversationModel: session.conversationModel,
        referenceText: String(message.referenceText || ""),
        pcm
      }, 180000);
      safeSendJson(session.socket, result.error ? typedError("speaker_benchmark_failed", result.error, true) : result);
      return;
    }
    if (message.type === "input.start") {
      setRuntimeMode("VOICE_LISTENING", { profileId: session.profileId || null });
      startTurn(session, message, "input.start");
      return;
    }
    if (message.type === "tts.reply.start" || message.type === "tts.start") {
      setRuntimeMode("VOICE_RESPONDING", { profileId: session.profileId || null });
      startTurn(session, message, "tts.reply.start");
      return;
    }
    if (String(message.turnId || "") !== session.activeTurnId) {
      safeSendJson(session.socket, typedError("stale_turn", "The message belongs to an inactive turn."));
      return;
    }
    if (message.type === "playback.progress") {
      const playedMs = Number(message.playedMs);
      if (Number.isFinite(playedMs) && playedMs >= 0) ensureWorker().send({
        type: "playback.progress", sessionId: session.id, turnId: session.activeTurnId, playedMs
      });
      return;
    }
    if (message.type === "playback.telemetry") {
      const allowed = new Set(["playback.frame_enqueued", "playback.started", "playback.buffer_depth", "playback.buffer_low", "playback.buffer_empty", "playback.playhead", "playback.non_silent_started", "playback.non_silent_ended", "playback.underrun", "playback.finished", "playback.cancelled", "playback.output_completed"]);
      const event = allowed.has(message.event) ? message.event : "playback.buffer_depth";
      if (event === "playback.output_completed" && message.outputPcmBase64 && trace.captureAudio) {
        try { trace.appendPlaybackAudio(traceContext(session), Buffer.from(String(message.outputPcmBase64), "base64")); } catch {}
        trace.finishPlaybackAudio(traceContext(session), Number(message.sampleRate) || 24000);
      }
      trace.record(event, traceContext(session), {
        audioFrameSeq: Number(message.audioFrameSeq) || 0,
        bufferDepthMs: Number(message.bufferDepthMs) || 0,
        underrunCount: Number(message.underrunCount) || 0,
        underrunDurationMs: Number(message.underrunDurationMs) || 0,
        sampleRate: Number(message.sampleRate) || 0,
        playheadMs: Number(message.playheadMs) || 0,
        semanticSilence: message.semanticSilence === true,
        outputSamples: Number(message.outputSamples) || 0,
        nodeToWorkletMs: Number(message.nodeToWorkletMs) || 0
      });
      return;
    }
    if (message.type === "trace.event") {
      const allowed = new Set(["chat.request", "chat.first_token", "chat.token_gap", "planner.pending_changed", "planner.flush_requested", "planner.flush_emitted", "planner.idle_flush", "planner.waiting_for_boundary"]);
      if (allowed.has(message.event)) trace.record(message.event, traceContext(session), { commitSeq: Number(message.commitSeq) || 0, textChars: Number(message.textChars) || 0, textTokens: Number(message.textTokens) || 0, textLeadTokens: Number(message.textLeadTokens) || Number(session.textLeadTokens) || 0, tokenGapMs: Number(message.tokenGapMs) || 0, plannerWaitMs: Number(message.plannerWaitMs) || 0, firstCommitChars: Number(message.firstCommitChars) || 0, nextCommitChars: Number(message.nextCommitChars) || 0, boundary: String(message.boundary || "") });
      return;
    }
    if (message.type === "input.stop") {
      ensureWorker().send({ type: "input.stop", sessionId: session.id, turnId: session.activeTurnId });
    } else if (message.type === "tts.segment" || message.type === "tts.text.append") {
      enqueueSegment(session, message);
    } else if (message.type === "text.append") {
      if (session.replyCommitted) return;
      session.textBuffer += String(message.text || "");
      if (session.textBuffer.length > MAX_TEXT_CHARS) {
        cancelTurn(session, "text_limit");
        safeSendJson(session.socket, typedError("text_too_long", "The spoken reply exceeded the live voice limit."));
        return;
      }
    } else if (message.type === "text.commit") {
      const legacyText = naturalizeSpeechText(session.textBuffer, { final: true });
      session.textBuffer = "";
      if (legacyText) enqueueSegment(session, { text: legacyText, boundary: "final", sequence: 1, segmentId: `${session.replyId}:legacy` });
      session.replyCommitted = true;
      ensureWorker().send(flags.persistentTtsSession
        ? { type: "tts.input.finish", sessionId: session.id, turnId: session.activeTurnId, replyId: session.replyId, commitSeq: legacyText ? 1 : 0 }
        : { type: "tts.reply.commit", sessionId: session.id, turnId: session.activeTurnId, replyId: session.replyId, segmentCount: legacyText ? 1 : 0, compatibility: "v3" });
    } else if (message.type === "tts.reply.commit" || message.type === "tts.input.finish") {
      const segmentCount = Math.max(0, Number(message.segmentCount) || 0);
      const persistentSegmentCount = Math.max(0, Number(message.commitSeq) || 0);
      if (flags.persistentTtsSession && message.type === "tts.input.finish") {
        if (persistentSegmentCount && persistentSegmentCount !== session.lastSegmentSequence) {
          safeSendJson(session.socket, typedError("segment_count_mismatch", "The committed persistent text count did not match the ordered queue."));
          return;
        }
        session.replyCommitted = true;
        ensureWorker().send({ type: "tts.input.finish", sessionId: session.id, turnId: session.activeTurnId, replyId: session.replyId, commitSeq: persistentSegmentCount || session.lastSegmentSequence });
        return;
      }
      if (segmentCount !== session.lastSegmentSequence) {
        safeSendJson(session.socket, typedError("segment_count_mismatch", "The committed spoken segment count did not match the ordered queue."));
        return;
      }
      session.replyCommitted = true;
      ensureWorker().send(flags.persistentTtsSession
        ? { type: "tts.input.finish", sessionId: session.id, turnId: session.activeTurnId, replyId: session.replyId, commitSeq: segmentCount }
        : { type: "tts.reply.commit", sessionId: session.id, turnId: session.activeTurnId, replyId: session.replyId, segmentCount });
    } else if (message.type === "turn.cancel") {
      cancelTurn(session, "client");
    } else if (message.type === "session.close") {
      ensureWorker().send({ type: "session.close", sessionId: session.id });
      session.socket.close(1000, "Session closed");
    }
  }

  socketServer.on("connection", (socket) => {
    const session = {
      id: randomUUID(), socket, profileId: "", activeTurnId: "", generation: 0,
      audioSequence: 0, inputBytes: 0, textBuffer: "", replyId: "", conversationModel: null,
      replyCommitted: false, cancelled: false, unsupportedLanguageWarned: false,
      queuedSegments: 0, lastSegmentSequence: 0, segmentBoundaries: new Map(),
      ttsSessionId: "", firstPcmTraced: false,
      replySession: new VoiceReplySession(), commitMeta: new Map()
    };
    sessions.set(session.id, session);
    trace.record("voice.session.created", traceContext(session), {});
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!session.activeTurnId || session.cancelled) return;
        const pcm = Buffer.from(data);
        session.inputBytes += pcm.length;
        if (session.inputBytes > MAX_INPUT_BYTES) {
          cancelTurn(session, "input_limit");
          safeSendJson(socket, typedError("input_too_long", "A microphone turn can be at most 60 seconds."));
          return;
        }
        ensureWorker().send({ type: "input.audio", sessionId: session.id, turnId: session.activeTurnId, pcm: pcm.toString("base64") });
        trace.record("ipc.audio_sent", traceContext(session), { pcmSamples: pcm.length / 2, sampleRate: LIVE_VOICE_INPUT_FORMAT.sampleRate });
        return;
      }
      const message = parseJson(data);
      void handleControl(session, message).catch((error) => safeSendJson(socket, typedError("live_voice_failed", error.message, true)));
    });
    socket.on("close", () => {
      cancelTurn(session, "disconnect");
      worker?.send({ type: "session.close", sessionId: session.id });
      sessions.delete(session.id);
    });
  });

  const onUpgrade = (request, socket, head) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname !== LIVE_VOICE_PATH) return;
    socketServer.handleUpgrade(request, socket, head, (webSocket) => socketServer.emit("connection", webSocket, request));
  };
  server.on("upgrade", onUpgrade);

  return {
    async health() {
      const event = await workerRequest("runtime.health", {}, 600000);
      workerHealth = { ok: event.tts === "ready" && event.asr === "ready", ...event };
      return workerHealth;
    },
    async unload({ ifIdle = false } = {}) {
      if (ifIdle && (sessions.size || pendingRequests.size || warmProfileRequests.size)) return { unloaded: false, reason: "voice_busy" };
      if (workerUnloadPromise) return workerUnloadPromise;
      const previous = worker;
      if (!previous) return { unloaded: true };
      worker = null;
      workerHealth = null;
      rejectWorkerRequests(previous, new Error("声音准备已被卸载操作中断，请重新准备。"));
      workerUnloadPromise = previous.close().then(() => ({ unloaded: true })).finally(() => { workerUnloadPromise = null; });
      return workerUnloadPromise;
    },
    hasActiveSessions() {
      return sessions.size > 0;
    },
    isLoaded() {
      return Boolean(worker);
    },
    async warmProfile(profile) {
      return warmProfileRequest(profile);
    },
    async close() {
      server.off("upgrade", onUpgrade);
      for (const session of sessions.values()) session.socket.close(1001, "Server stopping");
      sessions.clear();
      socketServer.close();
      rejectWorkerRequests(worker, new Error("The voice service closed."));
      if (worker) await worker.close();
      if (workerUnloadPromise) await workerUnloadPromise;
      worker = null;
      await trace.close();
    }
  };
}

export function conversationPromptId(profileId, transcript, sourceSampleId) {
  return createHash("sha256").update(`${profileId}\0${sourceSampleId}\0${transcript}`, "utf8").digest("hex");
}
