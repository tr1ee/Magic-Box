import { WebSocket } from "ws";
import fs from "node:fs";

const ws = new WebSocket("ws://127.0.0.1:3099/api/assistant/live-voice");
const started = Date.now();
let ready = false;
let audio = 0;
let accepted = 0;
let finished = false;
const finish = (code = 0) => {
  if (finished) return;
  finished = true;
  const result = { ready, accepted, audio, elapsedMs: Date.now() - started };
  fs.writeFileSync("artifacts/voice-poc-run2/v5-binary-smoke.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  ws.close();
  process.exit(code);
};
ws.on("open", () => ws.send(JSON.stringify({ type: "session.start", profileId: "voice-profile-1784636071044-034d62" })));
ws.on("message", (data, isBinary) => {
  if (isBinary) { audio += 1; return; }
  let message;
  try { message = JSON.parse(String(data)); } catch { return; }
  if (message.type === "session.ready") {
    ready = true;
    console.log(`READY ${message.protocolVersion} ${message.schedulerMode}`);
    ws.send(JSON.stringify({ type: "tts.reply.start", turnId: "smoke-turn", replyId: "smoke-reply" }));
    ws.send(JSON.stringify({ type: "tts.text.append", turnId: "smoke-turn", replyId: "smoke-reply", commitSeq: 1, text: "这是一次持久会话测试。" }));
    ws.send(JSON.stringify({ type: "tts.text.append", turnId: "smoke-turn", replyId: "smoke-reply", commitSeq: 2, text: "文本会连续进入同一个推理。" }));
    ws.send(JSON.stringify({ type: "tts.input.finish", turnId: "smoke-turn", replyId: "smoke-reply", commitSeq: 2 }));
  }
  if (message.type === "tts.text.accepted") accepted += 1;
  if (message.type === "tts.reply.completed") finish(0);
  if (message.type === "error") { console.error(message); finish(1); }
});
ws.on("error", (error) => { console.error(error); finish(1); });
setTimeout(() => finish(2), 180000);
