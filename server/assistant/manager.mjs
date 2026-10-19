import { createReadStream } from "node:fs";
import fsSync from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";
import { AssistantStore } from "./store.mjs";
import {
  ASSISTANT_FILE_EXTENSIONS,
  assistantError,
  assertDirectoryNoLinks,
  assertRegularFileNoLinks,
  boundedText,
  clampInteger,
  contentTypeForName,
  createId,
  enumerateSupportedFiles,
  isPathInside,
  isoNow,
  jsonParse,
  normalizePathKey,
  safeDisplayName,
  sendAssistantError,
  sha256
} from "./utils.mjs";

const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_FILES = 20;
const MAX_IMPORT_TOTAL_BYTES = 100 * 1024 * 1024;

function serializeItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    state: row.state,
    source: row.source,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    fingerprint: row.fingerprint,
    revision: Number(row.revision),
    metadataRevision: Number(row.metadata_revision),
    tags: jsonParse(row.tags_json, []),
    summary: row.summary,
    origins: jsonParse(row.origins_json, []),
    detailsRef: row.details_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.last_error ? jsonParse(row.last_error, { code: "index_failed", message: row.last_error }) : null
  };
}

function serializeRoot(row) {
  if (!row) return null;
  return {
    id: row.id,
    path: row.canonical_path,
    generation: Number(row.generation),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scanJobId: row.last_scan_job_id || null
  };
}

function serializeJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    stage: row.stage,
    message: row.message,
    progress: row.progress === null ? null : Number(row.progress),
    cancellable: Boolean(row.cancellable),
    counts: {
      requested: Number(row.requested),
      completed: Number(row.completed),
      failed: Number(row.failed),
      skipped: Number(row.skipped)
    },
    result: jsonParse(row.result_json, null),
    error: jsonParse(row.error_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeActivity(row) {
  if (!row) return null;
  return {
    id: row.id,
    sequence: Number(row.sequence),
    kind: row.kind,
    action: row.action,
    status: row.status,
    summary: row.summary,
    counts: jsonParse(row.counts_json, null),
    related: jsonParse(row.related_json, null),
    operations: jsonParse(row.operations_json, null),
    undo: jsonParse(row.undo_json, null),
    detailsRef: row.details_ref,
    createdAt: row.created_at
  };
}

async function hashFile(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

export function createAssistantManager({ dataDir, now = Date.now, providers = [], voiceProfileStorePath = "" } = {}) {
  if (!dataDir) throw new Error("Assistant dataDir is required.");
  const store = new AssistantStore(dataDir);
  const router = express.Router();
  const stagingDir = path.join(store.dataDir, "staging", "imports");
  fsSync.mkdirSync(stagingDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_request, _file, callback) => callback(null, stagingDir),
      filename: (_request, _file, callback) => callback(null, createId("upload"))
    }),
    limits: { files: MAX_IMPORT_FILES, fileSize: MAX_IMPORT_FILE_BYTES }
  });
  const inboxDir = path.join(store.dataDir, "inbox");
  const jobControllers = new Map();
  const jobPromises = new Map();
  const itemLockTails = new Map();
  const providerRuntimes = [];
  const capabilityStates = new Map();
  const closeHooks = [];
  let indexer = null;
  let closed = false;
  let readyState = "initializing";
  let readyError = null;
  let workspaceClearing = false;
  let voiceRuntimeState = { effectiveMode: "idle", effectiveProfileId: null, degradedReason: null };

  fs.mkdir(inboxDir, { recursive: true }).catch(() => {});
  store.db.prepare("UPDATE jobs SET status='failed', stage='interrupted', message='Interrupted by restart', cancellable=0, error_json=?, updated_at=? WHERE status IN ('queued','running')")
    .run(JSON.stringify({ code: "interrupted_by_restart", message: "The job was interrupted by an application restart.", retryable: true }), isoNow(now));

  function deleteIndexForItems(itemIds) {
    for (const itemId of itemIds) {
      const chunkIds = store.db.prepare("SELECT id FROM chunks WHERE item_id=?").all(itemId);
      for (const row of chunkIds) store.db.prepare("DELETE FROM chunks_fts WHERE chunk_id=?").run(row.id);
      store.db.prepare("DELETE FROM chunks WHERE item_id=?").run(itemId);
    }
  }

  function enforceRetention() {
    const retention = store.getRetention();
    const current = now();
    store.transaction(() => {
      store.db.prepare("DELETE FROM undo_entries WHERE used_at IS NOT NULL OR expires_at<=?").run(new Date(current).toISOString());
      if (retention.conversationDays !== null) {
        const cutoff = new Date(current - Number(retention.conversationDays) * 86_400_000).toISOString();
        store.db.prepare("DELETE FROM conversations WHERE updated_at<?").run(cutoff);
        store.db.prepare("DELETE FROM chat_requests WHERE updated_at<?").run(cutoff);
      }
      if (retention.activityDays !== null) {
        const cutoff = new Date(current - Number(retention.activityDays) * 86_400_000).toISOString();
        store.db.prepare("DELETE FROM activity WHERE created_at<? AND id NOT IN (SELECT activity_id FROM undo_entries WHERE used_at IS NULL AND expires_at>?)").run(cutoff, new Date(current).toISOString());
      }
    });
  }

  enforceRetention();

  const ready = initializeProviders();

  async function initializeProviders() {
    try {
      const seen = new Set();
      for (const factory of providers) {
        if (!factory?.id || seen.has(factory.id)) throw new Error("Invalid or duplicate Assistant provider ID.");
        seen.add(factory.id);
        const runtime = await factory.initialize({ signal: AbortSignal.timeout(30_000) });
        providerRuntimes.push({ factory, runtime });
      }
      for (const { factory, runtime } of providerRuntimes) {
        await runtime.activate?.({ services: createProviderServices(factory), signal: AbortSignal.timeout(30_000) });
      }
      for (const { factory, runtime } of providerRuntimes) {
        await runtime.recover?.({ services: createProviderServices(factory), startupRecoveryToken: createId("recovery"), signal: AbortSignal.timeout(30_000) });
      }
      readyState = "ready";
    } catch (error) {
      readyState = "failed";
      readyError = error;
      throw error;
    }
  }

  function createProviderServices(factory) {
    const scopes = new Set(factory?.serviceScopes || []);
    const services = { lifecycle: Object.freeze({ whenReady: () => ready }) };
    if (scopes.has("jobs")) services.jobs = Object.freeze({ start: startJob, get: getJob, cancel: cancelJob });
    if (scopes.has("activity")) services.activity = Object.freeze({ currentGeneration, append: appendActivity, list: listActivity });
    if (scopes.has("events:subscribe")) services.events = Object.freeze({ read: readEvents, acknowledge: acknowledgeEvents });
    if (scopes.has("events:publish")) services.eventPublisher = Object.freeze({ publish: publishEvent });
    return Object.freeze(services);
  }

  function ensureOpen() {
    if (closed) throw assistantError("assistant_not_active", "The private assistant is shutting down.", 503, true);
  }

  function currentGeneration() {
    return Number(store.getMeta("activity_generation", "1"));
  }

  function getJob({ jobId } = {}) {
    return serializeJob(store.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId));
  }

  function updateJob(jobId, patch) {
    const current = store.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    if (!current) return null;
    const next = {
      status: patch.status ?? current.status,
      stage: boundedText(patch.stage ?? current.stage, 96),
      message: boundedText(patch.message ?? current.message, 512),
      progress: patch.progress === undefined ? current.progress : patch.progress,
      cancellable: patch.cancellable === undefined ? current.cancellable : Number(Boolean(patch.cancellable)),
      requested: patch.counts?.requested ?? current.requested,
      completed: patch.counts?.completed ?? current.completed,
      failed: patch.counts?.failed ?? current.failed,
      skipped: patch.counts?.skipped ?? current.skipped,
      result: patch.result === undefined ? current.result_json : JSON.stringify(patch.result),
      error: patch.error === undefined ? current.error_json : JSON.stringify(patch.error),
      updatedAt: isoNow(now)
    };
    if (next.progress !== null) next.progress = Math.max(Number(current.progress || 0), Math.min(100, Number(next.progress)));
    store.db.prepare(`UPDATE jobs SET status=?,stage=?,message=?,progress=?,cancellable=?,requested=?,completed=?,failed=?,skipped=?,result_json=?,error_json=?,updated_at=? WHERE id=?`)
      .run(next.status, next.stage, next.message, next.progress, next.cancellable, next.requested, next.completed, next.failed, next.skipped, next.result, next.error, next.updatedAt, jobId);
    return getJob({ jobId });
  }

  function startJob(initial, runner) {
    ensureOpen();
    const id = createId("job");
    const jobActivityGeneration = currentGeneration();
    const createdAt = isoNow(now);
    store.db.prepare(`INSERT INTO jobs(id,type,status,stage,message,progress,cancellable,requested,completed,failed,skipped,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, initial.type, "queued", boundedText(initial.stage || "queued", 96), boundedText(initial.message || "Waiting to start", 512), initial.progress ?? 0, Number(initial.cancellable !== false), initial.requested || 0, 0, 0, 0, initial.result ? JSON.stringify(initial.result) : null, createdAt, createdAt);
    const controller = new AbortController();
    jobControllers.set(id, controller);
    const promise = (async () => {
      updateJob(id, { status: "running", stage: initial.stage || "running", message: initial.message || "Working" });
      try {
        const result = await runner({
          jobId: id,
          signal: controller.signal,
          report: (next) => updateJob(id, next)
        });
        const state = controller.signal.aborted ? "cancelled" : "completed";
        const counts = result?.counts || {};
        updateJob(id, {
          status: state,
          stage: state,
          message: state === "cancelled" ? "Cancelled" : "Complete",
          progress: 100,
          cancellable: false,
          counts,
          result: result || null
        });
        await appendActivity({
          eventKey: `job:${id}:${state}`,
          activityGeneration: jobActivityGeneration,
          kind: "job",
          action: state === "cancelled" ? "job.cancelled" : "job.completed",
          status: state === "cancelled" ? "cancelled" : "completed",
          summary: `${initial.type} ${state}`,
          counts,
          related: { jobId: id, itemIds: result?.itemIds || [] }
        }).catch((error) => { if (error.code !== "activity_generation_stale") throw error; });
      } catch (error) {
        const cancelled = controller.signal.aborted || error?.code === "job_cancelled";
        updateJob(id, {
          status: cancelled ? "cancelled" : "failed",
          stage: cancelled ? "cancelled" : "failed",
          message: cancelled ? "Cancelled" : boundedText(error.message, 512),
          cancellable: false,
          error: { code: error.code || "provider_job_failed", message: boundedText(error.message, 512), retryable: Boolean(error.retryable) }
        });
        await appendActivity({
          eventKey: `job:${id}:${cancelled ? "cancelled" : "failed"}`,
          activityGeneration: jobActivityGeneration,
          kind: "job",
          action: cancelled ? "job.cancelled" : "job.failed",
          status: cancelled ? "cancelled" : "failed",
          summary: `${initial.type} ${cancelled ? "cancelled" : "failed"}`,
          related: { jobId: id }
        }).catch(() => {});
      } finally {
        jobControllers.delete(id);
        jobPromises.delete(id);
      }
    })();
    jobPromises.set(id, promise);
    return getJob({ jobId: id });
  }

  function cancelJob({ jobId } = {}) {
    const job = getJob({ jobId });
    if (!job) throw assistantError("job_not_found", "The job was not found.", 404);
    if (!["queued", "running"].includes(job.status) || !job.cancellable) {
      throw assistantError("job_not_cancellable", "This job has already reached a non-cancellable stage.", 409);
    }
    jobControllers.get(jobId)?.abort();
    return updateJob(jobId, { stage: "cancelling", message: "Cancelling at the next safe boundary", cancellable: false });
  }

  async function appendActivity(input) {
    ensureOpen();
    const generation = input.activityGeneration ?? currentGeneration();
    if (generation !== currentGeneration()) throw assistantError("activity_generation_stale", "The Activity generation changed.", 409, true);
    const canonical = JSON.stringify({
      kind: input.kind,
      action: input.action,
      status: input.status,
      summary: boundedText(input.summary, 512),
      counts: input.counts || null,
      related: input.related || null,
      operations: input.operations || null,
      undo: input.undo || null,
      detailsRef: input.detailsRef || null
    });
    const payloadHash = sha256(canonical);
    if (input.eventKey) {
      const existing = store.db.prepare("SELECT * FROM activity WHERE generation=? AND event_key=?").get(generation, input.eventKey);
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw assistantError("activity_event_conflict", "Activity event identity was reused with different content.", 409);
        return serializeActivity(existing);
      }
    }
    const id = createId("activity");
    const createdAt = isoNow(now);
    store.db.prepare(`INSERT INTO activity(id,generation,event_key,payload_hash,kind,action,status,summary,counts_json,related_json,operations_json,undo_json,details_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, generation, input.eventKey || null, payloadHash, input.kind, input.action, input.status, boundedText(input.summary, 512), input.counts ? JSON.stringify(input.counts) : null, input.related ? JSON.stringify(input.related) : null, input.operations ? JSON.stringify(input.operations) : null, input.undo ? JSON.stringify(input.undo) : null, input.detailsRef || null, createdAt);
    return serializeActivity(store.db.prepare("SELECT * FROM activity WHERE id=?").get(id));
  }

  function listActivity({ offset = 0, limit = 50, kind, action } = {}) {
    const clauses = [];
    const args = [];
    if (kind) { clauses.push("kind=?"); args.push(kind); }
    if (action) { clauses.push("action=?"); args.push(action); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = Number(store.db.prepare(`SELECT COUNT(*) AS count FROM activity ${where}`).get(...args).count);
    const rows = store.db.prepare(`SELECT * FROM activity ${where} ORDER BY sequence DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { records: rows.map(serializeActivity), total };
  }

  function publishEvent(event) {
    const payload = JSON.stringify(event.payload || {});
    if (Buffer.byteLength(payload) > 64 * 1024) throw assistantError("event_payload_too_large", "Assistant events are limited to 64 KiB.", 400);
    const payloadHash = sha256(JSON.stringify({ type: event.type, payload, causationId: event.causationId || null, lineage: event.lineage || [] }));
    const existing = store.db.prepare("SELECT * FROM events WHERE id=?").get(event.id);
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw assistantError("event_identity_conflict", "Event identity was reused with different content.", 409);
      return { id: existing.id, sequence: Number(existing.sequence) };
    }
    const count = Number(store.db.prepare("SELECT COUNT(*) AS count FROM events").get().count);
    if (count >= 10_000) throw assistantError("event_queue_full", "The Assistant event queue is full.", 503, true);
    store.db.prepare("INSERT INTO events(id,type,payload_json,payload_hash,causation_id,lineage_json,blocked_job_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(event.id, event.type, payload, payloadHash, event.causationId || null, JSON.stringify(event.lineage || []), event.blockedOnIndexJobId || null, isoNow(now));
    const row = store.db.prepare("SELECT sequence FROM events WHERE id=?").get(event.id);
    return { id: event.id, sequence: Number(row.sequence) };
  }

  function readEvents({ subscriberId, limit = 100 } = {}) {
    const cursor = Number(store.db.prepare("SELECT last_sequence FROM event_cursors WHERE subscriber_id=?").get(subscriberId)?.last_sequence || 0);
    const rows = store.db.prepare(`SELECT e.* FROM events e LEFT JOIN jobs j ON j.id=e.blocked_job_id WHERE e.sequence>? AND (e.blocked_job_id IS NULL OR j.status IN ('completed','failed','cancelled')) ORDER BY e.sequence LIMIT ?`).all(cursor, limit);
    return rows.map((row) => ({
      id: row.id,
      sequence: Number(row.sequence),
      type: row.type,
      payload: jsonParse(row.payload_json, {}),
      causationId: row.causation_id,
      lineage: jsonParse(row.lineage_json, []),
      createdAt: row.created_at
    }));
  }

  function acknowledgeEvents({ subscriberId, sequence } = {}) {
    store.db.prepare("INSERT INTO event_cursors(subscriber_id,last_sequence) VALUES(?,?) ON CONFLICT(subscriber_id) DO UPDATE SET last_sequence=MAX(last_sequence,excluded.last_sequence)").run(subscriberId, sequence);
    return { acknowledged: Number(sequence) };
  }

  function setIndexer(nextIndexer) {
    indexer = nextIndexer;
    capabilityStates.set("contentIndex", nextIndexer ? "ready" : "metadata-only");
  }

  function setCapability(name, state) {
    capabilityStates.set(name, state);
  }

  function registerCloseHook(hook) {
    if (typeof hook === "function") closeHooks.push(hook);
  }

  async function withItemLock(itemId, task) {
    const key = String(itemId);
    const previous = itemLockTails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    itemLockTails.set(key, tail);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (itemLockTails.get(key) === tail) itemLockTails.delete(key);
    }
  }

  function withPathLock(pathKey, task) {
    return withItemLock(`path:${normalizePathKey(pathKey)}`, task);
  }

  async function indexItemUnlocked(itemId, { signal, report, commitGuard, expectedWorkspaceGeneration, validateBeforeCommit } = {}) {
    if (workspaceClearing) throw assistantError("workspace_clear_in_progress", "The Assistant workspace is being cleared.", 409, true);
    const row = store.db.prepare("SELECT * FROM items WHERE id=?").get(itemId);
    if (!row) throw assistantError("item_not_found", "The item was not found.", 404);
    const workspaceGeneration = expectedWorkspaceGeneration ?? Number(store.getMeta("workspace_generation", "1"));
    const canCommit = () => Number(store.getMeta("workspace_generation", "1")) === workspaceGeneration
      && Boolean(store.db.prepare("SELECT id FROM items WHERE id=?").get(itemId))
      && (!commitGuard || commitGuard());
    if (signal?.aborted) throw assistantError("job_cancelled", "The job was cancelled.", 409);
    const fingerprint = await hashFile(row.managed_path || row.canonical_path);
    const revision = row.fingerprint === fingerprint ? Number(row.revision) : Number(row.revision) + 1;
    let result = { state: "metadata-only", extractedText: null, detailsRef: null, summary: null };
    if (indexer) {
      result = await indexer.index({ item: serializeItem({ ...row, fingerprint, revision }), filePath: row.managed_path || row.canonical_path, signal, report, canCommit, validateBeforeCommit });
    }
    await validateBeforeCommit?.();
    if (!canCommit()) throw assistantError("stale_workspace_generation", "The Assistant workspace changed before indexing could commit.", 409, true);
    store.db.prepare("UPDATE items SET state=?,fingerprint=?,revision=?,details_ref=?,extracted_text=?,summary=COALESCE(?,summary),last_error=NULL,updated_at=? WHERE id=?")
      .run(result.state || "metadata-only", fingerprint, revision, result.detailsRef || null, result.extractedText || null, result.summary || null, isoNow(now), itemId);
    return serializeItem(store.db.prepare("SELECT * FROM items WHERE id=?").get(itemId));
  }

  async function indexItem(itemId, options = {}) {
    if (options.itemLockHeld) return indexItemUnlocked(itemId, options);
    const row = store.db.prepare("SELECT path_key FROM items WHERE id=?").get(itemId);
    if (!row) throw assistantError("item_not_found", "The item was not found.", 404);
    return withPathLock(row.path_key, () => indexItemUnlocked(itemId, options));
  }

  async function admitAndIndexReferencedItem({ canonical, stats, root, source = "workspace", expectedWorkspaceGeneration, indexOptions = {} }) {
    return withPathLock(canonical, async () => {
      const itemId = upsertReferencedItem({ canonical, stats, root, source, expectedWorkspaceGeneration });
      const item = await indexItemUnlocked(itemId, { ...indexOptions, itemLockHeld: true, expectedWorkspaceGeneration });
      return { itemId, item };
    });
  }

  function upsertReferencedItem({ canonical, stats, root, source = "workspace", expectedWorkspaceGeneration, returnDetails = false }) {
    if (workspaceClearing || (expectedWorkspaceGeneration !== undefined && Number(store.getMeta("workspace_generation", "1")) !== Number(expectedWorkspaceGeneration))) {
      throw assistantError("stale_workspace_generation", "The Assistant workspace changed before the item could be admitted.", 409, true);
    }
    if (source === "workspace") {
      const liveRoot = store.db.prepare("SELECT generation FROM workspace_roots WHERE id=?").get(root.id);
      if (!liveRoot || Number(liveRoot.generation) !== Number(root.generation)) {
        throw assistantError("workspace_root_revoked", "The workspace permission changed before the item could be admitted.", 409, true);
      }
    }
    const pathKey = normalizePathKey(canonical);
    const existing = store.db.prepare("SELECT * FROM items WHERE path_key=? ORDER BY created_at LIMIT 1").get(pathKey);
    const nowValue = isoNow(now);
    const origin = source === "workspace"
      ? { kind: "workspace", rootId: root.id, generation: Number(root.generation) }
      : { kind: "tool", toolId: source, generation: 1 };
    if (existing) {
      const previousItem = { ...existing };
      const origins = jsonParse(existing.origins_json, []);
      if (!origins.some((candidate) => JSON.stringify(candidate) === JSON.stringify(origin))) origins.push(origin);
      store.db.prepare("UPDATE items SET size_bytes=?,origins_json=?,updated_at=? WHERE id=?")
        .run(stats.size, JSON.stringify(origins.slice(0, 20)), nowValue, existing.id);
      return returnDetails ? { itemId: existing.id, created: false, previousItem } : existing.id;
    }
    const id = createId("item");
    store.db.prepare(`INSERT INTO items(id,display_name,canonical_path,path_key,managed_path,source,state,content_type,size_bytes,fingerprint,revision,origins_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, safeDisplayName(canonical), canonical, pathKey, null, source, "pending", contentTypeForName(canonical), stats.size, null, 0, JSON.stringify([origin]), nowValue, nowValue);
    return returnDetails ? { itemId: id, created: true, previousItem: null } : id;
  }

  async function createWorkspaceRoot(folderPath) {
    if (workspaceClearing) throw assistantError("workspace_clear_in_progress", "The Assistant workspace is being cleared.", 409, true);
    const canonical = await assertDirectoryNoLinks(folderPath);
    const pathKey = normalizePathKey(canonical);
    const existing = store.db.prepare("SELECT * FROM workspace_roots WHERE path_key=?").get(pathKey);
    if (existing) return { root: serializeRoot(existing), created: false, scanJobId: existing.last_scan_job_id || undefined };
    const id = createId("root");
    const createdAt = isoNow(now);
    store.db.prepare("INSERT INTO workspace_roots(id,canonical_path,path_key,generation,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(id, canonical, pathKey, 1, createdAt, createdAt);
    await appendActivity({ kind: "workspace", action: "workspace.granted", status: "completed", summary: `Workspace access granted for ${safeDisplayName(canonical)}`, related: { rootId: id } });
    const job = scanWorkspaceRoot(id);
    store.db.prepare("UPDATE workspace_roots SET last_scan_job_id=?,updated_at=? WHERE id=?").run(job.id, isoNow(now), id);
    return { root: serializeRoot(store.db.prepare("SELECT * FROM workspace_roots WHERE id=?").get(id)), created: true, scanJobId: job.id };
  }

  function scanWorkspaceRoot(rootId) {
    const root = store.db.prepare("SELECT * FROM workspace_roots WHERE id=?").get(rootId);
    if (!root) throw assistantError("workspace_root_not_found", "The workspace folder was not found.", 404);
    const workspaceGeneration = Number(store.getMeta("workspace_generation", "1"));
    const rootGeneration = Number(root.generation);
    const admissionValid = () => !workspaceClearing
      && Number(store.getMeta("workspace_generation", "1")) === workspaceGeneration
      && Number(store.db.prepare("SELECT generation FROM workspace_roots WHERE id=?").get(rootId)?.generation) === rootGeneration;
    return startJob({ type: "index", stage: "enumerating", message: "Finding documents", cancellable: true }, async ({ jobId, signal, report }) => {
      const canonical = await assertDirectoryNoLinks(root.canonical_path);
      const files = await enumerateSupportedFiles(canonical, { signal });
      const itemIds = [];
      let completed = 0;
      let failed = 0;
      report({ progress: files.length ? 5 : 100, stage: "indexing", message: `Indexing ${files.length} supported document(s)`, counts: { requested: files.length, completed: 0, failed: 0, skipped: 0 } });
      for (const filePath of files) {
        if (signal.aborted || !admissionValid()) break;
        try {
          const { canonical: fileCanonical, stats } = await assertRegularFileNoLinks(filePath);
          if (!isPathInside(canonical, fileCanonical)) continue;
          const { itemId: id } = await admitAndIndexReferencedItem({ canonical: fileCanonical, stats, root, source: "workspace", expectedWorkspaceGeneration: workspaceGeneration, indexOptions: { signal, report: () => {}, commitGuard: admissionValid } });
          itemIds.push(id);
          completed += 1;
        } catch (error) {
          failed += 1;
        }
        report({ progress: files.length ? Math.round(5 + 95 * ((completed + failed) / files.length)) : 100, stage: "indexing", message: `Indexed ${completed} of ${files.length}`, counts: { requested: files.length, completed, failed, skipped: 0 } });
      }
      if (admissionValid()) publishEvent({ id: createId("event"), type: "watch-folder", causationId: jobId, lineage: [], blockedOnIndexJobId: jobId, payload: { rootId, itemIds } });
      return { itemIds, rootId, counts: { requested: files.length, completed, failed, skipped: 0 } };
    });
  }

  async function importFiles(files) {
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (workspaceClearing) throw assistantError("workspace_clear_in_progress", "The Assistant workspace is being cleared.", 409, true);
    if (!files.length) throw assistantError("invalid_import", "Choose at least one file.", 400);
    if (totalBytes > MAX_IMPORT_TOTAL_BYTES) throw assistantError("import_too_large", "One import is limited to 100 MiB.", 400);
    const itemIds = [];
    try { for (const file of files) {
      const id = createId("item");
      const extension = path.extname(file.originalname).toLowerCase();
      const managedPath = path.join(inboxDir, `${id}${extension}`);
      const createdAt = isoNow(now);
      await fs.rename(file.path, managedPath);
      const fingerprint = await hashFile(managedPath);
      store.db.prepare(`INSERT INTO items(id,display_name,canonical_path,path_key,managed_path,source,state,content_type,size_bytes,fingerprint,revision,origins_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, safeDisplayName(file.originalname), managedPath, normalizePathKey(managedPath), managedPath, "manual", "pending", file.mimetype || contentTypeForName(file.originalname), file.size, fingerprint, 1, JSON.stringify([{ kind: "managed-import", importId: id }]), createdAt, createdAt);
      itemIds.push(id);
      await appendActivity({ kind: "item", action: "item.imported", status: "completed", summary: `${safeDisplayName(file.originalname)} added to Inbox`, related: { itemIds: [id] } });
    }} finally {
      await Promise.allSettled(files.map((file) => file.path ? fs.rm(file.path, { force: true }) : Promise.resolve()));
    }
    const job = startJob({ type: "index", stage: "indexing", message: `Indexing ${itemIds.length} imported document(s)`, cancellable: true, requested: itemIds.length }, async ({ signal, report }) => {
      let completed = 0;
      let failed = 0;
      for (const id of itemIds) {
        if (signal.aborted) break;
        try {
          await indexItem(id, { signal, report: () => {} });
          completed += 1;
        } catch (error) {
          failed += 1;
          store.db.prepare("UPDATE items SET state='failed',last_error=?,updated_at=? WHERE id=?")
            .run(JSON.stringify({ code: error.code || "index_failed", message: boundedText(error.message, 512) }), isoNow(now), id);
        }
        report({ progress: Math.round(100 * ((completed + failed) / itemIds.length)), stage: "indexing", message: `Indexed ${completed} of ${itemIds.length}`, counts: { requested: itemIds.length, completed, failed, skipped: 0 } });
      }
      return { itemIds, counts: { requested: itemIds.length, completed, failed, skipped: 0 } };
    });
    publishEvent({ id: createId("event"), type: "inbox-added", causationId: job.id, lineage: [], blockedOnIndexJobId: job.id, payload: { itemIds } });
    return { items: itemIds.map((id) => serializeItem(store.db.prepare("SELECT * FROM items WHERE id=?").get(id))), job };
  }

  function listItems({ query = "", state, source, offset = 0, limit = 50 } = {}) {
    const clauses = [];
    const args = [];
    if (query) { clauses.push("(LOWER(display_name) LIKE ? OR LOWER(COALESCE(summary,'')) LIKE ? OR LOWER(tags_json) LIKE ?)"); const like = `%${query.toLowerCase()}%`; args.push(like, like, like); }
    if (state) { clauses.push("state=?"); args.push(state); }
    if (source) { clauses.push("source=?"); args.push(source); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = Number(store.db.prepare(`SELECT COUNT(*) AS count FROM items ${where}`).get(...args).count);
    const rows = store.db.prepare(`SELECT * FROM items ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { items: rows.map(serializeItem), total };
  }

  async function removeItem(itemId) {
    const row = store.db.prepare("SELECT * FROM items WHERE id=?").get(itemId);
    if (!row) throw assistantError("item_not_found", "The item was not found.", 404);
    store.transaction(() => {
      deleteIndexForItems([itemId]);
      store.db.prepare("DELETE FROM items WHERE id=?").run(itemId);
    });
    if (row.managed_path) await fs.rm(row.managed_path, { force: true });
    await appendActivity({ kind: "item", action: "item.removed", status: "completed", summary: `${row.display_name} removed from Assistant`, related: { itemIds: [itemId] } });
    return { removedFromIndex: true, sourceFileDeleted: false, managedCopyDeleted: Boolean(row.managed_path) };
  }

  async function removeWorkspaceRoot(rootId) {
    const root = store.db.prepare("SELECT * FROM workspace_roots WHERE id=?").get(rootId);
    if (!root) throw assistantError("workspace_root_not_found", "The workspace folder was not found.", 404);
    const rows = store.db.prepare("SELECT * FROM items WHERE source='workspace'").all();
    store.transaction(() => {
      for (const row of rows) {
        const origins = jsonParse(row.origins_json, []).filter((origin) => !(origin.kind === "workspace" && origin.rootId === rootId));
        if (origins.length) store.db.prepare("UPDATE items SET origins_json=?,updated_at=? WHERE id=?").run(JSON.stringify(origins), isoNow(now), row.id);
        else {
          deleteIndexForItems([row.id]);
          store.db.prepare("DELETE FROM items WHERE id=?").run(row.id);
        }
      }
      store.db.prepare("DELETE FROM workspace_roots WHERE id=?").run(rootId);
    });
    await appendActivity({ kind: "workspace", action: "workspace.revoked", status: "completed", summary: `Workspace access removed for ${safeDisplayName(root.canonical_path)}`, related: { rootId } });
    return { removed: true, sourceFilesDeleted: false };
  }

  async function clearPrivacy({ scopes, confirmation, discardEligibleUndo = false }) {
    if (!confirmation || !Array.isArray(scopes) || !scopes.length) throw assistantError("invalid_clear_scope", "Choose data to clear and confirm the action.", 400);
    const allowed = new Set(["workspace-index", "conversations", "activity", "recipes", "model-records", "integrations", "all"]);
    if (scopes.some((scope) => !allowed.has(scope)) || (scopes.includes("all") && scopes.length !== 1)) throw assistantError("invalid_clear_scope", "The selected privacy scopes are invalid.", 400);
    const selected = scopes.includes("all") ? new Set([...allowed].filter((scope) => scope !== "all")) : new Set(scopes);
    const retained = [];
    const filesToDelete = [];
    if (selected.has("model-records")) {
      const installed = Number(store.db.prepare("SELECT COUNT(*) AS count FROM models WHERE state='ready'").get().count);
      if (installed) retained.push({ scope: "model-records", reason: "Remove installed models before clearing their records." });
    }
    if (selected.has("activity") && !discardEligibleUndo) {
      const eligible = Number(store.db.prepare("SELECT COUNT(*) AS count FROM undo_entries WHERE used_at IS NULL AND expires_at>?").get(isoNow(now)).count);
      if (eligible) retained.push({ scope: "activity", reason: "Eligible undo records require explicit discard confirmation." });
    }
    if (selected.has("recipes") && !discardEligibleUndo) {
      const eligible = Number(store.db.prepare("SELECT COUNT(*) AS count FROM undo_entries WHERE used_at IS NULL AND expires_at>?").get(isoNow(now)).count);
      if (eligible) retained.push({ scope: "recipes-undo", reason: "Eligible undo records were retained until expiry." });
    }
    if (selected.has("workspace-index")) {
      if (workspaceClearing) throw assistantError("workspace_clear_in_progress", "The Assistant workspace is already being cleared.", 409, true);
      workspaceClearing = true;
      store.setMeta("workspace_generation", Number(store.getMeta("workspace_generation", "1")) + 1);
      const activeIndexJobIds = store.db.prepare("SELECT id FROM jobs WHERE type='index' AND status IN ('queued','running')").all().map((row) => row.id);
      for (const jobId of activeIndexJobIds) jobControllers.get(jobId)?.abort();
      await Promise.allSettled(activeIndexJobIds.map((jobId) => jobPromises.get(jobId)).filter(Boolean));
    }
    try { store.transaction(() => {
      if (selected.has("workspace-index")) {
        for (const row of store.db.prepare("SELECT managed_path FROM items WHERE managed_path IS NOT NULL").all()) filesToDelete.push(row.managed_path);
        store.db.exec("DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM items; DELETE FROM workspace_roots;");
      }
      if (selected.has("conversations")) store.db.exec("DELETE FROM conversations; DELETE FROM chat_requests; DELETE FROM assistant_memories; DELETE FROM activity_outbox WHERE owner='chat';");
      if (selected.has("recipes")) {
        store.db.exec("DELETE FROM recipes; DELETE FROM plans;");
        if (discardEligibleUndo) store.db.exec("DELETE FROM undo_entries; DELETE FROM automation_operations;");
        else store.db.exec("DELETE FROM automation_operations WHERE phase IN ('abandoned','published');");
      }
      if (selected.has("integrations")) store.db.exec("DELETE FROM integration_deliveries; UPDATE integrations SET enabled=0,output_root=NULL,generation=generation+1,pending_count=0,failed_count=0;");
      if (selected.has("model-records") && !retained.some((entry) => entry.scope === "model-records")) store.db.exec("DELETE FROM models;");
      if (selected.has("activity") && !retained.some((entry) => entry.scope === "activity")) {
        store.db.exec("DELETE FROM activity;");
        if (discardEligibleUndo) store.db.exec("DELETE FROM undo_entries; DELETE FROM automation_operations WHERE phase='published';");
        store.setMeta("activity_generation", currentGeneration() + 1);
      }
    }); } finally {
      workspaceClearing = false;
    }
    for (const filePath of filesToDelete) await fs.rm(filePath, { force: true }).catch(() => {});
    const cleared = [...selected].filter((scope) => !retained.some((entry) => entry.scope === scope));
    if (!selected.has("activity")) {
      await appendActivity({ kind: "privacy", action: "privacy.cleared", status: "completed", summary: `Cleared ${cleared.join(", ")}`, counts: { requested: scopes.length, completed: cleared.length, failed: 0, skipped: retained.length } });
    }
    return { cleared, retained, clearCommitted: true, quarantinePending: false };
  }

  function capabilityStatus() {
    const providerStatus = Object.fromEntries(providerRuntimes.map(({ factory, runtime }) => [factory.id, runtime.status?.() || { state: "ready" }]));
    const activeJobs = Number(store.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','running')").get().count);
    const itemCount = Number(store.db.prepare("SELECT COUNT(*) AS count FROM items").get().count);
    const activityCount = Number(store.db.prepare("SELECT COUNT(*) AS count FROM activity").get().count);
    return {
      state: readyState,
      recovery: readyError ? { code: "assistant_initialization_failed", message: boundedText(readyError.message, 512) } : null,
      capabilities: {
        inbox: "ready",
        workspaceRoots: "ready",
        jobs: "ready",
        activity: "ready",
        retention: "ready",
        models: capabilityStates.get("models") || (providerStatus["local-model-runtime"]?.state === "ready" ? "ready" : "unavailable"),
        contentIndex: capabilityStates.get("contentIndex") || (indexer ? "ready" : "metadata-only"),
        chat: capabilityStates.get("chat") || (providerStatus["grounded-chat"]?.state === "ready" ? "ready" : "unavailable"),
        automation: capabilityStates.get("automation") || (providerStatus["automation-engine"]?.state === "ready" ? "ready" : "unavailable"),
        toolIntegrations: capabilityStates.get("toolIntegrations") || (providerStatus["tool-integrations"]?.state === "ready" ? "ready" : "unavailable")
      },
      counts: { items: itemCount, activity: activityCount, activeJobs },
      providers: providerStatus,
      privacy: { localOnly: true, cloudInference: false }
    };
  }

  function assistantVoicePreferences() {
    const stored = jsonParse(store.getMeta("assistant_voice_preferences"), null);
    const defaults = { mode: "system", profileId: "", requestedMode: "system", requestedProfileId: "", systemVoiceURI: "", speed: 1, pitch: 0, styleStrength: 0.7, similarityStrength: 0.8, language: "auto", voicePipelineVersion: 4, speechRendering: "naturalized-full", resourceProfile: "balanced-local" };
    const preferences = stored && typeof stored === "object" ? stored : {};
    const requestedMode = ["system", "streaming", "trained"].includes(preferences.requestedMode || preferences.mode) ? (preferences.requestedMode || preferences.mode) : "system";
    const requestedProfileId = boundedText(preferences.requestedProfileId ?? preferences.profileId ?? "", 128);
    return {
      ...defaults,
      ...preferences,
      mode: requestedMode,
      profileId: requestedProfileId,
      requestedMode,
      requestedProfileId,
      effectiveMode: voiceRuntimeState.effectiveMode,
      effectiveProfileId: voiceRuntimeState.effectiveProfileId,
      degradedReason: voiceRuntimeState.degradedReason,
      revision: Math.max(0, Number(preferences.revision) || 0),
      updatedAt: preferences.updatedAt || null,
      assistantDbPath: store.dbPath,
      runtimeDataRoot: store.dataDir,
      voiceProfileStorePath: voiceProfileStorePath || path.join(store.dataDir, "voice-profiles"),
      configured: Boolean(stored && requestedMode)
    };
  }

  function saveAssistantVoicePreferences(input) {
    const mode = ["system", "streaming", "trained"].includes(input?.requestedMode ?? input?.mode) ? (input.requestedMode ?? input.mode) : "system";
    const profileId = boundedText(input?.requestedProfileId ?? input?.profileId ?? "", 128);
    const previous = jsonParse(store.getMeta("assistant_voice_preferences"), {}) || {};
    const revision = Math.max(0, Number(previous.revision) || 0) + 1;
    const updatedAt = isoNow(now);
    const preferences = {
      mode,
      profileId,
      requestedMode: mode,
      requestedProfileId: profileId,
      systemVoiceURI: boundedText(input?.systemVoiceURI || "", 512),
      speed: Math.max(0.7, Math.min(1.3, Number(input?.speed) || 1)),
      pitch: Math.max(-1.5, Math.min(1.5, Number(input?.pitch) || 0)),
      styleStrength: Math.max(0, Math.min(1, Number(input?.styleStrength) || 0.7)),
      similarityStrength: Math.max(0, Math.min(1, Number(input?.similarityStrength) || 0.8)),
      language: "auto",
      voicePipelineVersion: 4,
      speechRendering: "naturalized-full",
      resourceProfile: "balanced-local",
      revision,
      updatedAt
    };
    store.transaction(() => store.setMeta("assistant_voice_preferences", JSON.stringify(preferences)));
    voiceRuntimeState = mode === "system"
      ? { effectiveMode: "system", effectiveProfileId: null, degradedReason: null }
      : { effectiveMode: "warming", effectiveProfileId: null, degradedReason: null };
    return { ...preferences, effectiveMode: voiceRuntimeState.effectiveMode, effectiveProfileId: voiceRuntimeState.effectiveProfileId, degradedReason: null, configured: true, assistantDbPath: store.dbPath, runtimeDataRoot: store.dataDir, voiceProfileStorePath: voiceProfileStorePath || path.join(store.dataDir, "voice-profiles") };
  }

  function setVoiceRuntimeState(next = {}) {
    voiceRuntimeState = {
      effectiveMode: String(next.effectiveMode || "idle"),
      effectiveProfileId: next.effectiveProfileId || null,
      degradedReason: next.degradedReason || null
    };
    return assistantVoicePreferences();
  }

  function onlineSearchPreference() {
    return { enabled: store.getMeta("assistant_online_search", "0") === "1" };
  }

  function route(handler) {
    return async (request, response) => {
      try {
        await ready;
        const result = await handler(request, response);
        if (response.headersSent) return;
        response.json(result);
      } catch (error) {
        sendAssistantError(response, error);
      }
    };
  }

  router.get("/status", route(() => capabilityStatus()));
  router.get("/preferences/voice", route(() => assistantVoicePreferences()));
  router.put("/preferences/voice", route((request) => saveAssistantVoicePreferences(request.body || {})));
  router.get("/preferences/network", route(() => onlineSearchPreference()));
  router.put("/preferences/network", route((request) => {
    store.setMeta("assistant_online_search", request.body?.enabled === true ? "1" : "0");
    return onlineSearchPreference();
  }));
  router.get("/items", route((request) => listItems({
    query: boundedText(request.query.query || "", 256),
    state: request.query.state,
    source: request.query.source,
    offset: clampInteger(request.query.offset, 0, 1_000_000, 0),
    limit: clampInteger(request.query.limit, 1, 100, 50)
  })));
  router.post("/items/import", upload.array("files", MAX_IMPORT_FILES), route((request) => importFiles(request.files || [])));
  router.post("/items/:itemId/index", route((request) => startJob({ type: "index", stage: "indexing", message: "Re-indexing document", cancellable: true, requested: 1 }, async ({ signal }) => {
    const item = await indexItem(request.params.itemId, { signal });
    return { itemIds: [item.id], counts: { requested: 1, completed: 1, failed: 0, skipped: 0 } };
  })));
  router.delete("/items/:itemId", route((request) => removeItem(request.params.itemId)));
  router.get("/workspace-roots", route(() => ({ roots: store.db.prepare("SELECT * FROM workspace_roots ORDER BY created_at,id").all().map(serializeRoot) })));
  router.post("/workspace-roots", route((request) => createWorkspaceRoot(request.body?.path)));
  router.post("/workspace-roots/:rootId/scan", route((request) => scanWorkspaceRoot(request.params.rootId)));
  router.delete("/workspace-roots/:rootId", route((request) => removeWorkspaceRoot(request.params.rootId)));
  router.get("/jobs/:jobId", route((request) => {
    const job = getJob({ jobId: request.params.jobId });
    if (!job) throw assistantError("job_not_found", "The job was not found.", 404);
    return job;
  }));
  router.post("/jobs/:jobId/cancel", route((request) => cancelJob({ jobId: request.params.jobId })));
  router.get("/activity", route((request) => listActivity({
    offset: clampInteger(request.query.offset, 0, 1_000_000, 0),
    limit: clampInteger(request.query.limit, 1, 100, 50),
    kind: request.query.kind,
    action: request.query.action
  })));
  router.get("/privacy-retention", route(() => store.getRetention()));
  router.put("/privacy-retention", route(async (request) => {
    const next = request.body || {};
    const conversationDays = next.conversationDays === null ? null : clampInteger(next.conversationDays, 1, 3650, NaN);
    const activityDays = next.activityDays === null ? null : clampInteger(next.activityDays, 1, 3650, NaN);
    const undoDays = [1, 7, 30].includes(Number(next.undoDays)) ? Number(next.undoDays) : NaN;
    if (Number.isNaN(conversationDays) || Number.isNaN(activityDays) || Number.isNaN(undoDays)) throw assistantError("invalid_retention", "Retention must use valid day values; undo supports 1, 7, or 30 days.", 400);
    const retention = { conversationDays, activityDays, undoDays };
    store.setMeta("retention", JSON.stringify(retention));
    enforceRetention();
    await appendActivity({ kind: "privacy", action: "privacy.retention-updated", status: "completed", summary: "Privacy retention updated" });
    return retention;
  }));
  router.post("/privacy-clear", route((request) => clearPrivacy(request.body || {})));

  async function close() {
    if (closed) return;
    closed = true;
    for (const controller of jobControllers.values()) controller.abort();
    await Promise.race([
      Promise.allSettled([...jobPromises.values()]),
      new Promise((resolve) => setTimeout(resolve, 10_000))
    ]);
    await Promise.allSettled([...closeHooks].reverse().map((hook) => hook()));
    await Promise.allSettled([...providerRuntimes].reverse().map(({ runtime }) => runtime.close?.({ signal: AbortSignal.timeout(30_000) })));
    store.close();
  }

  return {
    router,
    ready,
    store,
    core: {
      setIndexer,
      setCapability,
      registerCloseHook,
      withItemLock,
      withPathLock,
      indexItem,
      admitAndIndexReferencedItem,
      listItems,
      getItemRow: (id) => store.db.prepare("SELECT * FROM items WHERE id=?").get(id),
      serializeItem,
      startJob,
      getJob,
      cancelJob,
      activity: { currentGeneration, append: appendActivity, list: listActivity },
      events: { publish: publishEvent, read: readEvents, acknowledge: acknowledgeEvents },
      upsertReferencedItem,
      hashFile
    },
    status: capabilityStatus,
    voicePreferences: assistantVoicePreferences,
    setVoiceRuntimeState,
    close
  };
}
