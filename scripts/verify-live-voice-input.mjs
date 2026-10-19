import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { WebSocket } from "ws";
import { createLiveVoiceService } from "../server/live_voice.mjs";

const outputPath = process.env.MAGIC_BOX_LIVE_VOICE_INPUT_GATE || "artifacts/voice-poc-run2/input-feature-gate.json";
const server = http.createServer((_request, response) => response.end("ok"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const service = createLiveVoiceService({
  server,
  fake: true,
  featureFlags: { persistentTtsSession: true, partialAsr: true, bargeIn: true, statefulResampler: true, binaryWorkerIpc: true },
  getHealth: async () => ({ available: true, tts: { status: "ready" }, asr: { status: "ready" } }),
  getProfile: async (profileId) => ({
    id: profileId,
    conversationModel: { state: "ready", referenceAudioPath: "fixture.wav", referenceTranscript: "fixture" }
  }),
  workerCommand: () => ({ command: process.execPath, args: [] })
});

const { port } = server.address();
const socket = new WebSocket(`ws://127.0.0.1:${port}/api/assistant/live-voice`);
const events = [];
socket.on("message", (data, isBinary) => events.push(isBinary ? { type: "audio.binary", bytes: data.length } : JSON.parse(String(data))));
const waitFor = async (predicate, timeoutMs = 2_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for live voice input gate event.");
};

try {
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "session.start", profileId: "input-gate-profile" }));
  const ready = await waitFor(() => events.find((event) => event.type === "session.ready"));

  socket.send(JSON.stringify({ type: "tts.reply.start", turnId: "barge-turn", replyId: "barge-reply" }));
  await waitFor(() => events.find((event) => event.type === "tts.reply.ready"));
  socket.send(JSON.stringify({ type: "tts.text.append", turnId: "barge-turn", replyId: "barge-reply", commitSeq: 1, text: "正在说话。" }));
  await waitFor(() => events.find((event) => event.type === "audio.binary"));
  socket.send(JSON.stringify({ type: "turn.cancel", turnId: "barge-turn", reason: "barge-in" }));
  const cancelled = await waitFor(() => events.find((event) => event.type === "tts.cancel.quiesced"));

  socket.send(JSON.stringify({ type: "input.start", turnId: "input-gate-turn" }));
  socket.send(Buffer.alloc(640));
  socket.send(JSON.stringify({ type: "input.stop", turnId: "input-gate-turn" }));
  const finalTranscript = await waitFor(() => events.find((event) => event.type === "transcript.final"));

  const artifact = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    fakeRuntime: true,
    negotiated: {
      protocolVersion: ready.protocolVersion,
      schedulerMode: ready.schedulerMode,
      features: ready.features
    },
    bargeInCancellation: {
      turnId: cancelled.turnId,
      quiescenceMs: cancelled.cancellationQuiescenceMs,
      orphanWorkCount: cancelled.orphanWorkCount
    },
    input: {
      finalTranscript: finalTranscript.text,
      finalCount: events.filter((event) => event.type === "transcript.final").length
    },
    pass: ready.protocolVersion === 5
      && ready.features?.partialAsr === true
      && ready.features?.bargeIn === true
      && cancelled.orphanWorkCount === 0
      && finalTranscript.text === "Microphone input received."
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact));
} finally {
  socket.close();
  await service.close();
  await new Promise((resolve) => server.close(resolve));
}
