import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { VtvEngineError } from "./engine-errors.mjs";

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      const directKillFallback = setTimeout(() => {
        try { child.kill(); } catch {}
      }, 750);
      directKillFallback.unref?.();
      killer.once("close", () => {
        clearTimeout(directKillFallback);
        try { child.kill(); } catch {}
      });
      killer.unref?.();
    } catch {
      try { child.kill(); } catch {}
    }
  } else {
    try { child.kill("SIGTERM"); } catch {}
  }
}

export function createEngineWorkerManager({ engineId, executable, workerEntry, cwd, env = {}, logPath = "", requestTimeoutMs = 30 * 60 * 1000 } = {}) {
  let child = null;
  let lineReader = null;
  let sequence = 0;
  const pending = new Map();

  async function ensureLog() {
    if (!logPath) return;
    await fs.mkdir(path.dirname(logPath), { recursive: true });
  }

  function rejectAll(error) {
    for (const item of pending.values()) {
      item.cleanup();
      item.reject(error);
    }
    pending.clear();
  }

  async function start() {
    if (child && !child.killed) return;
    if (!executable || !workerEntry) throw new VtvEngineError("ENGINE_NOT_INSTALLED", `${engineId} worker runtime is not configured.`, { engineId, action: "Install the pinned engine runtime." });
    await ensureLog();
    const logStream = logPath ? (await import("node:fs")).createWriteStream(logPath, { flags: "a" }) : null;
    child = spawn(executable, [workerEntry], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env, PYTHONNOUSERSITE: "1", PYTHONUTF8: "1" } });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => logStream?.write(chunk));
    child.on("error", (error) => rejectAll(new VtvEngineError("ENGINE_WORKER_START_FAILED", error.message, { engineId, cause: error })));
    child.on("exit", (code, signal) => {
      logStream?.end();
      const error = new VtvEngineError("ENGINE_WORKER_PROTOCOL_ERROR", `${engineId} worker exited (${code ?? "unknown"}/${signal || "none"}).`, { engineId });
      rejectAll(error);
      child = null;
      lineReader?.close();
      lineReader = null;
    });
    lineReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lineReader.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch {
        const error = new VtvEngineError("ENGINE_WORKER_PROTOCOL_ERROR", `${engineId} worker wrote non-JSON stdout.`, { engineId });
        rejectAll(error);
        terminateProcessTree(child);
        return;
      }
      const requestId = String(message.requestId || "");
      const item = pending.get(requestId);
      if (!item) return;
      if (message.event === "progress") {
        item.refreshTimeout();
        item.onProgress?.(message);
        return;
      }
      pending.delete(requestId);
      item.cleanup();
      if (message.ok === false) item.reject(new VtvEngineError(message.code || "ENGINE_WORKER_PROTOCOL_ERROR", message.message || "Engine worker request failed.", { engineId, action: message.action || "", details: message.details || null }));
      else item.resolve(message);
    });
  }

  return {
    async start() { await start(); return { pid: child?.pid || null, engineId }; },
    async request(command, { signal = null, onProgress = null, timeoutMs = requestTimeoutMs } = {}) {
      await start();
      if (signal?.aborted) throw new VtvEngineError("ENGINE_CANCELLED", "Engine worker request was cancelled.", { engineId });
      const requestId = `${engineId}-${++sequence}`;
      return new Promise((resolve, reject) => {
        let timer = null;
        const handleAbort = () => {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          item.cleanup();
          reject(new VtvEngineError("ENGINE_CANCELLED", "Engine worker request was cancelled.", { engineId }));
          terminateProcessTree(child);
        };
        const item = {
          resolve,
          reject,
          onProgress,
          refreshTimeout() {
            clearTimeout(timer);
            timer = setTimeout(() => {
              pending.delete(requestId);
              const error = new VtvEngineError("ENGINE_TIMEOUT", `${engineId} worker stopped reporting progress for ${Math.ceil(timeoutMs / 1000)} seconds.`, {
                engineId,
                action: "Check GPU availability and the isolated engine worker log.",
                details: { command: String(command?.command || ""), inactivityTimeoutMs: timeoutMs }
              });
              item.cleanup();
              reject(error);
              terminateProcessTree(child);
            }, timeoutMs);
            timer.unref?.();
          },
          cleanup() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", handleAbort);
          }
        };
        pending.set(requestId, item);
        item.refreshTimeout();
        child.stdin.write(`${JSON.stringify({ ...command, requestId })}\n`);
        signal?.addEventListener("abort", handleAbort, { once: true });
      });
    },
    async stop() {
      if (!child) return;
      try { child.stdin.write(`${JSON.stringify({ requestId: `${engineId}-${++sequence}`, command: "shutdown" })}\n`); } catch {}
      await new Promise((resolve) => { const current = child; const timer = setTimeout(() => { terminateProcessTree(current); resolve(); }, 3000); current.once("exit", () => { clearTimeout(timer); resolve(); }); });
      child = null;
    },
    snapshot() { return { engineId, pid: child?.pid || null, pending: pending.size, running: Boolean(child) }; }
  };
}
