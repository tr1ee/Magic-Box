import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const url = option("--url", "http://127.0.0.1:3099");
const text = option("--text", "你好小鸟，我叫小爱！是树神的私人助理！你的名字叫做simple");
const profileId = option("--profile-id", "voice-profile-1787531284835-22d3cc");
const outputDir = path.resolve(option("--output-dir", "artifacts/ttv-strict-reproduction"));
await fs.mkdir(outputDir, { recursive: true });
const request = { profileId, text, language: "auto", outputDir, settings: {
  speed: 1, pitch: 0, styleStrength: 0.7, qualityMode: "strict", refinementMode: "auto", copyStyle: false,
  gptCandidateCount: 3, seedCandidateCount: 3
} };
const submittedResponse = await fetch(`${url}/api/voice-clone/tts`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request)
});
const submitted = await submittedResponse.json();
if (!submittedResponse.ok) throw new Error(JSON.stringify(submitted));
console.log(JSON.stringify({ jobId: submitted.id }));
let lastMessage = "";
let terminal = false;
const started = Date.now();
while (Date.now() - started < 20 * 60 * 1000) {
  const response = await fetch(`${url}/api/voice-clone/jobs/${submitted.id}`);
  if (!response.ok) throw new Error(`Job poll failed: ${response.status}`);
  const job = await response.json();
  if (job.message !== lastMessage) {
    console.log(JSON.stringify({ status: job.status, message: job.message, elapsedSec: (Date.now() - started) / 1000 }));
    lastMessage = job.message;
  }
  if (["completed", "failed", "cancelled"].includes(job.status)) {
    terminal = true;
    await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify({ request, elapsedSec: (Date.now() - started) / 1000, job }, null, 2));
    console.log(JSON.stringify({ status: job.status, error: job.error, outputId: job.result?.output?.id }));
    process.exitCode = job.status === "completed" ? 0 : 1;
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 1500));
}
if (!terminal) throw new Error(`Timed out waiting for ${submitted.id}; the job may still be running. Inspect it before starting another reproduction.`);
