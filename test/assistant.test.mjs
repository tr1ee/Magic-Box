import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startServer } from "../server/index.mjs";
import { answerDepthForQuestion, formatRuntimeIdentityAnswer, hasExplicitWebIntent, isRuntimeIdentityQuestion } from "../server/assistant/chat.mjs";

const runtimeRoot = path.resolve("vendor", "llama", "b9637");
let root;
let dataDir;
let workspaceDir;
let context;

it("detects direct and time-sensitive automatic web-search requests", () => {
  assert.equal(hasExplicitWebIntent("Search the web for the newest Qwen release"), true);
  assert.equal(hasExplicitWebIntent("查一下今天上海的天气"), true);
  assert.equal(hasExplicitWebIntent("Help me rewrite this paragraph"), false);
});

it("scales answer depth to the request instead of defaulting every turn to an essay", () => {
  assert.equal(answerDepthForQuestion("你好"), "concise");
  assert.equal(answerDepthForQuestion("把这句话翻译成英文"), "concise");
  assert.equal(answerDepthForQuestion("如何优化语音播放时的卡顿问题？"), "standard");
  assert.equal(answerDepthForQuestion("请深入分析两种架构的优缺点和取舍"), "deep");
  assert.equal(answerDepthForQuestion("I need a practical migration recommendation for a medium-sized service with several constraints and a team that must keep the current system running during the transition."), "standard");
});

it("routes runtime identity questions to trusted local metadata", () => {
  const identity = { id: "qwen3.5-9b-q4-k-m", displayName: "Qwen 3.5 9B Q4_K_M", manifestRevision: "2026-08-07.1" };
  for (const question of ["你现在使用的是什么模型？", "小爱你用什么模型？", "你是不是 DeepSeek R1？", "What model are you using?"]) {
    assert.equal(isRuntimeIdentityQuestion(question), true, question);
    const answer = formatRuntimeIdentityAnswer(question, identity);
    assert.match(answer, /qwen3\.5-9b-q4-k-m/iu);
    assert.match(answer, /DeepSeek R1/iu);
  }
  assert.equal(isRuntimeIdentityQuestion("请解释一下模型量化是什么"), false);
});

