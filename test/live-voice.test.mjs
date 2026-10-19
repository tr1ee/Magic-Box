import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createLiveVoiceService, decodeAudioFrame, VoiceReplySession } from "../server/live_voice.mjs";

test("persistent voice reply flow control bounds commits, text, and audio ahead", () => {
  const reply = new VoiceReplySession();
  assert.equal(reply.append(1, 120, 2400), true);
  assert.equal(reply.append(2, 120, 2400), true);
  assert.equal(reply.append(3, 120, 2400), false);
  reply.acknowledge(120, 2400);
  assert.equal(reply.append(3, 120, 2400), true);
  assert.equal(reply.append(4, 500, 2400), false);
});

test("v4 uses bounded normalized CosyVoice segments with guarded cancellation", async () => {
  const worker = await fs.readFile(new URL("../server/live_voice_worker.py", import.meta.url), "utf8");
  assert.doesNotMatch(worker, /inference_zero_shot\([^\n]*cosy_prompt_text\s*,\s*reference_audio/u);
  assert.match(worker, /content_free = getattr\(model, "inference_instruct2", None\)/u);
  assert.doesNotMatch(worker, /voice_convert = getattr\(model, "inference_vc", None\)/u);
  assert.doesNotMatch(worker, /results = voice_convert\(/u);
  assert.doesNotMatch(worker, /def incremental_text/u);
  assert.match(worker, /text_frontend=True/u);
  assert.match(worker, /zero_shot_spk_id=style_id/u);
  assert.match(worker, /if expressiveness <= 0\.7:/u);
  assert.match(worker, /clear and precise pronunciation/u);
  assert.match(worker, /style_instruction\(style_name\)/u);
  assert.equal(worker.includes("Speak naturally.<|endofprompt|>"), false);
  assert.match(worker, /neutral standard Mandarin, without regional accent/u);
  assert.match(worker, /class TextChunkStream/u);
  assert.match(worker, /def begin_model_tts_call/u);
  assert.match(worker, /modelTtsCallCount/u);
  assert.match(worker, /textNormalizationBypassed/u);
  assert.match(worker, /capabilityProbe/u);
  assert.match(worker, /included_embeddings/u);
  assert.match(worker, /seed_material = f"\{profile_id\}\\0\{style_name\}\\0voice-stable-v1/u);
  assert.match(worker, /def cancellable_llm_job/u);
  assert.match(worker, /SEGMENT_AUDIO_WATCHDOG_SECONDS = 2\.0/u);
  assert.match(worker, /CANCELLATION_QUIESCENCE_SECONDS = 0\.5/u);
  assert.match(worker, /inference_model\.token_hop_len = 20/u);
  assert.match(worker, /inference_model\.token_max_hop_len = 25/u);
  assert.match(worker, /vram_limit_mb = 10\.5 \* 1024/u);
  assert.match(worker, /OpenCC\("t2s"\)/u);
});

test("v4 reserves the GPU for speech and uses adaptive continuity controls", async () => {
  const [models, worklet, server] = await Promise.all([
    fs.readFile(new URL("../server/assistant/models.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/assistant-pcm-worklet.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../server/index.mjs", import.meta.url), "utf8")
  ]);
  assert.match(models, /"generation:voice"/u);
  assert.match(models, /args\.push\("-ngl", "0"\)/u);
  assert.match(models, /ASSISTANT_VOICE_MODEL_ID/u);
  assert.match(models, /voiceWorkerIdleMs = 10 \* 60_000/u);
  assert.match(worklet, /targetBufferMs = 1000/u);
  assert.match(worklet, /maxBufferMs = 2400/u);
  assert.match(worklet, /Math\.max\(1000, this\.targetBufferMs \+ 300\)/u);
  assert.match(worklet, /resumeAfterUnderrun \? 200 : this\.targetBufferMs/u);
  assert.match(worklet, /sampleRate \* 0\.12/u);
  assert.match(worklet, /sampleRate \* 0\.018/u);
  assert.match(server, /promptSchemaVersion: 2/u);
  assert.match(server, /primaryReferenceSegmentId/u);
  assert.match(server, /referenceDiagnostics/u);
  assert.match(server, /warmConfiguredVoice/u);
  assert.match(server, /void context\.warmConfiguredVoice\(\)/u);
});

test("phase 3-9 voice wiring keeps persistent, binary, partial, barge-in, and provider gates explicit", async () => {
  const [worker, server, client, worklet, provider, benchmark] = await Promise.all([
    fs.readFile(new URL("../server/live_voice_worker.py", import.meta.url), "utf8"),
    fs.readFile(new URL("../server/live_voice.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/liveVoice.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/assistant-pcm-worklet.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../server/tts/providers.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/benchmark-live-voice.mjs", import.meta.url), "utf8")
  ]);
  assert.match(worker, /inference_bistream/u);
  assert.match(worker, /non_streaming_similarity/u);
  assert.match(worker, /MAGIC_BOX_WORKER_BINARY_IPC/u);
  assert.match(worker, /tts\.text\.accepted/u);
  assert.match(worker, /VOICE_PARTIAL_ASR/u);
  assert.match(server, /LIVE_VOICE_PERSISTENT_PROTOCOL_VERSION/u);
  assert.match(server, /MBV5/u);
  assert.match(server, /referenceText: String\(message\.referenceText/u);
  assert.match(server, /trueBistream/u);
  assert.match(server, /estimateSpokenTokens/u);
  assert.match(server, /textLeadController/u);
  assert.match(client, /persistentTtsSession/u);
  assert.match(client, /fadeOut/u);
  assert.match(client, /canBargeIn\(\)/u);
  assert.match(client, /activeMode === "barge-in-monitor"/u);
  assert.match(worklet, /fadeRemainingSamples/u);
  assert.match(provider, /qwen3-tts-stream-local/u);
  assert.match(benchmark, /persistentSession/u);
  assert.match(benchmark, /referenceText: chineseText/u);
});

test("the WebView2 desktop package selects the validated optimized voice bundle", async () => {
  const [webview, packageBuild, packageManifest, installer] = await Promise.all([
    fs.readFile(new URL("../desktop/WebView2Launcher.cs", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/build-webview2.ps1", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/generate-package-manifest.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/build-installer.ps1", import.meta.url), "utf8")
  ]);
  assert.match(webview, /VOICE_OPTIMIZED_PIPELINE/u);
  assert.match(webview, /VOICE_STATEFUL_RESAMPLER/u);
  assert.match(webview, /VOICE_PERSISTENT_TTS_SESSION/u);
  assert.match(webview, /VOICE_BINARY_WORKER_IPC/u);
  assert.match(webview, /VOICE_AUTO_GPU_LAYERS/u);
  assert.match(webview, /VOICE_OPTIMIZED_INPUT/u);
  assert.match(webview, /VOICE_PARTIAL_ASR/u);
  assert.match(webview, /VOICE_BARGE_IN/u);
  assert.match(webview, /MAGIC_BOX_ASSISTANT_DATA_DIR/u);
  assert.match(webview, /assistant\.sqlite3/u);
  assert.match(webview, /StringComparison\.OrdinalIgnoreCase/u);
  assert.doesNotMatch(webview, /EnvironmentVariables/u);
  assert.match(packageBuild, /artifacts\\live-voice-benchmark\.json/u);
  assert.match(packageManifest, /artifacts\/live-voice-benchmark\.json/u);
  assert.match(installer, /"artifacts"/u);
});

async function fixture(options = {}) {
  const server = http.createServer((_request, response) => response.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const service = createLiveVoiceService({
    server,
    fake: true,
    getHealth: async () => ({ available: true, tts: { status: "ready" }, asr: { status: "ready" } }),
    getProfile: async (profileId) => ({
      id: profileId,
      conversationModel: { state: "ready", referenceAudioPath: "fixture.wav", referenceTranscript: "fixture" }
    }),
    workerCommand: () => ({ command: process.execPath, args: [] }),
    ...options
  });
  const { port } = server.address();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/assistant/live-voice`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const messages = [];
  socket.on("message", (data, isBinary) => messages.push(isBinary ? { binary: Buffer.from(data) } : JSON.parse(String(data))));
  return {
    server, service, socket, messages,
    async close() {
      socket.close();
      await service.close();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for live voice event.");
}

test("idle memory reclaim preserves an in-flight profile warm-up", async () => {
  const server = http.createServer();
  const service = createLiveVoiceService({ server, fake: false, featureFlags: { binaryWorkerIpc: false }, workerCommand: () => ({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/voice-lifecycle-worker.mjs", import.meta.url))] }) });
  try {
    const pending = service.warmProfile({ id: "profile", conversationModel: { state: "ready" } });
    const unload = await service.unload({ ifIdle: true });
    assert.deepEqual(unload, { unloaded: false, reason: "voice_busy" });
    assert.equal((await pending).warmed, true);
  } finally { await service.close(); }
});

test("explicit unload settles warming and a replacement can warm again", async () => {
  const server = http.createServer();
  const service = createLiveVoiceService({ server, fake: false, featureFlags: { binaryWorkerIpc: false }, workerCommand: () => ({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/voice-lifecycle-worker.mjs", import.meta.url))] }) });
  try {
    const profile = { id: "profile", conversationModel: { state: "ready" } };
    const pending = service.warmProfile(profile).then(() => "unexpected-success", error => error.message);
    const first = service.unload();
    const second = service.unload();
    assert.match(await pending, /中断/u);
    const replacement = service.warmProfile(profile);
    await Promise.all([first, second]);
    assert.equal((await replacement).warmed, true);
  } finally { await service.close(); }
});

test("protocol v4 streams ordered segmented PCM with generation headers", async () => {
  const app = await fixture();
  try {
    app.socket.send(JSON.stringify({ type: "session.start", profileId: "profile-1", speed: 1, expressiveness: 0.7 }));
    await waitFor(() => app.messages.find((item) => item.type === "session.ready"));
    app.socket.send(JSON.stringify({ type: "tts.reply.start", turnId: "turn-1", replyId: "reply-1" }));
    app.socket.send(JSON.stringify({ type: "tts.segment", turnId: "turn-1", replyId: "reply-1", segmentId: "segment-1", sequence: 1, text: "Hello world.", boundary: "strong" }));
    app.socket.send(JSON.stringify({ type: "tts.segment", turnId: "turn-1", replyId: "reply-1", segmentId: "segment-2", sequence: 2, text: "This is the tail.", boundary: "final" }));
    app.socket.send(JSON.stringify({ type: "tts.reply.commit", turnId: "turn-1", replyId: "reply-1", segmentCount: 2 }));
    const ready = await waitFor(() => app.messages.find((item) => item.type === "tts.reply.ready"));
    const binaries = await waitFor(() => app.messages.filter((item) => item.binary).length === 2 && app.messages.filter((item) => item.binary));
    const decoded = decodeAudioFrame(binaries[0].binary);
    const joined = decodeAudioFrame(binaries[1].binary);
    assert.equal(decoded.generation, ready.generation);
    assert.equal(decoded.sequence, 1);
    assert.equal(decoded.segmentSequence, 1);
    assert.equal(decoded.first, true);
    assert.equal(decoded.boundaryPauseMs, 0);
    assert.equal(decoded.headerBytes, 16);
    assert.ok(decoded.pcm.length > 0);
    assert.equal(joined.segmentSequence, 2);
    assert.equal(joined.boundaryPauseMs, 35);
    await waitFor(() => app.messages.find((item) => item.type === "tts.reply.completed"));
  } finally {
    await app.close();
  }
});

test("protocol v5 negotiates one persistent text-to-speech session", async () => {
  const app = await fixture({ featureFlags: { persistentTtsSession: true } });
  try {
    app.socket.send(JSON.stringify({ type: "session.start", profileId: "profile-1" }));
    const ready = await waitFor(() => app.messages.find((item) => item.type === "session.ready"));
    assert.equal(ready.protocolVersion, 5);
    assert.equal(ready.schedulerMode, "persistent-stream");
    app.socket.send(JSON.stringify({ type: "tts.reply.start", turnId: "persistent-turn", replyId: "persistent-reply" }));
    app.socket.send(JSON.stringify({ type: "tts.text.append", turnId: "persistent-turn", replyId: "persistent-reply", commitSeq: 1, text: "先说这一句。" }));
    app.socket.send(JSON.stringify({ type: "tts.text.append", turnId: "persistent-turn", replyId: "persistent-reply", commitSeq: 2, text: "再自然地接上下一句。" }));
    app.socket.send(JSON.stringify({ type: "tts.input.finish", turnId: "persistent-turn", replyId: "persistent-reply", commitSeq: 2 }));
    await waitFor(() => app.messages.filter((item) => item.type === "tts.text.accepted").length === 2);
    await waitFor(() => app.messages.filter((item) => item.binary).length === 2);
    const completed = await waitFor(() => app.messages.find((item) => item.type === "tts.reply.completed" && item.turnId === "persistent-turn"));
    assert.equal(completed.segmentCount, 2);
  } finally {
    await app.close();
  }
});

test("cancellation rejects stale text and stale worker audio", async () => {
  const app = await fixture();
  try {
    app.socket.send(JSON.stringify({ type: "session.start", profileId: "profile-1" }));
    await waitFor(() => app.messages.find((item) => item.type === "session.ready"));
    app.socket.send(JSON.stringify({ type: "tts.reply.start", turnId: "turn-old", replyId: "old" }));
    app.socket.send(JSON.stringify({ type: "tts.segment", turnId: "turn-old", replyId: "old", segmentId: "old-1", sequence: 1, text: "Cancelled.", boundary: "strong" }));
    app.socket.send(JSON.stringify({ type: "turn.cancel", turnId: "turn-old" }));
    app.socket.send(JSON.stringify({ type: "tts.reply.start", turnId: "turn-new", replyId: "new" }));
    app.socket.send(JSON.stringify({ type: "tts.segment", turnId: "turn-old", replyId: "old", segmentId: "stale", sequence: 2, text: "stale", boundary: "forced" }));
    const stale = await waitFor(() => app.messages.find((item) => item.type === "error" && item.code === "stale_turn"));
    assert.match(stale.message, /inactive turn/i);
    app.socket.send(JSON.stringify({ type: "tts.segment", turnId: "turn-new", replyId: "new", segmentId: "new-1", sequence: 1, text: "Current.", boundary: "strong" }));
    app.socket.send(JSON.stringify({ type: "tts.reply.commit", turnId: "turn-new", replyId: "new", segmentCount: 1 }));
    await waitFor(() => app.messages.find((item) => item.type === "tts.reply.completed" && item.turnId === "turn-new"));
    assert.equal(app.messages.filter((item) => item.binary).length, 1);
  } finally {
    await app.close();
  }
});

test("Qwen accepts persistent text without claiming native bistream decoding", async () => {
  const app = await fixture({ runtime: { ttsProvider: "qwen3-tts-stream-local" }, featureFlags: { persistentTtsSession: true, trueBistream: false } });
  try {
    app.socket.send(JSON.stringify({ type: "session.start", profileId: "profile-1" }));
    const ready = await waitFor(() => app.messages.find(item => item.type === "session.ready"));
    assert.equal(ready.protocolVersion, 5);
    assert.equal(ready.features.trueBistream, false);
    app.socket.send(JSON.stringify({ type: "tts.reply.start", turnId: "qwen-turn", replyId: "qwen-reply" }));
    app.socket.send(JSON.stringify({ type: "tts.text.append", turnId: "qwen-turn", commitSeq: 1, text: "完整句子也可以连续播放。" }));
    app.socket.send(JSON.stringify({ type: "tts.input.finish", turnId: "qwen-turn", commitSeq: 1 }));
    await waitFor(() => app.messages.find(item => item.type === "tts.text.accepted"));
    await waitFor(() => app.messages.find(item => item.binary));
    const completed = await waitFor(() => app.messages.find(item => item.type === "tts.reply.completed"));
    assert.equal(completed.segmentCount, 1);
  } finally { await app.close(); }
});

test("v3 text controls translate one committed answer into a v4 segment", async () => {
  const app = await fixture();
  try {
    app.socket.send(JSON.stringify({ type: "session.start", profileId: "profile-1" }));
    await waitFor(() => app.messages.find((item) => item.type === "session.ready"));
    app.socket.send(JSON.stringify({ type: "tts.start", turnId: "legacy-turn" }));
    app.socket.send(JSON.stringify({ type: "text.append", turnId: "legacy-turn", text: "**Legacy** [link](https://example.com) remains compatible." }));
    app.socket.send(JSON.stringify({ type: "text.commit", turnId: "legacy-turn" }));
    await waitFor(() => app.messages.find((item) => item.type === "tts.reply.completed" && item.turnId === "legacy-turn"));
    assert.equal(app.messages.filter((item) => item.binary).length, 1);
  } finally {
    await app.close();
  }
});

test("v4 enforces ordered bounded queueing", async () => {
  const app = await fixture();
  try {
    app.socket.send(JSON.stringify({ type: "session.start", profileId: "profile-1" }));
    await waitFor(() => app.messages.find((item) => item.type === "session.ready"));
    app.socket.send(JSON.stringify({ type: "tts.reply.start", turnId: "queue-turn", replyId: "queue-reply" }));
    app.socket.send(JSON.stringify({ type: "tts.segment", turnId: "queue-turn", replyId: "queue-reply", segmentId: "out-of-order", sequence: 2, text: "Second.", boundary: "strong" }));
    const error = await waitFor(() => app.messages.find((item) => item.type === "error" && item.code === "segment_out_of_order"));
    assert.match(error.message, /sequence/i);
  } finally {
    await app.close();
  }
});

test("v4 rejects a fourth unsynthesized segment with backpressure", async () => {
  const app = await fixture();
  try {
    app.socket.send(JSON.stringify({ type: "session.start", profileId: "profile-1" }));
    await waitFor(() => app.messages.find((item) => item.type === "session.ready"));
    app.socket.send(JSON.stringify({ type: "tts.reply.start", turnId: "bounded-turn", replyId: "bounded-reply" }));
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      app.socket.send(JSON.stringify({
        type: "tts.segment", turnId: "bounded-turn", replyId: "bounded-reply",
        segmentId: `bounded-${sequence}`, sequence, text: `Segment ${sequence}.`, boundary: "strong"
      }));
    }
    const error = await waitFor(() => app.messages.find((item) => item.type === "error" && item.code === "tts_segment_backpressure"));
    assert.equal(error.details.queueDepth, 3);
  } finally {
    await app.close();
  }
});

test("microphone binary input produces one authoritative final transcript", async () => {
  const app = await fixture();
  try {
    app.socket.send(JSON.stringify({ type: "session.start", profileId: "profile-1" }));
    await waitFor(() => app.messages.find((item) => item.type === "session.ready"));
    app.socket.send(JSON.stringify({ type: "input.start", turnId: "input-1" }));
    app.socket.send(Buffer.alloc(640));
    app.socket.send(JSON.stringify({ type: "input.stop", turnId: "input-1" }));
    const ended = await waitFor(() => app.messages.find((item) => item.type === "input.ended"));
    const transcript = await waitFor(() => app.messages.find((item) => item.type === "transcript.final"));
    assert.equal(ended.turnId, "input-1");
    assert.equal(transcript.turnId, "input-1");
    assert.equal(transcript.language, "en");
    assert.equal(app.messages.filter((item) => item.type === "transcript.final").length, 1);
    assert.ok(app.messages.indexOf(ended) < app.messages.indexOf(transcript));
  } finally {
    await app.close();
  }
});

test("duplicate profile warm-ups share one worker request", async () => {
  const app = await fixture();
  try {
    const profile = {
      id: "profile-warm",
      conversationModel: { state: "ready", speakerPromptId: "prompt-1", referenceAudioPath: "fixture.wav", referenceTranscript: "fixture" }
    };
    const [first, second, third] = await Promise.all([
      app.service.warmProfile(profile),
      app.service.warmProfile(profile),
      app.service.warmProfile(profile)
    ]);
    assert.strictEqual(first, second);
    assert.strictEqual(second, third);
    const later = await app.service.warmProfile(profile);
    assert.notStrictEqual(later, first);
  } finally {
    await app.close();
  }
});

test("opt-in v2 trace records a reply timeline without text or PCM payloads", async () => {
  const artifactsRoot = path.resolve("artifacts");
  await fs.mkdir(artifactsRoot, { recursive: true });
  const traceRoot = await fs.mkdtemp(path.join(artifactsRoot, "voice-trace-test-"));
  const app = await fixture({ featureFlags: { traceV2: true, statefulResampler: true }, traceRoot });
  try {
    app.socket.send(JSON.stringify({ type: "session.start", profileId: "profile-1" }));
    const sessionReady = await waitFor(() => app.messages.find((item) => item.type === "session.ready"));
    assert.equal(sessionReady.features.traceV2, true);
    assert.equal(sessionReady.features.statefulResampler, true);
    app.socket.send(JSON.stringify({ type: "tts.reply.start", turnId: "trace-turn", replyId: "trace-reply" }));
    app.socket.send(JSON.stringify({ type: "tts.segment", turnId: "trace-turn", replyId: "trace-reply", sequence: 1, text: "PRIVATE_TRACE_CANARY", boundary: "final" }));
    app.socket.send(JSON.stringify({ type: "tts.reply.commit", turnId: "trace-turn", replyId: "trace-reply", segmentCount: 1 }));
    await waitFor(() => app.messages.find((item) => item.type === "tts.reply.completed" && item.turnId === "trace-turn"));
  } finally {
    await app.close();
  }
  try {
    const runDirs = await fs.readdir(traceRoot);
    const tracePath = path.join(traceRoot, runDirs[0], "trace-reply.jsonl");
    const traceText = await fs.readFile(tracePath, "utf8");
    const summary = JSON.parse(await fs.readFile(path.join(traceRoot, runDirs[0], "summary.json"), "utf8"));
    assert.match(traceText, /"event":"tts\.first_pcm"/u);
    assert.match(traceText, /"event":"tts\.session_finished"/u);
    assert.doesNotMatch(traceText, /PRIVATE_TRACE_CANARY/u);
    assert.doesNotMatch(traceText, /"pcm":/u);
    assert.equal(summary.privacy, "metrics-only");
    assert.ok(summary.eventCounts["tts.audio_chunk"] >= 1);
  } finally {
    await fs.rm(traceRoot, { recursive: true, force: true });
  }
});
