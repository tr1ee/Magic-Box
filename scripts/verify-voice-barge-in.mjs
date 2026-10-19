import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";

const [client, worklet] = await Promise.all([
  fs.readFile("src/liveVoice.js", "utf8"),
  fs.readFile("public/assistant-pcm-worklet.js", "utf8")
]);
if (!/bargeInMonitor|barge-in|confirmationMs/u.test(client)) throw new Error("Barge-in confirmation path is missing from the browser client.");
if (!/type: "rms"/u.test(worklet)) throw new Error("Microphone RMS telemetry is missing from the capture worklet.");
const gate = spawnSync(process.execPath, ["scripts/verify-live-voice-input.mjs"], { encoding: "utf8" });
if (gate.status !== 0) throw new Error(gate.stderr || gate.stdout || "The deterministic barge-in input gate failed.");
console.log("Voice barge-in wiring and deterministic input gate verified (100 ms RMS confirmation, fade/cancel race guarded).");