async function api(method, pathname, body) {
  const response = await fetch(`${context.url}${pathname}`, {
    method,
    ...(body instanceof FormData
      ? { body }
      : body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function waitForJob(jobId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await api("GET", `/api/assistant/jobs/${jobId}`);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Assistant job ${jobId} timed out.`);
}

async function importText(name, text) {
  const form = new FormData();
  form.append("files", new Blob([text], { type: "text/plain" }), name);
  const result = await api("POST", "/api/assistant/items/import", form);
  const job = await waitForJob(result.job.id);
  assert.equal(job.status, "completed", JSON.stringify(job.error));
  return result.items[0];
}

async function poll(assertion, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await assertion(); }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 80)); }
  }
  throw lastError || new Error("Poll timed out.");
}

describe("Private Assistant acceptance", { concurrency: 1 }, () => {
  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "magic-box-assistant-test-"));
    dataDir = path.join(root, "assistant-data");
    workspaceDir = path.join(root, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    context = await startServer({ port: 0, defaultDownloadDir: path.join(root, "downloads"), assistantDataDir: dataDir, assistantRuntimeRoot: runtimeRoot, dht: false, lsd: false, tracker: false });
  });

  after(async () => {
    await context?.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("starts as a local-only workspace with disabled integrations and a verified runtime", async () => {
    const status = await api("GET", "/api/assistant/status");
    assert.equal(status.state, "ready");
    assert.equal(status.privacy.localOnly, true);
    assert.equal(status.privacy.cloudInference, false);
    const models = await api("GET", "/api/assistant/models");
    assert.equal(models.status.runtime, "ready");
    assert.equal(models.catalog.length, 3);
    const upgraded = models.catalog.find((model) => model.id === "qwen3.5-9b-q4-k-m");
    assert.equal(upgraded?.sizeBytes, 6_169_341_984);
    assert.equal(upgraded?.acceleration, "GPU preferred, CPU fallback");
    const modelCatalog = JSON.parse(await fs.readFile(new URL("../server/assistant/model-catalog.json", import.meta.url), "utf8"));
    const retrieval = modelCatalog.models.find((model) => model.capability === "embeddings");
    assert.equal(retrieval?.documentPrefix, "");
    assert.match(retrieval?.queryPrefix || "", /private local files/u);
    const integrations = await api("GET", "/api/assistant/integrations");
    assert.ok(integrations.integrations.every((entry) => entry.enabled === false));
  });

  it("imports, indexes, searches, and removes content without leaving stale chunks", async () => {
    const item = await importText("private-notes.txt", "Project lantern code is BLUE-ORCHID-742. Keep this local.");
    const search = await api("POST", "/api/assistant/search", { query: "BLUE-ORCHID-742", scope: { itemIds: [item.id] } });
    assert.equal(search.results[0].itemId, item.id);
    assert.match(search.results[0].excerpt, /BLUE-ORCHID-742/);
    await api("DELETE", `/api/assistant/items/${item.id}`);
    const stale = await api("POST", "/api/assistant/search", { query: "BLUE-ORCHID-742" });
    assert.equal(stale.results.length, 0);
    assert.equal(context.assistantManager.store.db.prepare("SELECT COUNT(*) AS count FROM chunks WHERE item_id=?").get(item.id).count, 0);
  });

  it("bounds semantic retrieval before embedding and preserves deterministic keyword fallbacks", async () => {
    const store = context.assistantManager.store;
    const runtime = context.assistantModelRuntime;
    const index = context.assistantWorkspaceIndex;
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const model = `semantic-p1-${suffix}`;
    const largeItemId = `semantic-large-${suffix}`;
    const scopedItemId = `semantic-scoped-${suffix}`;
    const createdAt = new Date().toISOString();
    const insertItem = store.db.prepare("INSERT INTO items(id,display_name,canonical_path,path_key,managed_path,source,state,content_type,size_bytes,fingerprint,revision,metadata_revision,tags_json,summary,origins_json,details_ref,extracted_text,created_at,updated_at,last_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const insertChunk = store.db.prepare("INSERT INTO chunks(id,item_id,item_revision,ordinal,text,page,section,vector_json,embedding_model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
    const originalStatus = runtime.status;
    const originalEmbed = runtime.embed;
    const insertSemanticItem = (id, displayName) => insertItem.run(
      id,
      displayName,
      path.join(root, `${id}.txt`),
      path.join(root, `${id}.txt`).toLowerCase(),
      null,
      "inbox",
      "indexed",
      "text/plain",
      1,
      null,
      1,
      0,
      "[]",
      null,
      "[]",
      null,
      null,
      createdAt,
      createdAt,
      null
    );
    let embedCalls = 0;
    runtime.status = () => ({ embeddings: "ready", activeModels: { embeddings: model } });
    runtime.embed = async () => {
      embedCalls += 1;
      return { model, dimensions: 2, vectors: [[1, 0]] };
    };
    try {
      store.transaction(() => {
        insertSemanticItem(largeItemId, "Semantic corpus cap");
        for (let ordinal = 0; ordinal <= 10_000; ordinal += 1) {
          insertChunk.run(`semantic-large-chunk-${suffix}-${ordinal}`, largeItemId, 1, ordinal, "semantic corpus marker", null, null, "[1,0]", model, createdAt);
        }
        insertSemanticItem(scopedItemId, "Scoped semantic corpus");
        insertChunk.run(`semantic-scoped-chunk-${suffix}-0`, scopedItemId, 1, 0, "semantic scoped marker first", null, null, "[1,0]", model, createdAt);
        insertChunk.run(`semantic-scoped-chunk-${suffix}-1`, scopedItemId, 1, 1, "semantic scoped marker second", null, null, "[1,0]", model, createdAt);
      });

      assert.equal(store.getMeta("schema_version"), "3");
      assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chunks_embedding_model_item'").get());
      const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT c.id FROM chunks c JOIN items i ON i.id=c.item_id WHERE c.vector_json IS NOT NULL AND c.embedding_model=? AND i.state='indexed' ORDER BY c.item_id,c.item_revision,c.ordinal,c.id LIMIT 10001").all(model);
      assert.ok(plan.some((row) => String(row.detail || "").includes("idx_chunks_embedding_model_item")), JSON.stringify(plan));
      assert.equal(store.compatibleVectorProbe({ embeddingModel: model, itemIds: [largeItemId] }), 10_001);

      const capped = await index.search({ query: "semantic corpus marker", scope: { itemIds: [largeItemId] } });
      assert.equal(capped.retrieval, "keyword");
      assert.deepEqual(capped.warnings, ["semantic_corpus_limit"]);
      assert.equal(embedCalls, 0);

      const scoped = await index.search({ query: "semantic scoped marker", scope: { itemIds: [scopedItemId] } });
      assert.equal(scoped.retrieval, "hybrid");
      assert.deepEqual(scoped.warnings, []);
      assert.equal(embedCalls, 1);
      assert.equal(scoped.results[0].chunkId, `semantic-scoped-chunk-${suffix}-0`);

      runtime.embed = async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return { model, dimensions: 2, vectors: [[1, 0]] };
      };
      const timedOut = await index.search({ query: "semantic scoped marker", scope: { itemIds: [scopedItemId] } });
      assert.equal(timedOut.retrieval, "keyword");
      assert.deepEqual(timedOut.warnings, ["semantic_timeout"]);

      runtime.embed = async () => { throw new Error("embedding worker unavailable"); };
      const unavailable = await index.search({ query: "semantic scoped marker", scope: { itemIds: [scopedItemId] } });
      assert.equal(unavailable.retrieval, "keyword");
      assert.deepEqual(unavailable.warnings, ["semantic_unavailable"]);

      const controller = new AbortController();
      controller.abort("client_aborted");
      await assert.rejects(
        index.search({ query: "semantic scoped marker", scope: { itemIds: [scopedItemId] }, signal: controller.signal }),
        (error) => error.code === "search_cancelled"
      );
    } finally {
      runtime.status = originalStatus;
      runtime.embed = originalEmbed;
      store.transaction(() => {
        store.db.prepare("DELETE FROM chunks_fts WHERE item_id IN (?,?)").run(largeItemId, scopedItemId);
        store.db.prepare("DELETE FROM chunks WHERE item_id IN (?,?)").run(largeItemId, scopedItemId);
        store.db.prepare("DELETE FROM items WHERE id IN (?,?)").run(largeItemId, scopedItemId);
      });
    }
  });

  it("stages and fingerprints an unsupported regular file without extracting it", async () => {
    const form = new FormData();
    form.append("files", new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: "application/octet-stream" }), "opaque.bin");
    const result = await api("POST", "/api/assistant/items/import", form);
    assert.equal((await waitForJob(result.job.id)).status, "completed");
    const item = (await api("GET", "/api/assistant/items?limit=100")).items.find((entry) => entry.id === result.items[0].id);
    assert.equal(item.state, "unsupported");
    assert.match(item.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(context.assistantManager.store.db.prepare("SELECT COUNT(*) AS count FROM chunks WHERE item_id=?").get(item.id).count, 0);
  });

  it("persists workspace metadata across a real server restart", async () => {
    const item = await importText("restart-proof.txt", "Durable assistant restart marker OAK-991.");
    await context.close();
    context = await startServer({ port: 0, defaultDownloadDir: path.join(root, "downloads"), assistantDataDir: dataDir, assistantRuntimeRoot: runtimeRoot, dht: false, lsd: false, tracker: false });
    const items = await api("GET", "/api/assistant/items?limit=100");
    assert.ok(items.items.some((entry) => entry.id === item.id && entry.state === "indexed"));
    const search = await api("POST", "/api/assistant/search", { query: "OAK-991" });
    assert.equal(search.results[0].itemId, item.id);
  });

  it("scans only an approved root and revocation never deletes the source", async () => {
    const sourcePath = path.join(workspaceDir, "workspace-source.md");
    await fs.writeFile(sourcePath, "Workspace source marker SILVER-PINE-38.", "utf8");
    const grant = await api("POST", "/api/assistant/workspace-roots", { path: workspaceDir });
    const job = await waitForJob(grant.scanJobId);
    assert.equal(job.status, "completed");
    const search = await api("POST", "/api/assistant/search", { query: "SILVER-PINE-38" });
    assert.equal(search.results.length, 1);
    await api("DELETE", `/api/assistant/workspace-roots/${grant.root.id}`);
    assert.equal(await fs.readFile(sourcePath, "utf8"), "Workspace source marker SILVER-PINE-38.");
    const gone = await api("POST", "/api/assistant/search", { query: "SILVER-PINE-38" });
    assert.equal(gone.results.length, 0);
  });

  it("previews, approves, executes, audits, and undoes an exact metadata plan", async () => {
    const item = await importText("automation.txt", "Automation acceptance item.");
    const recipe = await api("POST", "/api/assistant/recipes", { draft: { name: "Mark verified", mode: "suggest", trigger: { type: "manual" }, conditions: [], actions: [{ type: "tag", add: ["verified"], remove: [] }] } });
    await api("POST", `/api/assistant/recipes/${recipe.id}/enable`, { revision: recipe.revision, confirmation: true });
    const plan = await api("POST", "/api/assistant/automations/preview", { recipeId: recipe.id, itemIds: [item.id] });
    assert.equal(plan.operations.length, 1);
    const approval = await api("POST", `/api/assistant/automations/plans/${plan.id}/approve`, { planHash: plan.planHash, confirmation: true });
    const execution = await api("POST", "/api/assistant/automations/execute", { planId: plan.id, approvalId: approval.approvalId });
    assert.equal((await waitForJob(execution.id)).status, "completed");
    const tagged = (await api("GET", "/api/assistant/items?limit=100")).items.find((entry) => entry.id === item.id);
    assert.deepEqual(tagged.tags, ["verified"]);
    const activity = await api("GET", "/api/assistant/activity?limit=100");
    const record = activity.records.find((entry) => entry.action === "automation.executed" && entry.related?.itemIds?.includes(item.id));
    assert.equal(record.undo.eligible, true);
    const undoJob = await api("POST", `/api/assistant/activity/${record.id}/undo`, { confirmation: true });
    assert.equal((await waitForJob(undoJob.id)).status, "completed");
    const restored = (await api("GET", "/api/assistant/items?limit=100")).items.find((entry) => entry.id === item.id);
    assert.deepEqual(restored.tags, []);
  });

  it("consumes a durable Inbox event for enabled automatic-safe recipes", async () => {
    const recipe = await api("POST", "/api/assistant/recipes", { draft: { name: "Auto classify imports", mode: "automatic-safe", trigger: { type: "inbox-added" }, conditions: [{ type: "extension", values: [".txt"] }], actions: [{ type: "tag", add: ["auto-local"], remove: [] }] } });
    await api("POST", `/api/assistant/recipes/${recipe.id}/enable`, { revision: recipe.revision, confirmation: true });
    const item = await importText("automatic.txt", "Automatic local event marker.");
    await poll(async () => {
      const current = (await api("GET", "/api/assistant/items?limit=100")).items.find((entry) => entry.id === item.id);
      assert.deepEqual(current.tags, ["auto-local"]);
    });
  });

  it("delivers opted-in tool outputs asynchronously and fences a revoked grant", async () => {
    const outputDir = path.join(root, "tool-output");
    await fs.mkdir(outputDir, { recursive: true });
    await api("PUT", "/api/assistant/integrations/images", { enabled: true, outputRootPath: outputDir, confirmation: true });
    const output = path.join(outputDir, "finished.txt");
    await fs.writeFile(output, "Completed image-tool sidecar marker.", "utf8");
    const ticket = context.assistantToolIntegrations.capture("images", { outputRootPath: outputDir, producerJobId: "producer-1" });
    ticket.complete({ producerEventId: "event-1", files: [output] });
    assert.throws(() => ticket.complete({ producerEventId: "event-1", files: [path.join(outputDir, "different.txt")] }), (error) => error.code === "integration_delivery_conflict");
    await poll(async () => {
      const items = await api("GET", "/api/assistant/items?source=images&limit=100");
      assert.ok(items.items.some((entry) => entry.displayName === "finished.txt"));
    });
    await poll(() => {
      const row = context.assistantManager.store.db.prepare("SELECT status FROM integration_deliveries WHERE tool_id='images' AND producer_event_id='event-1'").get();
      assert.equal(row?.status, "completed");
    });
    const replacedOutput = path.join(outputDir, "identity-bound.txt");
    await fs.writeFile(replacedOutput, "Producer-completed identity.", "utf8");
    const identityTicket = context.assistantToolIntegrations.capture("images", { outputRootPath: outputDir, producerJobId: "producer-identity" });
    await identityTicket.complete({ producerEventId: "event-identity", files: [replacedOutput] });
    fsSync.writeFileSync(replacedOutput, "Replacement written after completion.", "utf8");
    await poll(async () => {
      const row = context.assistantManager.store.db.prepare("SELECT status,result_json FROM integration_deliveries WHERE tool_id='images' AND producer_event_id='event-identity'").get();
      assert.equal(row.status, "failed");
      assert.equal(JSON.parse(row.result_json).rejected[0].code, "integration_output_changed");
    });
    const identityItems = await api("GET", "/api/assistant/items?source=images&limit=100");
    assert.ok(!identityItems.items.some((entry) => entry.displayName === "identity-bound.txt"));
    const commitRaceOutput = path.join(outputDir, "commit-race.txt");
    await fs.writeFile(commitRaceOutput, "Identity captured before indexing.", "utf8");
    const originalIndexItem = context.assistantManager.core.indexItem;
    context.assistantManager.core.indexItem = async (...args) => {
      fsSync.writeFileSync(commitRaceOutput, "Replacement during the admission/index gap.", "utf8");
      return originalIndexItem(...args);
    };
    try {
      const commitRaceTicket = context.assistantToolIntegrations.capture("images", { outputRootPath: outputDir, producerJobId: "producer-commit-race" });
      await commitRaceTicket.complete({ producerEventId: "event-commit-race", files: [commitRaceOutput] });
      await poll(async () => {
        const row = context.assistantManager.store.db.prepare("SELECT status,result_json FROM integration_deliveries WHERE tool_id='images' AND producer_event_id='event-commit-race'").get();
        assert.equal(row.status, "failed");
        assert.equal(JSON.parse(row.result_json).rejected[0].code, "integration_output_changed");
      });
    } finally {
      context.assistantManager.core.indexItem = originalIndexItem;
    }
    const raceItems = await api("GET", "/api/assistant/items?source=images&limit=100");
    assert.ok(!raceItems.items.some((entry) => entry.displayName === "commit-race.txt"));
    const existingBefore = context.assistantManager.store.db.prepare("SELECT * FROM items WHERE canonical_path=? ORDER BY created_at LIMIT 1").get(output);
    const existingChunksBefore = context.assistantManager.store.db.prepare("SELECT * FROM chunks WHERE item_id=? ORDER BY item_revision,ordinal,id").all(existingBefore.id);
    await fs.writeFile(output, "A second producer version that must not replace prior chunks on failed admission.", "utf8");
    const originalExistingIndexItem = context.assistantManager.core.indexItem;
    context.assistantManager.core.indexItem = async (itemId, options = {}) => {
      let validationCalls = 0;
      const validateBeforeCommit = options.validateBeforeCommit;
      return originalExistingIndexItem(itemId, {
        ...options,
        validateBeforeCommit: async () => {
          validationCalls += 1;
          if (validationCalls === 2) fsSync.writeFileSync(output, "Replacement after chunk commit but before item publication.", "utf8");
          return validateBeforeCommit?.();
        }
      });
    };
    try {
      const existingRaceTicket = context.assistantToolIntegrations.capture("images", { outputRootPath: outputDir, producerJobId: "producer-existing-race" });
      await existingRaceTicket.complete({ producerEventId: "event-existing-race", files: [output] });
      await poll(async () => {
        const row = context.assistantManager.store.db.prepare("SELECT status,result_json FROM integration_deliveries WHERE tool_id='images' AND producer_event_id='event-existing-race'").get();
        assert.equal(row.status, "failed");
        assert.equal(JSON.parse(row.result_json).rejected[0].code, "integration_output_changed");
      });
    } finally {
      context.assistantManager.core.indexItem = originalExistingIndexItem;
    }
    const existingAfter = context.assistantManager.store.db.prepare("SELECT * FROM items WHERE id=?").get(existingBefore.id);
    const existingChunksAfter = context.assistantManager.store.db.prepare("SELECT * FROM chunks WHERE item_id=? ORDER BY item_revision,ordinal,id").all(existingBefore.id);
    assert.equal(existingAfter.fingerprint, existingBefore.fingerprint);
    assert.equal(existingAfter.origins_json, existingBefore.origins_json);
    assert.deepEqual(existingChunksAfter, existingChunksBefore);
    const restoredFts = context.assistantManager.store.db.prepare("SELECT text FROM chunks_fts WHERE item_id=? ORDER BY rowid").all(existingBefore.id);
    assert.deepEqual(restoredFts.map((row) => row.text), existingChunksBefore.map((row) => row.text));
    await fs.writeFile(output, "Serialized re-index baseline.", "utf8");
    await originalExistingIndexItem(existingBefore.id);
    await fs.writeFile(output, "Producer version before the serialized race.", "utf8");
    const queuedWorkspaceRootId = "root-queued-during-integration";
    const queuedRootCreatedAt = new Date().toISOString();
    context.assistantManager.store.db.prepare("INSERT OR REPLACE INTO workspace_roots(id,canonical_path,path_key,generation,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(queuedWorkspaceRootId, outputDir, path.resolve(outputDir).toLowerCase(), 1, queuedRootCreatedAt, queuedRootCreatedAt);
    let queuedReindexPromise;
    const serializedIndexItem = context.assistantManager.core.indexItem;
    context.assistantManager.core.indexItem = async (itemId, options = {}) => {
      let validationCalls = 0;
      const validateBeforeCommit = options.validateBeforeCommit;
      return serializedIndexItem(itemId, {
        ...options,
        validateBeforeCommit: async () => {
          validationCalls += 1;
          if (validationCalls === 2) {
            fsSync.writeFileSync(output, "Concurrent successful re-index queued behind admission rollback.", "utf8");
            queuedReindexPromise = context.assistantManager.core.admitAndIndexReferencedItem({
              canonical: output,
              stats: fsSync.statSync(output),
              root: { id: queuedWorkspaceRootId, generation: 1 },
              source: "workspace"
            });
          }
          return validateBeforeCommit?.();
        }
      });
    };
    try {
      const serializedRaceTicket = context.assistantToolIntegrations.capture("images", { outputRootPath: outputDir, producerJobId: "producer-serialized-existing-race" });
      await serializedRaceTicket.complete({ producerEventId: "event-serialized-existing-race", files: [output] });
      await poll(async () => {
        const row = context.assistantManager.store.db.prepare("SELECT status,result_json FROM integration_deliveries WHERE tool_id='images' AND producer_event_id='event-serialized-existing-race'").get();
        assert.equal(row.status, "failed");
        assert.equal(JSON.parse(row.result_json).rejected[0].code, "integration_output_changed");
      });
      assert.ok(queuedReindexPromise);
      await queuedReindexPromise;
    } finally {
      context.assistantManager.core.indexItem = serializedIndexItem;
    }
    const serializedChunks = context.assistantManager.store.db.prepare("SELECT text FROM chunks WHERE item_id=? ORDER BY ordinal").all(existingBefore.id);
    assert.match(serializedChunks.map((row) => row.text).join("\n"), /Concurrent successful re-index queued behind admission rollback/);
    const serializedOrigins = JSON.parse(context.assistantManager.store.db.prepare("SELECT origins_json FROM items WHERE id=?").get(existingBefore.id).origins_json);
    assert.ok(serializedOrigins.some((origin) => origin.kind === "workspace" && origin.rootId === queuedWorkspaceRootId));
    const fenced = context.assistantToolIntegrations.capture("images", { outputRootPath: outputDir, producerJobId: "producer-2" });
    await api("PUT", "/api/assistant/integrations/images", { enabled: false, confirmation: true });
    fenced.complete({ producerEventId: "event-2", files: [output] });
    await poll(async () => {
      const row = context.assistantManager.store.db.prepare("SELECT status FROM integration_deliveries WHERE tool_id='images' AND producer_event_id='event-2'").get();
      assert.equal(row.status, "failed");
    });
    await context.assistantToolIntegrations.waitForIdle();
  });

  it("never overwrites during rename, move, and copy and safely undoes each filesystem result", async () => {
    const sourceRoot = path.join(root, "automation-source");
    const destinationRoot = path.join(root, "automation-destination");
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.mkdir(destinationRoot, { recursive: true });
    const originalPath = path.join(sourceRoot, "movable.txt");
    await fs.writeFile(originalPath, "Filesystem automation marker COPPER-71.", "utf8");
    const sourceGrant = await api("POST", "/api/assistant/workspace-roots", { path: sourceRoot });
    const destinationGrant = await api("POST", "/api/assistant/workspace-roots", { path: destinationRoot });
    await waitForJob(sourceGrant.scanJobId);
    await waitForJob(destinationGrant.scanJobId);
    const itemId = (await api("POST", "/api/assistant/search", { query: "COPPER-71" })).results[0].itemId;

    async function createAndRun(name, action) {
      const recipe = await api("POST", "/api/assistant/recipes", { draft: { name, mode: "suggest", trigger: { type: "manual" }, conditions: [], actions: [action] } });
      await api("POST", `/api/assistant/recipes/${recipe.id}/enable`, { revision: recipe.revision, confirmation: true });
      const plan = await api("POST", "/api/assistant/automations/preview", { recipeId: recipe.id, itemIds: [itemId] });
      const approval = await api("POST", `/api/assistant/automations/plans/${plan.id}/approve`, { planHash: plan.planHash, confirmation: true });
      const job = await api("POST", "/api/assistant/automations/execute", { planId: plan.id, approvalId: approval.approvalId });
      assert.equal((await waitForJob(job.id)).status, "completed");
      const activity = (await api("GET", "/api/assistant/activity?limit=100")).records.find((entry) => entry.action === "automation.executed" && entry.related?.recipeId === recipe.id);
      assert.equal(activity.undo.eligible, true);
      return { plan, activity };
    }

    const renamedPath = path.join(sourceRoot, "movable-renamed.txt");
    const renamed = await createAndRun("Rename safely", { type: "rename", template: "{name}-renamed.{extension}" });
    assert.equal(await fs.readFile(renamedPath, "utf8"), "Filesystem automation marker COPPER-71.");
    await assert.rejects(fs.stat(originalPath), { code: "ENOENT" });
    assert.equal((await waitForJob((await api("POST", `/api/assistant/activity/${renamed.activity.id}/undo`, { confirmation: true })).id)).status, "completed");
    assert.equal(await fs.readFile(originalPath, "utf8"), "Filesystem automation marker COPPER-71.");

    const movedPath = path.join(destinationRoot, "movable.txt");
    const moved = await createAndRun("Move safely", { type: "move", destinationRootId: destinationGrant.root.id });
    assert.equal(await fs.readFile(movedPath, "utf8"), "Filesystem automation marker COPPER-71.");
    assert.equal((await waitForJob((await api("POST", `/api/assistant/activity/${moved.activity.id}/undo`, { confirmation: true })).id)).status, "completed");
    assert.equal(await fs.readFile(originalPath, "utf8"), "Filesystem automation marker COPPER-71.");

    await fs.writeFile(movedPath, "Unrelated destination that must never be overwritten.", "utf8");
    const copied = await createAndRun("Copy safely", { type: "copy", destinationRootId: destinationGrant.root.id });
    assert.match(copied.plan.operations[0].after.path, /movable \(2\)\.txt$/);
    const collisionSafeCopy = copied.plan.operations[0].after.path;
    assert.equal(await fs.readFile(movedPath, "utf8"), "Unrelated destination that must never be overwritten.");
    assert.equal(await fs.readFile(collisionSafeCopy, "utf8"), "Filesystem automation marker COPPER-71.");
    assert.equal((await waitForJob((await api("POST", `/api/assistant/activity/${copied.activity.id}/undo`, { confirmation: true })).id)).status, "completed");
    await assert.rejects(fs.stat(collisionSafeCopy), { code: "ENOENT" });
    assert.equal(await fs.readFile(movedPath, "utf8"), "Unrelated destination that must never be overwritten.");
  });

  it("preflights a whole undo before changing metadata or files", async () => {
    const atomicRoot = path.join(root, "automation-atomic-undo");
    await fs.mkdir(atomicRoot, { recursive: true });
    const originalPath = path.join(atomicRoot, "atomic.txt");
    const renamedPath = path.join(atomicRoot, "atomic-renamed.txt");
    await fs.writeFile(originalPath, "Atomic undo marker INDIGO-512.", "utf8");
    const grant = await api("POST", "/api/assistant/workspace-roots", { path: atomicRoot });
    await waitForJob(grant.scanJobId);
    const itemId = (await api("POST", "/api/assistant/search", { query: "INDIGO-512" })).results[0].itemId;
    const recipe = await api("POST", "/api/assistant/recipes", { draft: { name: "Atomic rename and tag", mode: "suggest", trigger: { type: "manual" }, conditions: [], actions: [{ type: "rename", template: "{name}-renamed.{extension}" }, { type: "tag", add: ["atomic"], remove: [] }] } });
    await api("POST", `/api/assistant/recipes/${recipe.id}/enable`, { revision: recipe.revision, confirmation: true });
    const plan = await api("POST", "/api/assistant/automations/preview", { recipeId: recipe.id, itemIds: [itemId] });
    const approval = await api("POST", `/api/assistant/automations/plans/${plan.id}/approve`, { planHash: plan.planHash, confirmation: true });
    const execution = await api("POST", "/api/assistant/automations/execute", { planId: plan.id, approvalId: approval.approvalId });
    assert.equal((await waitForJob(execution.id)).status, "completed");
    const activity = (await api("GET", "/api/assistant/activity?limit=100")).records.find((entry) => entry.action === "automation.executed" && entry.related?.recipeId === recipe.id);
    await fs.writeFile(originalPath, "Unrelated blocker at the original path.", "utf8");
    const blockedUndo = await api("POST", `/api/assistant/activity/${activity.id}/undo`, { confirmation: true });
    assert.equal((await waitForJob(blockedUndo.id)).status, "failed");
    const unchanged = (await api("GET", "/api/assistant/items?limit=100")).items.find((entry) => entry.id === itemId);
    assert.deepEqual(unchanged.tags, ["atomic"]);
    assert.equal(await fs.readFile(renamedPath, "utf8"), "Atomic undo marker INDIGO-512.");
    assert.equal(await fs.readFile(originalPath, "utf8"), "Unrelated blocker at the original path.");
    await fs.rm(originalPath);
    const retryUndo = await api("POST", `/api/assistant/activity/${activity.id}/undo`, { confirmation: true });
    assert.equal((await waitForJob(retryUndo.id)).status, "completed");
    assert.equal(await fs.readFile(originalPath, "utf8"), "Atomic undo marker INDIGO-512.");
  });

  it("recovers an exact journaled relocation after restart and preserves undo", async () => {
    const recoveryRoot = path.join(root, "automation-recovery");
    await fs.mkdir(recoveryRoot, { recursive: true });
    const sourcePath = path.join(recoveryRoot, "before-restart.txt");
    const destinationPath = path.join(recoveryRoot, "after-restart.txt");
    await fs.writeFile(sourcePath, "Crash recovery marker AMBER-204.", "utf8");
    const grant = await api("POST", "/api/assistant/workspace-roots", { path: recoveryRoot });
    await waitForJob(grant.scanJobId);
    const itemId = (await api("POST", "/api/assistant/search", { query: "AMBER-204" })).results[0].itemId;
    const row = context.assistantManager.store.db.prepare("SELECT * FROM items WHERE id=?").get(itemId);
    const operation = {
      itemId,
      action: { type: "rename", template: "after-restart.{extension}" },
      before: { path: sourcePath, tags: [], summary: row.summary },
      after: { path: destinationPath, tags: [], summary: row.summary },
      fingerprint: row.fingerprint,
      revision: Number(row.revision),
      metadataRevision: Number(row.metadata_revision)
    };
    const journalId = `automation-operation-${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    context.assistantManager.store.db.prepare("INSERT INTO automation_operations(id,plan_id,operation_index,action,phase,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(journalId, "crash-plan", 0, "rename", "relocated", JSON.stringify({ operation, sourcePath, destinationPath }), timestamp, timestamp);
    await context.close();
    await fs.rename(sourcePath, destinationPath);
    context = await startServer({ port: 0, defaultDownloadDir: path.join(root, "downloads"), assistantDataDir: dataDir, assistantRuntimeRoot: runtimeRoot, dht: false, lsd: false, tracker: false });
    await api("GET", "/api/assistant/recipes");
    const recoveredRow = context.assistantManager.store.db.prepare("SELECT canonical_path FROM items WHERE id=?").get(itemId);
    assert.equal(path.resolve(recoveredRow.canonical_path), path.resolve(destinationPath));
    assert.equal(context.assistantManager.store.db.prepare("SELECT phase FROM automation_operations WHERE id=?").get(journalId).phase, "published");
    const activity = (await api("GET", "/api/assistant/activity?limit=100")).records.find((entry) => entry.action === "automation.recovered" && entry.related?.planId === "crash-plan");
    assert.equal(activity.undo.eligible, true);
    const undo = await api("POST", `/api/assistant/activity/${activity.id}/undo`, { confirmation: true });
    assert.equal((await waitForJob(undo.id)).status, "completed");
    assert.equal(await fs.readFile(sourcePath, "utf8"), "Crash recovery marker AMBER-204.");
    await assert.rejects(fs.stat(destinationPath), { code: "ENOENT" });
  });

  it("clears Assistant-owned index data while preserving referenced source files", async () => {
    const referenced = path.join(workspaceDir, "preserved.txt");
    await fs.writeFile(referenced, "Never delete this referenced source.", "utf8");
    const grant = await api("POST", "/api/assistant/workspace-roots", { path: workspaceDir });
    await waitForJob(grant.scanJobId);
    const managed = await importText("managed-clear.txt", "Managed clear marker.");
    const managedPath = context.assistantManager.store.db.prepare("SELECT managed_path FROM items WHERE id=?").get(managed.id).managed_path;
    const cleared = await api("POST", "/api/assistant/privacy-clear", { scopes: ["workspace-index"], confirmation: true });
    assert.deepEqual(cleared.cleared, ["workspace-index"]);
    assert.equal(await fs.readFile(referenced, "utf8"), "Never delete this referenced source.");
    await assert.rejects(fs.stat(managedPath), { code: "ENOENT" });
    assert.equal(context.assistantManager.store.db.prepare("SELECT COUNT(*) AS count FROM chunks").get().count, 0);
    assert.equal(context.assistantManager.store.db.prepare("SELECT COUNT(*) AS count FROM chunks_fts").get().count, 0);
  });

  it("treats privacy clear as a barrier against an active workspace scan", async () => {
    const raceRoot = path.join(root, "privacy-race");
    await fs.mkdir(raceRoot, { recursive: true });
    await Promise.all(Array.from({ length: 30 }, (_, index) => fs.writeFile(path.join(raceRoot, `document-${index}.txt`), `Privacy barrier ${index} ${"x".repeat(4096)}`, "utf8")));
    const grant = await api("POST", "/api/assistant/workspace-roots", { path: raceRoot });
    await api("POST", "/api/assistant/privacy-clear", { scopes: ["workspace-index"], confirmation: true });
    await waitForJob(grant.scanJobId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(context.assistantManager.store.db.prepare("SELECT COUNT(*) AS count FROM items").get().count, 0);
    assert.equal(context.assistantManager.store.db.prepare("SELECT COUNT(*) AS count FROM chunks").get().count, 0);
    assert.equal(context.assistantManager.store.db.prepare("SELECT COUNT(*) AS count FROM workspace_roots").get().count, 0);
  });

  it("answers runtime identity from trusted metadata without web search", async () => {
    const runtime = context.assistantModelRuntime;
    const originalStatus = runtime.status;
    const originalIdentity = runtime.runtimeIdentity;
    const identity = { id: "qwen3.5-9b-q4-k-m", displayName: "Qwen 3.5 9B Q4_K_M", manifestRevision: "2026-08-07.1", identity: "qwen3.5-9b-q4-k-m@2026-08-07.1" };
    const requestId = crypto.randomUUID();
    runtime.status = () => ({ generation: "ready", activeModels: { generation: identity.identity } });
    runtime.runtimeIdentity = () => identity;
    try {
      const result = await context.assistantGroundedChat.ask({ requestId, message: "小爱你用什么模型？", onlineSearch: "auto" });
      assert.equal(result.model, identity.identity);
      assert.equal(result.onlineSearch, false);
      assert.equal(result.grounding, "model-only");
      assert.equal(result.retrieval, "none");
      assert.deepEqual(result.sources, []);
      assert.match(result.answer, /Qwen 3\.5 9B Q4_K_M/u);
      assert.match(result.answer, /不是 DeepSeek R1/u);
      await context.assistantGroundedChat.removeConversation(result.conversationId);
    } finally {
      runtime.status = originalStatus;
      runtime.runtimeIdentity = originalIdentity;
    }
  });

  it("rejects grounded chat honestly when no generation model is active", async () => {
    await assert.rejects(
      api("POST", "/api/assistant/chat", { requestId: crypto.randomUUID(), message: "Answer locally." }),
      (error) => error.code === "assistant_model_unavailable" && error.status === 503
    );
  });
});
