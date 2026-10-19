import { spawn } from "node:child_process";
import path from "node:path";

const mode = process.argv[2] || "hot";
if (!["hot", "cold", "device"].includes(mode)) throw new Error("Benchmark mode must be hot, cold, or device.");
const output = process.argv[3] || path.join("artifacts", `live-voice-benchmark-${mode}.json`);
const baseUrl = process.argv[4] || process.env.MAGIC_BOX_URL || "";
const profileId = process.argv[5] || process.env.MAGIC_BOX_VOICE_PROFILE_ID || "";
const child = spawn(process.execPath, [path.join("scripts", "benchmark-live-voice.mjs"), baseUrl, profileId, output], {
  stdio: "inherit",
  env: { ...process.env, VOICE_BENCHMARK_MODE: mode, VOICE_BENCHMARK_PROTOCOL: "5", MAGIC_BOX_LIVE_VOICE_BENCHMARK: output }
});
child.once("exit", (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
