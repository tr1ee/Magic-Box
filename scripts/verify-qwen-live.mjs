import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { WebSocket } from "ws";
import { decodeAudioFrame } from "../server/live_voice.mjs";
import { coalesceSpeechSegments, splitSpeechSegments } from "../shared/speech-planner.mjs";

const base = process.argv[2] || "http://127.0.0.1:3101";
const profileId = "voice-profile-1784636071044-034d62";
const events = [], frames = [];
const socket = new WebSocket(base.replace(/^http/, "ws") + "/api/assistant/live-voice");
socket.on("message", (data, binary) => {
  if (binary) frames.push({ at: performance.now(), ...decodeAudioFrame(data) });
  else {
    const event = { at: performance.now(), ...JSON.parse(String(data)) };
    events.push(event);
    if (["session.ready", "error", "tts.reply.ready", "tts.text.accepted"].includes(event.type)) console.log(JSON.stringify(event));
  }
});
const send = (value) => socket.send(JSON.stringify(value));
async function until(predicate, timeout = 120000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out: " + JSON.stringify(events.slice(-4)));
}
const report = { scope: "real local Qwen 1.7B WebSocket, simulated consumption, CPU ASR, resident dialogue model", cases: [], cancellations: [] };
const out = "artifacts/qwen-live-verification.json";
const save = () => fs.writeFile(out, JSON.stringify(report, null, 2));
let timer;
try {
  await until(() => socket.readyState === WebSocket.OPEN);
  send({ type: "session.start", profileId });
  const ready = await until(() => events.find(e => e.type === "session.ready"));
  assert.equal(ready.tts.engine, "qwen3-tts-stream-local");
  assert.equal(ready.protocolVersion, 5);
  report.runtime = ready.tts;
  async function run(text, label, paced = false) {
    const turnId = `qwen-verify-${label}-${Date.now()}`, begin = performance.now(), start = frames.length;
    send({ type: "tts.reply.start", turnId, replyId: turnId, profileId, playbackPaced: paced });
    let playedMs = 0, last = performance.now(), firstAt = 0, generatedMs = 0, leadMax = 0;
    timer = setInterval(() => {
      const current = frames.slice(start);
      generatedMs = current.reduce((sum, f) => sum + f.pcm.length / 48, 0);
      firstAt ||= current[0]?.at || 0;
      const now = performance.now();
      if (firstAt && now > firstAt + 400) playedMs = Math.min(generatedMs, playedMs + now - last);
      last = now;
      leadMax = Math.max(leadMax, generatedMs - playedMs);
      if (paced) send({ type: "playback.progress", turnId, playedMs });
    }, 100);
    try {
      const segments = coalesceSpeechSegments(splitSpeechSegments(text, { final: true }));
      for (let i = 0; i < segments.length; i++) {
        send({ type: "tts.text.append", turnId, replyId: turnId, commitSeq: i + 1, sequence: i + 1, text: segments[i].text });
        await until(() => events.find(e => e.type === "tts.text.accepted" && e.turnId === turnId && e.commitSeq === i + 1));
      }
      send({ type: "tts.input.finish", turnId });
      const done = await until(() => {
        const failure = events.find(e => e.type === "error" && e.turnId === turnId);
        if (failure) throw new Error(JSON.stringify(failure));
        return events.find(e => e.type === "tts.reply.completed" && e.turnId === turnId);
      });
      const audio = frames.slice(start), pcm = Buffer.concat(audio.map(f => f.pcm));
      let end = audio[0].at + 400, starvation = 0;
      for (const frame of audio) { starvation += Math.max(0, frame.at - end); end = Math.max(end, frame.at) + frame.pcm.length / 48; }
      const result = { label, firstAudioMs: Math.round(audio[0].at - begin), generationMs: Math.round(done.at - begin), audioMs: pcm.length / 48, acousticPassages: done.passageCount, inferenceIds: done.inferenceIds, scheduler: done.acousticScheduler, simulatedStarvationMs: Math.round(starvation), maxPrefetchMs: Math.round(leadMax) };
      assert.ok(pcm.length > 0);
      assert.equal(done.orphanWorkCount, 0);
      assert.equal(done.inferenceIds.length, done.passageCount);
      report.cases.push(result); await save(); console.log(JSON.stringify(result));
      return pcm;
    } finally { clearInterval(timer); }
  }
  const text = "清晨的窗外传来几声鸟鸣，桌上的茶还冒着热气。我想用清晰、自然的声音，把这段文字完整地读给你听。";
  const pcm = await run(text, "short");
  await fs.writeFile("artifacts/qwen-live-short.pcm", pcm);
  await run((text + "接下来，我们检查语音是否连贯。请注意每句话的开头、结尾，还有声音里的轻重变化和停顿。").repeat(2), "paced-long", true);
  for (let i = 0; i < 5; i++) {
    const turnId = `qwen-cancel-${Date.now()}`;
    send({ type: "tts.reply.start", turnId, replyId: turnId, profileId });
    send({ type: "tts.text.append", turnId, commitSeq: 1, sequence: 1, text });
    await new Promise(resolve => setTimeout(resolve, 350 + i * 80));
    const at = performance.now();
    send({ type: "turn.cancel", turnId });
    const ack = await until(() => events.find(e => e.turnId === turnId && e.type === "turn.cancelled"));
    const stop = await until(() => events.find(e => e.turnId === turnId && ["tts.cancel.quiesced", "runtime.restart.required"].includes(e.type)));
    assert.equal(stop.type, "tts.cancel.quiesced");
    assert.ok(stop.at - at < 700);
    report.cancellations.push({ acknowledgementMs: Math.round(ack.at - at), quiescenceMs: Math.round(stop.at - at) });
    await save();
  }
  await run("你好，停止后可以重新开始朗读。", "restart");
  const turnId = `qwen-asr-${Date.now()}`;
  send({ type: "input.start", turnId });
  const source = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  const input = Buffer.alloc(Math.floor(source.length * 2 / 3) * 2 + 6400);
  for (let i = 0; i < Math.floor(source.length * 2 / 3); i++) input.writeInt16LE(source[Math.floor(i * 1.5)], i * 2);
  for (let i = 0; i < input.length; i += 32000) socket.send(input.subarray(i, i + 32000));
  const asrStart = performance.now(); send({ type: "input.stop", turnId });
  const transcript = await until(() => events.find(e => e.type === "transcript.final" && e.turnId === turnId));
  assert.ok(transcript.text?.includes("清晨"));
  report.asr = { text: transcript.text, finalizationMs: Math.round(transcript.at - asrStart) }; await save();
  const response = await fetch(base + "/api/assistant/chat-stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: crypto.randomUUID(), message: "请用两句简短的中文给我一个专心工作的小建议。", onlineSearch: "off", resourceProfile: "voice" }) });
  assert.equal(response.status, 200);
  const lines = (await response.text()).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const failure = lines.find(e => e.type === "error"); assert.ok(!failure, JSON.stringify(failure));
  const answer = lines.filter(e => e.type === "answer.delta").map(e => e.delta).join("");
  assert.ok(answer.length > 0);
  report.dialogueText = answer;
  await run(answer, "dialogue-model-resident");
  report.status = "passed";
  await save();
} catch (error) {
  report.status = "failed"; report.error = error.stack; report.recentEvents = events.slice(-5); await save(); throw error;
} finally {
  clearInterval(timer);
  socket.close();
}
