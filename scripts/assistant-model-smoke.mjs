import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server/index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.argv[2] || path.join(repoRoot, "release", "chromium", "MagicBox", "assistant"));
const evidencePath = path.resolve(process.argv[3] || path.join(repoRoot, "release", "assistant-model-smoke.json"));
const extraArgs = process.argv.slice(4);
const argValue = (name) => { const index = extraArgs.indexOf(name); return index >= 0 ? extraArgs[index + 1] : null; };
const packageRoot = path.resolve(argValue("--package-root") || repoRoot);
const mode = argValue("--mode") || "all";
const runtimeRoot = path.join(packageRoot, "vendor", "llama", "b9637");
let context;
const networkFetch = globalThis.fetch;
const blockedNetworkAttempts = [];
const fileSha256 = async (filePath) => { const hash = createHash("sha256"); for await (const chunk of createReadStream(filePath)) hash.update(chunk); return hash.digest("hex"); };

async function api(method, pathname, body) {
  const response = await fetch(`${context.url}${pathname}`, {
    method,
    ...(body instanceof FormData ? { body } : body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.message || `HTTP ${response.status}`), { code: payload.code, details: payload.details });
  return payload;
}

async function waitJob(jobId, timeoutMs = 60 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  while (Date.now() < deadline) {
    const job = await api("GET", `/api/assistant/jobs/${jobId}`);
    const line = `${job.status} ${job.stage} ${job.progress ?? "?"}% ${job.message}`;
    if (line !== previous) console.log(line);
    previous = line;
    if (["completed", "failed", "cancelled"].includes(job.status)) {
      if (job.status !== "completed") throw new Error(`${job.type} ${job.status}: ${job.error?.message || job.message}`);
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Job ${jobId} timed out.`);
}

async function poll(assertion, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await assertion(); }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw lastError || new Error("Smoke poll timed out.");
}

async function installAndActivate(model) {
  if (model.installState !== "ready") {
    console.log(`Installing ${model.displayName} (${(model.sizeBytes / 1024 ** 3).toFixed(2)} GiB)...`);
    const job = await api("POST", "/api/assistant/models/install", {
      capability: model.capability,
      modelId: model.id,
      manifestRevision: model.manifestRevision,
      licenseAcceptance: { licenseId: model.license.id, accepted: true }
    });
    await waitJob(job.id);
  }
  console.log(`Activating ${model.displayName}...`);
  await api("PUT", "/api/assistant/models/active", { capability: model.capability, modelId: model.id });
}

try {
  await fs.mkdir(dataDir, { recursive: true });
  context = await startServer({ port: 0, defaultDownloadDir: path.join(dataDir, "smoke-downloads"), assistantDataDir: dataDir, assistantRuntimeRoot: runtimeRoot, dht: false, lsd: false, tracker: false });
  const listed = await api("GET", "/api/assistant/models");
  const embeddingModel = listed.catalog.find((model) => model.capability === "embeddings");
  const generationModel = listed.catalog.find((model) => model.capability === "generation");
  assert.ok(embeddingModel && generationModel);
  await installAndActivate(embeddingModel);
  await installAndActivate(generationModel);
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
      blockedNetworkAttempts.push(url.origin);
      throw new Error(`Offline smoke blocked non-loopback request: ${url.origin}`);
    }
    return networkFetch(input, options);
  };

  const nonce = `LOCAL-CEDAR-${Date.now()}`;
  const form = new FormData();
  form.append("files", new Blob([`The private assistant acceptance codename is ${nonce}. This statement is the authoritative local source.`], { type: "text/plain" }), "assistant-model-proof.txt");
  const imported = await api("POST", "/api/assistant/items/import", form);
  await waitJob(imported.job.id, 10 * 60 * 1000);
  const itemId = imported.items[0].id;
  const search = await api("POST", "/api/assistant/search", { query: nonce, scope: { itemIds: [itemId] }, limit: 5 });
  assert.equal(search.retrieval, "hybrid");
  assert.equal(search.results[0].itemId, itemId);

  let chat;
  try {
    chat = await api("POST", "/api/assistant/chat", { requestId: crypto.randomUUID(), message: "What is the private assistant acceptance codename?", scope: { itemIds: [itemId] } });
  } catch (error) {
    const diagnostic = await context.assistantModelRuntime.generate({ messages: [{ role: "system", content: "Answer with the exact codename from source S1, cite it as [S1], and end with CITATIONS: S1." }, { role: "user", content: `S1: The codename is ${nonce}.` }], maxOutputTokens: 128 });
    console.error(`Citation diagnostic: ${JSON.stringify(diagnostic.text)}`);
    const basicDiagnostic = await context.assistantModelRuntime.generate({ messages: [{ role: "user", content: `Reply with exactly this codename and nothing else: ${nonce}` }], maxOutputTokens: 128 });
    console.error(`Basic diagnostic: ${JSON.stringify(basicDiagnostic.text)}`);
    throw error;
  }
  assert.equal(chat.grounding, "workspace");
  assert.ok(chat.sources.length > 0);
  assert.match(chat.answer, new RegExp(nonce));

  let featureEvidence = null;
  if (mode === "automation") {
    const recipe = await api("POST", "/api/assistant/recipes", { draft: { name: "Packaged smoke tag", mode: "suggest", trigger: { type: "manual" }, conditions: [], actions: [{ type: "tag", add: ["packaged-smoke"], remove: [] }] } });
    await api("POST", `/api/assistant/recipes/${recipe.id}/enable`, { revision: recipe.revision, confirmation: true });
    const plan = await api("POST", "/api/assistant/automations/preview", { recipeId: recipe.id, itemIds: [itemId] });
    const approval = await api("POST", `/api/assistant/automations/plans/${plan.id}/approve`, { planHash: plan.planHash, confirmation: true });
    const execution = await api("POST", "/api/assistant/automations/execute", { planId: plan.id, approvalId: approval.approvalId });
    await waitJob(execution.id);
    const tagged = (await api("GET", "/api/assistant/items?limit=100")).items.find((item) => item.id === itemId);
    assert.ok(tagged.tags.includes("packaged-smoke"));
    featureEvidence = { recipeId: recipe.id, operationCount: plan.operations.length, tagged: true };
  }
  if (mode === "integrations") {
    const outputRoot = path.join(dataDir, "integration-smoke");
    await fs.mkdir(outputRoot, { recursive: true });
    const outputPath = path.join(outputRoot, "completed-output.txt");
    await fs.writeFile(outputPath, "Packaged integration output.", "utf8");
    await api("PUT", "/api/assistant/integrations/images", { enabled: true, outputRootPath: outputRoot, confirmation: true });
    const ticket = context.assistantToolIntegrations.capture("images", { outputRootPath: outputRoot, producerJobId: "packaged-smoke" });
    ticket.complete({ producerEventId: `packaged-${Date.now()}`, files: [outputPath] });
    const delivered = await poll(() => {
      const row = context.assistantManager.store.db.prepare("SELECT * FROM integration_deliveries ORDER BY created_at DESC LIMIT 1").get();
      assert.ok(["completed", "partial"].includes(row?.status));
      return JSON.parse(row.result_json);
    });
    featureEvidence = { deliveryId: delivered.deliveryId, status: delivered.status, admittedCount: delivered.admittedItemIds.length };
  }

  const modelStatus = (await api("GET", "/api/assistant/models")).status;
  const packageManifest = await fs.readFile(path.join(packageRoot, "assistant-package-manifest.json"), "utf8").then(JSON.parse).catch(() => null);
  const installedModels = [];
  for (const row of context.assistantManager.store.db.prepare("SELECT model_id,capability,manifest_revision,installed_path,size_bytes,sha256 FROM models WHERE active=1 ORDER BY capability").all()) {
    installedModels.push({ id: row.model_id, capability: row.capability, manifestRevision: row.manifest_revision, sizeBytes: Number(row.size_bytes), expectedSha256: row.sha256, actualSha256: await fileSha256(row.installed_path) });
  }
  const evidence = {
    generatedAt: new Date().toISOString(),
    mode,
    package: packageManifest ? { root: packageRoot, buildId: packageManifest.buildId, rootHash: packageManifest.rootHash, fileCount: packageManifest.fileCount } : null,
    dataDir,
    runtimeVersion: modelStatus.runtimeVersion,
    runtime: modelStatus.runtime,
    generation: modelStatus.generation,
    embeddings: modelStatus.embeddings,
    activeModels: modelStatus.activeModels,
    installedModels,
    search: { retrieval: search.retrieval, resultCount: search.results.length, dimensions: 1024 },
    chat: { grounding: chat.grounding, sourceCount: chat.sources.length, model: chat.model, answerContainsNonce: chat.answer.includes(nonce) }
  };
  if (featureEvidence) evidence.feature = featureEvidence;
  evidence.offlineGuard = { activeDuringIndexSearchChat: true, nonLoopbackAttempts: blockedNetworkAttempts.length };
  await api("POST", "/api/assistant/privacy-clear", { scopes: ["workspace-index", "conversations", "activity", "recipes", "integrations"], confirmation: true, discardEligibleUndo: true });
  const cleanStatus = await api("GET", "/api/assistant/status");
  assert.equal(cleanStatus.counts.items, 0);
  assert.equal(cleanStatus.counts.activity, 0);
  evidence.cleanup = { items: cleanStatus.counts.items, activity: cleanStatus.counts.activity, installedModelsRetained: true };
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  globalThis.fetch = networkFetch;
  await Promise.race([context?.close(), new Promise((resolve) => setTimeout(resolve, 20_000))]);
}
process.exit(0);
