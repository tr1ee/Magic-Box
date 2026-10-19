import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const command = process.env.MAGIC_BOX_COLD_START_COMMAND;
const executable = process.env.MAGIC_BOX_COLD_START_EXECUTABLE || "";
const executableArgs = JSON.parse(process.env.MAGIC_BOX_COLD_START_ARGS || "[]");
const executableCwd = process.env.MAGIC_BOX_COLD_START_CWD || process.cwd();
const executableEnv = JSON.parse(process.env.MAGIC_BOX_COLD_START_ENV_JSON || "{}");
const baseUrl = process.env.MAGIC_BOX_COLD_START_URL || process.argv[2];
const runs = Math.max(1, Math.min(5, Number(process.env.MAGIC_BOX_COLD_START_RUNS || 5) || 5));
const output = process.env.MAGIC_BOX_COLD_START_OUTPUT || "artifacts/voice-preference-cold-start.json";
const seedMode = process.env.MAGIC_BOX_COLD_START_SEED_MODE || "";
const seedProfileId = process.env.MAGIC_BOX_COLD_START_SEED_PROFILE || "";
if ((!command && !executable) || !baseUrl) {
  console.error("Set MAGIC_BOX_COLD_START_EXECUTABLE plus optional args/env, or MAGIC_BOX_COLD_START_COMMAND, and pass the packaged server URL.");
  process.exit(2);
}

async function waitForPreferences(timeoutMs = 180000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetch(new URL("/api/assistant/preferences/voice", baseUrl));
      if (response.ok) return { payload: await response.json(), elapsedMs: Math.round(performance.now() - started) };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Packaged server did not expose voice preferences before timeout.");
}

const results = [];
for (let index = 0; index < runs; index += 1) {
  const started = performance.now();
  const child = executable
    ? spawn(executable, executableArgs, { cwd: executableCwd, env: { ...process.env, ...executableEnv }, windowsHide: true, stdio: "ignore" })
    : spawn(command, { shell: true, windowsHide: true, stdio: "ignore" });
  try {
    const ready = await waitForPreferences();
    let payload = ready.payload;
    if (index === 0 && seedMode) {
      const response = await fetch(new URL("/api/assistant/preferences/voice", baseUrl), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestedMode: seedMode, requestedProfileId: seedProfileId, mode: seedMode, profileId: seedProfileId }) });
      if (!response.ok) throw new Error(`Preference seed failed with HTTP ${response.status}.`);
      payload = await response.json();
    }
    results.push({ run: index + 1, startupToPreferenceMs: Math.round(performance.now() - started), apiWaitMs: ready.elapsedMs, requestedMode: payload.requestedMode, requestedProfileId: payload.requestedProfileId, effectiveMode: payload.effectiveMode, effectiveProfileId: payload.effectiveProfileId, revision: payload.revision });
  } finally {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1500))
    ]);
    if (process.platform === "win32" && child.pid) {
      await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
}
const sorted = results.map((result) => result.startupToPreferenceMs).sort((a, b) => a - b);
const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), runs: results, p95StartupToPreferenceMs: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] || 0, requestedPreferenceStable: results.every((result) => result.requestedMode === results[0]?.requestedMode && result.requestedProfileId === results[0]?.requestedProfileId), notes: ["This gate launches the packaged executable or command for every run; it does not use a warm in-process server."] };
await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
await fs.writeFile(path.resolve(output), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
if (results.length !== runs || !report.requestedPreferenceStable) process.exitCode = 1;
