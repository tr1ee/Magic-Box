import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assistantError, boundedText, isoNow, sendAssistantError } from "./utils.mjs";
import { createVoiceResourceScheduler } from "./voice-resource-scheduler.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(await fs.readFile(path.join(moduleDir, "model-catalog.json"), "utf8"));

async function fileSha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function fetchJson(url, options = {}, timeoutMs = 120_000) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...options, signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw assistantError("model_unhealthy", boundedText(payload?.error?.message || payload?.error || `Local model returned HTTP ${response.status}.`, 512), 503, true);
  }
  return payload;
}

async function fetchCompletionStream(url, options = {}, timeoutMs = 150_000, onToken) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...options, signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw assistantError("model_unhealthy", boundedText(payload?.error?.message || payload?.error || `Local model returned HTTP ${response.status}.`, 512), 503, true);
  }
  if (!response.body) throw assistantError("model_unhealthy", "The local model did not open a response stream.", 503, true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = {};
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : (lines.pop() || "");
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }
      const delta = payload?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        text += delta;
        onToken?.(delta);
      }
      if (payload?.usage) usage = payload.usage;
    }
    if (done) break;
  }
  return { text, usage };
}

export function createLocalModelRuntime({ manager, runtimeRoot, onRuntimeModeChange = () => {} } = {}) {
  const { store, core, router } = manager;
  const modelRoot = path.join(store.dataDir, "models");
  const stagingRoot = path.join(modelRoot, ".staging");
  const workers = new Map();
  const requestTails = new Map();
  const shutdownController = new AbortController();
  const runtimeDir = runtimeRoot || path.resolve(moduleDir, "..", "..", "vendor", "llama", catalog.runtime.version);
  const runtimeExecutable = path.join(runtimeDir, process.platform === "win32" ? "llama-server.exe" : "llama-server");
  let acceleratorDevicePromise;
  let runtimeState = "verifying";
  let warmActiveGenerationPromise = Promise.resolve();
  const voiceWorkerIdleMs = 10 * 60_000;
  const autoVoiceGpuLayers = process.env.VOICE_AUTO_GPU_LAYERS === "1";
  const requestedVoiceGpuLayers = Math.max(0, Number(process.env.VOICE_GPU_LAYERS || 0) || 0);
  const requestedTextGpuLayers = Math.max(0, Number(process.env.ASSISTANT_TEXT_GPU_LAYERS || 0) || 0);
  const voiceResourceScheduler = createVoiceResourceScheduler({
    stateDir: modelRoot,
    logger: (message) => core.log?.("info", message)
  });
  const setRuntimeMode = (mode, details = {}) => {
    voiceResourceScheduler.setRuntimeMode(mode, details);
    try { onRuntimeModeChange(mode, details); } catch {}
  };

  function runtimeWorkerKey(capability, resourceProfile = "default") {
    return capability === "generation" && resourceProfile === "voice" ? "generation:voice" : capability;
  }
  core.setCapability("models", "ready");
  fs.mkdir(stagingRoot, { recursive: true }).catch(() => {});

  async function verifyRuntime() {
    try {
      const entries = Object.entries(catalog.runtime.requiredFiles || {});
      if (!entries.length) throw new Error("Runtime file manifest is missing.");
      for (const [name, expected] of entries) {
        if (await fileSha256(path.join(runtimeDir, name)).catch(() => null) !== expected) throw new Error(`Runtime file failed verification: ${name}`);
      }
      runtimeState = "ready";
    } catch (error) {
      runtimeState = "invalid";
      throw assistantError("runtime_failed", "The bundled local AI runtime failed integrity verification. Rebuild or repair Magic Box.", 503);
    }
  }

  function detectAcceleratorDevice() {
    if (acceleratorDevicePromise) return acceleratorDevicePromise;
    acceleratorDevicePromise = new Promise((resolve) => {
      const child = spawn(runtimeExecutable, ["--list-devices"], { cwd: runtimeDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const capture = (chunk) => { output += chunk.toString("utf8"); };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const timer = setTimeout(() => child.kill(), 5_000);
      const finish = () => {
        clearTimeout(timer);
        const devices = output.split(/\r?\n/).map((line) => {
          const match = line.match(/^\s*(\S+):\s+(.+?)\s+\((\d+)\s+MiB/i);
          if (!match) return null;
          const name = match[2];
          const vendorScore = /nvidia|geforce|rtx/i.test(name) ? 3 : /amd|radeon/i.test(name) ? 2 : /intel/i.test(name) ? 1 : 0;
          return { id: match[1], name, memoryMiB: Number(match[3]), vendorScore };
        }).filter(Boolean).sort((left, right) => right.vendorScore - left.vendorScore || right.memoryMiB - left.memoryMiB);
        resolve(devices[0] || null);
      };
      child.once("exit", finish);
      child.once("error", () => { clearTimeout(timer); resolve(null); });
    });
    return acceleratorDevicePromise;
  }

  async function recoverInterruptedInstalls() {
    await verifyRuntime();
    await fs.mkdir(stagingRoot, { recursive: true });
    for (const row of store.db.prepare("SELECT * FROM models WHERE state='installing'").all()) {
      const model = catalog.models.find((entry) => entry.id === row.model_id && entry.capability === row.capability && entry.manifestRevision === row.manifest_revision);
      const stats = row.installed_path ? await fs.stat(row.installed_path).catch(() => null) : null;
      const valid = Boolean(model && stats?.isFile() && Number(stats.size) === Number(model.sizeBytes) && await fileSha256(row.installed_path).catch(() => null) === model.sha256);
      store.db.prepare("UPDATE models SET state=?,updated_at=? WHERE model_id=? AND capability=?").run(valid ? "ready" : "failed", isoNow(), row.model_id, row.capability);
      if (valid) await core.activity.append({ eventKey: `model:recovered:${row.model_id}:${row.manifest_revision}`, activityGeneration: core.activity.currentGeneration(), kind: "model", action: "model.install-recovered", status: "completed", summary: `${row.display_name} installation recovered after restart`, related: { modelId: row.model_id } });
    }
  }

  const recoveryPromise = recoverInterruptedInstalls();
  recoveryPromise.catch(() => {});

  function modelIdentity(model) {
    return `${model.id}@${model.manifestRevision}`;
  }

  function runtimeIdentity() {
    const row = installedRow("generation");
    if (!row || row.state !== "ready") return null;
    const model = catalog.models.find((entry) => entry.id === row.model_id
      && entry.capability === "generation"
      && entry.manifestRevision === row.manifest_revision);
    if (!model) return null;
    return {
      id: model.id,
      displayName: model.displayName,
      manifestRevision: model.manifestRevision,
      identity: modelIdentity(model),
      capability: model.capability
    };
  }

  function catalogModel(modelId, capability) {
    const model = catalog.models.find((entry) => entry.id === modelId && (!capability || entry.capability === capability));
    if (!model) throw assistantError("model_not_found", "The selected model is not in the local catalog.", 404);
    return model;
  }

  async function resolveInstalledModelPath(row, model) {
    const canonicalPath = path.join(modelRoot, model.id, model.manifestRevision, model.filename);
    const candidates = [...new Set([row?.installed_path, canonicalPath].filter(Boolean).map((entry) => path.resolve(entry)))];
    for (const candidate of candidates) {
      const stats = await fs.stat(candidate).catch(() => null);
      if (!stats?.isFile() || Number(stats.size) !== Number(model.sizeBytes)) continue;
      if (await fileSha256(candidate).catch(() => null) !== model.sha256) continue;
      if (candidate !== row.installed_path) {
        store.db.prepare("UPDATE models SET installed_path=?,size_bytes=?,sha256=?,updated_at=? WHERE model_id=? AND capability=?")
          .run(candidate, model.sizeBytes, model.sha256, isoNow(), row.model_id, row.capability);
        row.installed_path = candidate;
      }
      return candidate;
    }
    return null;
  }

  function installedRow(capability) {
    return store.db.prepare("SELECT * FROM models WHERE capability=? AND active=1").get(capability);
  }

  function serializeCatalogModel(model) {
    const row = store.db.prepare("SELECT * FROM models WHERE model_id=? AND capability=?").get(model.id, model.capability);
    return {
      id: model.id,
      manifestRevision: model.manifestRevision,
      displayName: model.displayName,
      capability: model.capability,
      source: model.sourcePage,
      version: model.manifestRevision,
      sizeBytes: model.sizeBytes,
      sha256: model.sha256,
      license: model.license,
      memory: model.memory,
      compatibility: { platforms: ["win32-x64"], runtimeVersion: catalog.runtime.version },
      acceleration: model.gpuLayers ? "GPU preferred, CPU fallback" : "CPU",
      installState: row?.state || "not-installed",
      active: Boolean(row?.active),
      installedAt: row?.created_at || null,
      error: row?.state === "failed" ? "model_unhealthy" : null
    };
  }

  function status() {
    const generation = installedRow("generation");
    const embeddings = installedRow("embeddings");
    const stateFor = (capability, active) => {
      if (active?.state === "ready") return "ready";
      const installing = store.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='model-install' AND status IN ('queued','running') AND result_json LIKE ?").get(`%${capability}%`);
      if (Number(installing?.count || 0)) return "installing";
      const installed = Number(store.db.prepare("SELECT COUNT(*) AS count FROM models WHERE capability=? AND state='ready'").get(capability).count);
      return installed ? "installed-inactive" : "not-installed";
    };
    return {
      runtime: runtimeState,
      generation: stateFor("generation", generation),
      embeddings: stateFor("embeddings", embeddings),
      activeModels: {
        ...(generation ? { generation: `${generation.model_id}@${generation.manifest_revision}` } : {}),
        ...(embeddings ? { embeddings: `${embeddings.model_id}@${embeddings.manifest_revision}` } : {})
      },
      runtimeVersion: catalog.runtime.version,
      voiceResourceScheduler: voiceResourceScheduler.status()
    };
  }

  function hostAllowed(url, allowedHosts) {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (allowedHosts || []).some((entry) => entry.startsWith(".") ? parsed.hostname.endsWith(entry) : parsed.hostname === entry);
  }

  async function fetchReviewed(url, model, options) {
    let current = url;
    for (let count = 0; count <= 5; count += 1) {
      if (!hostAllowed(current, model.allowedDownloadHosts)) throw assistantError("model_download_failed", "A model download redirect left the reviewed host allowlist.", 409);
      const response = await fetch(current, { ...options, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) throw assistantError("model_download_failed", "A model download redirect was incomplete.", 503, true);
      current = new URL(location, current).href;
    }
    throw assistantError("model_download_failed", "The model download exceeded the redirect limit.", 503, true);
  }

  async function downloadModel(model, destination, { signal, report }) {
    const disk = await fs.statfs(modelRoot).catch(() => null);
    if (disk && Number(disk.bavail) * Number(disk.bsize) < model.sizeBytes * 1.15) {
      throw assistantError("insufficient_disk_space", "There is not enough free disk space for this model.", 409);
    }
    let existingSize = Number((await fs.stat(destination).catch(() => null))?.size || 0);
    if (existingSize > model.sizeBytes) { await fs.rm(destination, { force: true }); existingSize = 0; }
    if (existingSize === model.sizeBytes) {
      if (await fileSha256(destination) === model.sha256) {
        report({ progress: 90, stage: "downloading", message: "Using the complete verified model download" });
        return;
      }
      await fs.rm(destination, { force: true });
      existingSize = 0;
    }
    let response = await fetchReviewed(model.source, model, { signal, headers: existingSize ? { Range: `bytes=${existingSize}-` } : {} }).catch((error) => {
      throw assistantError("model_download_failed", `Model download failed: ${boundedText(error.message, 300)}`, 503, true);
    });
    if (existingSize && response.status !== 206) {
      await fs.rm(destination, { force: true });
      existingSize = 0;
      response = await fetchReviewed(model.source, model, { signal, headers: {} });
    }
    if (!response.ok || !response.body) throw assistantError("model_download_failed", `Model download returned HTTP ${response.status}.`, 503, true);
    if (existingSize) {
      const range = response.headers.get("content-range") || "";
      if (!range.startsWith(`bytes ${existingSize}-`)) throw assistantError("model_download_failed", "The model server returned an invalid resume range.", 409);
    }
    const total = Number(response.headers.get("content-length")) + existingSize || model.sizeBytes;
    if (total > model.sizeBytes + 1024) throw assistantError("model_download_failed", "The model download size does not match the reviewed manifest.", 409);
    const handle = await fs.open(destination, existingSize ? "a" : "wx");
    const hash = createHash("sha256");
    if (existingSize) for await (const chunk of createReadStream(destination)) hash.update(chunk);
    let received = existingSize;
    try {
      for await (const chunk of response.body) {
        if (signal.aborted) throw assistantError("model_install_cancelled", "Model installation was cancelled.", 409);
        received += chunk.length;
        if (received > model.sizeBytes + 1024) throw assistantError("model_download_failed", "The model download exceeded its reviewed size.", 409);
        hash.update(chunk);
        await handle.write(chunk);
        report({ progress: Math.min(90, Math.round(90 * received / model.sizeBytes)), stage: "downloading", message: `Downloaded ${Math.round(received / 1024 / 1024)} of ${Math.round(model.sizeBytes / 1024 / 1024)} MiB` });
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (received !== model.sizeBytes || hash.digest("hex") !== model.sha256) {
      throw assistantError("model_checksum_failed", "The downloaded model did not match its reviewed checksum.", 409);
    }
  }

  function install({ capability, modelId, manifestRevision, licenseAcceptance }) {
    const model = catalogModel(modelId, capability);
    if (manifestRevision !== model.manifestRevision) throw assistantError("manifest_changed", "The model manifest changed; review it again before installing.", 409);
    if (licenseAcceptance?.accepted !== true || licenseAcceptance?.licenseId !== model.license.id) {
      throw assistantError("license_not_accepted", "Accept the displayed model license before installing.", 409);
    }
    const existing = store.db.prepare("SELECT * FROM models WHERE model_id=? AND capability=?").get(model.id, model.capability);
    if (existing?.state === "ready") {
      return core.startJob({ type: "model-install", stage: "complete", message: "Model is already installed", cancellable: false, requested: 1, result: { modelId: model.id, capability: model.capability } }, async () => ({ modelId: model.id, capability: model.capability, alreadyInstalled: true, counts: { requested: 1, completed: 1, failed: 0, skipped: 0 } }));
    }
    if (existing?.state === "installing") throw assistantError("model_install_in_progress", "This model installation is already running.", 409);
    const targetDir = path.join(modelRoot, model.id, model.manifestRevision);
    const targetPath = path.join(targetDir, model.filename);
    const updatedAt = isoNow();
    store.db.prepare(`INSERT INTO models(model_id,capability,manifest_revision,display_name,state,active,license_id,installed_path,source_url,size_bytes,sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(model_id,capability) DO UPDATE SET manifest_revision=excluded.manifest_revision,display_name=excluded.display_name,state='installing',active=0,license_id=excluded.license_id,installed_path=excluded.installed_path,source_url=excluded.source_url,size_bytes=excluded.size_bytes,sha256=excluded.sha256,updated_at=excluded.updated_at`)
      .run(model.id, model.capability, model.manifestRevision, model.displayName, "installing", 0, model.license.id, targetPath, model.source, model.sizeBytes, model.sha256, updatedAt, updatedAt);
    return core.startJob({ type: "model-install", stage: "preparing", message: `Preparing ${model.displayName}`, cancellable: true, requested: 1, result: { modelId: model.id, capability: model.capability } }, async ({ signal, report }) => {
      await fs.mkdir(stagingRoot, { recursive: true });
      const stagingPath = path.join(stagingRoot, `${model.id}-${model.manifestRevision}.part`);
      const quarantinePath = `${targetPath}.replaced-${Date.now()}`;
      try {
        await downloadModel(model, stagingPath, { signal, report });
        report({ progress: 94, stage: "verifying", message: "Verifying local model package", cancellable: false });
        await fs.mkdir(targetDir, { recursive: true });
        if (await fs.stat(targetPath).catch(() => null)) await fs.rename(targetPath, quarantinePath);
        await fs.rename(stagingPath, targetPath);
        const installedAt = isoNow();
        store.db.prepare(`INSERT INTO models(model_id,capability,manifest_revision,display_name,state,active,license_id,installed_path,source_url,size_bytes,sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(model_id,capability) DO UPDATE SET manifest_revision=excluded.manifest_revision,display_name=excluded.display_name,state='ready',license_id=excluded.license_id,installed_path=excluded.installed_path,source_url=excluded.source_url,size_bytes=excluded.size_bytes,sha256=excluded.sha256,updated_at=excluded.updated_at`)
          .run(model.id, model.capability, model.manifestRevision, model.displayName, "ready", 0, model.license.id, targetPath, model.source, model.sizeBytes, model.sha256, installedAt, installedAt);
        await fs.rm(quarantinePath, { force: true }).catch(() => {});
        await core.activity.append({ kind: "model", action: "model.installed", status: "completed", summary: `${model.displayName} installed locally`, related: { modelId: model.id } });
        return { modelId: model.id, capability: model.capability, counts: { requested: 1, completed: 1, failed: 0, skipped: 0 } };
      } catch (error) {
        if (!["model_download_failed", "model_install_cancelled"].includes(error.code)) await fs.rm(stagingPath, { force: true }).catch(() => {});
        const targetStats = await fs.stat(targetPath).catch(() => null);
        const promoted = Boolean(targetStats?.isFile() && Number(targetStats.size) === Number(model.sizeBytes) && await fileSha256(targetPath).catch(() => null) === model.sha256);
        if (!promoted && !targetStats && await fs.stat(quarantinePath).catch(() => null)) await fs.rename(quarantinePath, targetPath).catch(() => {});
        store.db.prepare("UPDATE models SET state=?,updated_at=? WHERE model_id=? AND capability=?").run(promoted ? "installing" : "failed", isoNow(), model.id, model.capability);
        throw error;
      }
    });
  }

  async function stopWorker(worker) {
    if (!worker || worker.process.exitCode !== null) return;
    if (worker.idleTimer) clearTimeout(worker.idleTimer);
    if (process.platform === "win32") {
      await new Promise((resolve) => {
        const killer = spawn("taskkill.exe", ["/PID", String(worker.process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("exit", resolve);
        killer.once("error", () => { worker.process.kill(); resolve(); });
      });
    } else worker.process.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => worker.process.exitCode === null ? worker.process.once("exit", resolve) : resolve()),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
  }

  async function startWorker(row, model, signal, { workerKey = model.capability, forceCpu = false, gpuLayers = model.gpuLayers || 0 } = {}) {
    await recoveryPromise;
    if (runtimeState !== "ready") throw assistantError("runtime_failed", "The bundled local AI runtime failed integrity verification.", 503);
    const installedPath = await resolveInstalledModelPath(row, model);
    if (!installedPath) throw assistantError("model_unhealthy", "The installed model checksum is invalid. Repair it before use.", 503);
    const accelerator = !forceCpu && gpuLayers ? await detectAcceleratorDevice() : null;
    const launch = async (device) => {
      const port = await findOpenPort();
      const apiKey = randomBytes(24).toString("hex");
      const args = ["-m", installedPath, "--host", "127.0.0.1", "--port", String(port), "--api-key", apiKey, "--no-webui", "-c", String(model.contextTokens), "-np", "1"];
      if (device) args.push("--device", device.id, "-ngl", String(gpuLayers));
      else if (forceCpu || gpuLayers) args.push("-ngl", "0");
      if (model.capability === "embeddings") args.push("--embedding", "--pooling", "last", "-b", "2048", "-ub", "512");
      const child = spawn(runtimeExecutable, args, { cwd: runtimeDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const worker = { process: child, port, apiKey, model, workerKey, resourceProfile: workerKey === "generation:voice" ? "voice" : "default", accelerator: device?.name || null, gpuLayers: device ? gpuLayers : 0, logs: [], activeRequests: 0, idleTimer: null };
      const capture = (chunk) => {
        worker.logs.push(boundedText(chunk.toString("utf8"), 500));
        if (worker.logs.length > 20) worker.logs.shift();
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("exit", () => { if (workers.get(workerKey) === worker) workers.delete(workerKey); });
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (signal?.aborted) { child.kill(); throw assistantError("model_install_cancelled", "Local model startup was cancelled.", 409); }
        if (child.exitCode !== null) throw assistantError("model_unhealthy", `Local model runtime exited during startup. ${worker.logs.at(-1) || ""}`, 503, true);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(1000) });
          if (response.ok) return worker;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      child.kill();
      throw assistantError("model_unhealthy", "The local model did not become ready in time.", 503, true);
    };
    try {
      return await launch(accelerator);
    } catch (error) {
      if (!accelerator || signal?.aborted) throw error;
      return launch(null);
    }
  }

  async function ensureWorker(capability, signal, resourceProfile = "default") {
    await recoveryPromise;
    const activeRow = installedRow(capability);
    const voiceModelId = capability === "generation" && resourceProfile === "voice"
      ? String(process.env.ASSISTANT_VOICE_MODEL_ID || "")
      : "";
    const row = voiceModelId
      ? store.db.prepare("SELECT * FROM models WHERE model_id=? AND capability=? AND state='ready'").get(voiceModelId, capability)
      : activeRow;
    if (voiceModelId && !row) throw assistantError("voice_model_not_installed", "The configured voice generation candidate is not installed in this data root.", 503, true);
    if (!row) throw assistantError("model_not_installed", `Install and activate a local ${capability} model first.`, 503);
    const model = catalogModel(row.model_id, capability);
    const workerKey = runtimeWorkerKey(capability, resourceProfile);
    const existing = workers.get(workerKey);
    if (existing && existing.process.exitCode === null && existing.model.id === model.id && existing.model.manifestRevision === model.manifestRevision) return existing;
    const voiceWorker = workerKey === "generation:voice";
    // Release the idle copy before budgeting GPU memory for the other mode.
    // An active request retains its model until it has finished.
    if (capability === "generation") {
      const counterpartKey = voiceWorker ? "generation" : "generation:voice";
      const counterpart = workers.get(counterpartKey);
      if (counterpart && !counterpart.activeRequests) {
        workers.delete(counterpartKey);
        await stopWorker(counterpart);
      }
    }
    const forceCpu = voiceWorker && !autoVoiceGpuLayers;
    const gpuLayers = voiceWorker && autoVoiceGpuLayers
      ? await voiceResourceScheduler.chooseGpuLayers({
        model: { ...model, gpuLayers: requestedVoiceGpuLayers || model.gpuLayers || 0 },
        device: await detectAcceleratorDevice(),
        workerKey
      })
      : (workerKey === "generation" ? (requestedTextGpuLayers || Number(model.gpuLayers) || 0) : (Number(model.gpuLayers) || 0));
    if (capability === "generation") {
      const counterpartKey = voiceWorker ? "generation" : "generation:voice";
      const counterpart = workers.get(counterpartKey);
      const memoryNeeded = Math.max(Number(model.sizeBytes) * 1.35, 8 * 1024 ** 3);
      if (counterpart && !counterpart.activeRequests && os.freemem() < memoryNeeded) {
        workers.delete(counterpartKey);
        await stopWorker(counterpart);
      }
    }
    const replacement = await startWorker(row, model, signal, { workerKey, forceCpu, gpuLayers });
    workers.set(workerKey, replacement);
    await stopWorker(existing);
    await voiceResourceScheduler.recordObservation({
      key: `worker:${workerKey}`,
      workerKey,
      modelId: model.id,
      modelRevision: model.manifestRevision,
      resourceProfile: replacement.resourceProfile,
      accelerator: replacement.accelerator,
      gpuLayers: replacement.gpuLayers,
      resident: true
    });
    return replacement;
  }

  function scheduleVoiceWorkerIdle(worker) {
    if (!worker || worker.workerKey !== "generation:voice") return;
    if (worker.idleTimer) clearTimeout(worker.idleTimer);
    worker.idleTimer = setTimeout(() => {
      if (worker.activeRequests || workers.get(worker.workerKey) !== worker) return;
      workers.delete(worker.workerKey);
      setRuntimeMode("IDLE_MEMORY_SAVER", { workerKey: worker.workerKey });
      void stopWorker(worker);
    }, voiceWorkerIdleMs);
    worker.idleTimer.unref?.();
  }

  warmActiveGenerationPromise = recoveryPromise.then(async () => {
    if (installedRow("generation")?.state !== "ready" || shutdownController.signal.aborted) return null;
    await ensureWorker("generation", shutdownController.signal);
    return generate({
      messages: [{ role: "user", content: "Reply with OK." }],
      maxOutputTokens: 1,
      temperature: 0,
      signal: shutdownController.signal
    });
  }).catch(() => null);

  async function activate({ capability, modelId }) {
    if (!modelId) {
      const current = workers.get(capability);
      workers.delete(capability);
      await stopWorker(current);
      if (capability === "generation") {
        const voiceCurrent = workers.get("generation:voice");
        workers.delete("generation:voice");
        await stopWorker(voiceCurrent);
      }
      store.db.prepare("UPDATE models SET active=0,updated_at=? WHERE capability=?").run(isoNow(), capability);
      return { capability, activeModelId: null };
    }
    const model = catalogModel(modelId, capability);
    const row = store.db.prepare("SELECT * FROM models WHERE model_id=? AND capability=? AND state='ready'").get(modelId, capability);
    if (!row || row.manifest_revision !== model.manifestRevision) throw assistantError("model_not_installed", "Install this model before activating it.", 409);
    const previousWorker = workers.get(capability);
    const voiceWorker = capability === "generation" ? workers.get("generation:voice") : null;
    let replacement;
    try {
      replacement = await startWorker(row, model, AbortSignal.timeout(120_000));
    } catch (error) {
      throw error;
    }
    store.transaction(() => {
      store.db.prepare("UPDATE models SET active=0,updated_at=? WHERE capability=?").run(isoNow(), capability);
      store.db.prepare("UPDATE models SET active=1,updated_at=? WHERE model_id=? AND capability=?").run(isoNow(), modelId, capability);
    });
    workers.set(capability, replacement);
    if (previousWorker !== replacement) await stopWorker(previousWorker);
    if (voiceWorker) {
      workers.delete("generation:voice");
      await stopWorker(voiceWorker);
    }
    await core.activity.append({ kind: "model", action: "model.activated", status: "completed", summary: `${model.displayName} activated`, related: { modelId } });
    return { capability, activeModelId: modelIdentity(model) };
  }

  async function remove(modelId) {
    const row = store.db.prepare("SELECT * FROM models WHERE model_id=?").get(modelId);
    if (!row) throw assistantError("model_not_found", "The installed model was not found.", 404);
    if (row.active) throw assistantError("model_in_use", "Deactivate the model before removing it.", 409);
    await fs.rm(path.dirname(row.installed_path), { recursive: true, force: true });
    store.db.prepare("DELETE FROM models WHERE model_id=?").run(modelId);
    await core.activity.append({ kind: "model", action: "model.removed", status: "completed", summary: `${row.display_name} removed`, related: { modelId } });
    return { removed: true };
  }

  async function withRequestLease(capability, signal, task) {
    const previous = requestTails.get(capability) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    requestTails.set(capability, tail);
    await previous.catch(() => {});
    const effectiveSignal = signal ? AbortSignal.any([signal, shutdownController.signal]) : shutdownController.signal;
    try {
      if (effectiveSignal.aborted) throw assistantError("model_request_cancelled", "The local model request was cancelled.", 409, true);
      return await task(effectiveSignal);
    } finally {
      release();
      if (requestTails.get(capability) === tail) requestTails.delete(capability);
    }
  }

  async function generate({ messages, context = [], maxOutputTokens = 768, responseFormat, signal, onToken = null, onResourceState = null, temperature = 0.55, topP = 0.85, repeatPenalty = 1.08, resourceProfile = "default" }) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 64) throw assistantError("context_too_large", "Generation requires 1-64 messages.", 400);
    const normalizedResourceProfile = resourceProfile === "voice" ? "voice" : "default";
    return withRequestLease(runtimeWorkerKey("generation", normalizedResourceProfile), signal, async (effectiveSignal) => {
    const requestedWorkerKey = runtimeWorkerKey("generation", normalizedResourceProfile);
    const currentWorker = workers.get(requestedWorkerKey);
    if (normalizedResourceProfile === "voice" && (!currentWorker || currentWorker.process.exitCode !== null)) {
      setRuntimeMode("VOICE_WARMING", { workerKey: requestedWorkerKey });
      onResourceState?.("preparing");
    } else if (normalizedResourceProfile !== "voice") {
      setRuntimeMode("TEXT_INTERACTIVE", { workerKey: requestedWorkerKey });
    }
    const worker = await ensureWorker("generation", effectiveSignal, normalizedResourceProfile);
    if (normalizedResourceProfile === "voice") {
      setRuntimeMode("VOICE_RESPONDING", { workerKey: requestedWorkerKey });
      onResourceState?.("ready");
    }
    worker.activeRequests += 1;
    try {
    const request = {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${worker.apiKey}` },
      body: JSON.stringify({
        model: worker.model.id,
        messages,
        max_tokens: Math.max(1, Math.min(worker.model.maxOutputTokens, maxOutputTokens)),
        temperature: Math.max(0, Math.min(2, Number(temperature) || 0)),
        top_p: Math.max(0.05, Math.min(1, Number(topP) || 0.85)),
        repeat_penalty: Math.max(1, Math.min(2, Number(repeatPenalty) || 1.08)),
        ...(worker.model.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        stream: Boolean(onToken),
        ...(onToken ? { stream_options: { include_usage: true } } : {}),
        ...(responseFormat ? { response_format: responseFormat } : {})
      }),
      signal: effectiveSignal
    };
    const payload = onToken
      ? await fetchCompletionStream(`http://127.0.0.1:${worker.port}/v1/chat/completions`, request, 150_000, onToken)
      : await fetchJson(`http://127.0.0.1:${worker.port}/v1/chat/completions`, request, 150_000);
    const text = onToken ? payload.text : payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw assistantError("model_unhealthy", "The local generation model returned an invalid response.", 503, true);
    const result = {
      model: modelIdentity(worker.model),
      text,
      usage: { inputTokens: Number(payload.usage?.prompt_tokens || 0), outputTokens: Number(payload.usage?.completion_tokens || 0) }
    };
    if (normalizedResourceProfile === "voice") setRuntimeMode("VOICE_READY", { workerKey: requestedWorkerKey });
    return result;
    } finally {
      worker.activeRequests = Math.max(0, worker.activeRequests - 1);
      scheduleVoiceWorkerIdle(worker);
    }
    });
  }

  async function embed({ purpose, texts, signal }) {
    if (!['document', 'query'].includes(purpose) || !Array.isArray(texts) || !texts.length || texts.length > 64) throw assistantError("invalid_embedding_request", "Embedding requires a purpose and 1-64 texts.", 400);
    return withRequestLease("embeddings", signal, async (effectiveSignal) => {
    const worker = await ensureWorker("embeddings", effectiveSignal);
    const prefix = purpose === "document" ? worker.model.documentPrefix : worker.model.queryPrefix;
    const payload = await fetchJson(`http://127.0.0.1:${worker.port}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${worker.apiKey}` },
      body: JSON.stringify({ model: worker.model.id, input: texts.map((text) => `${prefix}${text}`) }),
      signal: effectiveSignal
    }, 120_000);
    const vectors = Array.isArray(payload?.data) ? payload.data.sort((a, b) => a.index - b.index).map((entry) => entry.embedding) : [];
    if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector) || vector.length !== worker.model.dimensions || vector.some((value) => !Number.isFinite(value)))) {
      throw assistantError("model_unhealthy", "The local embedding model returned invalid vectors.", 503, true);
    }
    return { model: modelIdentity(worker.model), dimensions: worker.model.dimensions, vectors };
    });
  }

  function route(handler) {
    return async (request, response) => {
      try {
        await recoveryPromise;
        response.json(await handler(request, response));
      } catch (error) {
        sendAssistantError(response, error);
      }
    };
  }

  router.get("/models", route(() => ({ catalog: catalog.models.map(serializeCatalogModel), status: status() })));
  router.post("/models/install", route((request) => install(request.body || {})));
  router.post("/models/:modelId/repair", route((request) => {
    const row = store.db.prepare("SELECT capability FROM models WHERE model_id=?").get(request.params.modelId);
    const model = catalogModel(request.params.modelId, row?.capability);
    return install({ capability: model.capability, modelId: model.id, manifestRevision: request.body?.manifestRevision, licenseAcceptance: { licenseId: model.license.id, accepted: true } });
  }));
  router.put("/models/active", route((request) => activate(request.body || {})));
  router.delete("/models/:modelId", route((request) => remove(request.params.modelId)));

  async function close() {
    shutdownController.abort();
    await Promise.allSettled([recoveryPromise, warmActiveGenerationPromise]);
    await Promise.race([
      Promise.allSettled([...requestTails.values()]),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
    await Promise.allSettled([...workers.values()].map(stopWorker));
    workers.clear();
  }

  async function suspendGpuWorkers({ reason = "exclusive GPU workload" } = {}) {
    await recoveryPromise;
    const candidates = [...workers.entries()].filter(([, worker]) => worker?.process?.exitCode === null && Number(worker.gpuLayers) > 0);
    const busy = candidates.filter(([, worker]) => Number(worker.activeRequests) > 0);
    if (busy.length) {
      throw assistantError("model_runtime_busy", `The local assistant is handling a request and cannot release GPU memory for ${reason}.`, 409, true);
    }
    const suspended = candidates.map(([workerKey, worker]) => ({
      workerKey,
      capability: workerKey === "generation:voice" ? "generation" : workerKey,
      resourceProfile: workerKey === "generation:voice" ? "voice" : "default",
      modelId: worker.model?.id || "",
      gpuLayers: Number(worker.gpuLayers) || 0
    }));
    for (const [workerKey, worker] of candidates) {
      workers.delete(workerKey);
      await stopWorker(worker);
    }
    let restored = false;
    return {
      suspended,
      async restore() {
        if (restored || shutdownController.signal.aborted) return;
        restored = true;
        for (const item of suspended) {
          await ensureWorker(item.capability, shutdownController.signal, item.resourceProfile);
        }
      }
    };
  }
  core.registerCloseHook(close);

  return { status, runtimeIdentity, install, activate, remove, generate, embed, close, catalog, voiceResourceScheduler, suspendGpuWorkers };
}
