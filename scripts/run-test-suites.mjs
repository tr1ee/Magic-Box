import { spawn } from "node:child_process";
import process from "node:process";
import { readdir } from "node:fs/promises";

const suites = [
  "test/package-storage.test.mjs",
  "test/format-factory.test.mjs",
  "test/assistant.test.mjs",
  "test/server.test.mjs",
  "test/voice-clone-routes.test.mjs",
  "test/voice-clone-pipeline-v2.test.mjs",
  "test/vtv-pipeline-v2.test.mjs",
  "test/vtv-abx.test.mjs",
  "test/vtv-corpus.test.mjs",
  "test/vtv-baseline.test.mjs",
  "test/vtv-runtime-pin.test.mjs",
  "test/vtv-temp-cleanup.test.mjs",
  "test/vtv-worker-lifecycle.test.mjs",
  "test/voice-clone-quality-policy.test.mjs",
  "test/voice-clone-gpu-scheduler.test.mjs",
  "test/voice-clone-artifact-migration.test.mjs",
  "test/voice-clone-sqlite-store.test.mjs",
  "test/live-voice.test.mjs",
  "test/speech-planner.test.mjs",
  "test/audio-worklet-resampler.test.mjs",
  "test/audio-ring-buffer.test.mjs"
];

// Retain the established order, but do not silently miss newly added regressions.
const discovered = (await readdir(new URL("../test/", import.meta.url)))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => `test/${name}`);
for (const suite of discovered) if (!suites.includes(suite)) suites.push(suite);

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", suite], {
      stdio: "inherit",
      windowsHide: true,
      cwd: process.cwd()
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (exitCode !== 0) {
    console.error(`Test suite failed: ${suite} (exit ${exitCode})`);
    process.exitCode = exitCode;
    break;
  }
}
