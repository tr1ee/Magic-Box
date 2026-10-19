import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { assistantError, assertDirectoryNoLinks, assertRegularFileNoLinks, createId, isPathInside, isoNow, jsonParse, normalizePathKey, sendAssistantError, sha256 } from "./utils.mjs";

export const ASSISTANT_INTEGRATION_TOOLS = ["images", "videos", "file-transfer", "format-factory"];

function stableUuid(value) {
  const hex = createHash("sha256").update(String(value)).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function serializeIntegration(row) {
  return {
    toolId: row.tool_id,
    enabled: Boolean(row.enabled),
    outputRootPath: row.output_root,
    generation: Number(row.generation),
    pendingCount: Number(row.pending_count),
    failedCount: Number(row.failed_count),
    updatedAt: row.updated_at
  };
}

export function createToolIntegrations({ manager }) {
  const { store, core, router } = manager;
  core.setCapability("toolIntegrations", "ready");
  const initializedAt = isoNow();
  const deliveryPromises = new Map();
  const capturePromises = new Map();
  const completionPayloadHashes = new Map();
  for (const toolId of ASSISTANT_INTEGRATION_TOOLS) {
    store.db.prepare("INSERT OR IGNORE INTO integrations(tool_id,enabled,output_root,generation,pending_count,failed_count,updated_at) VALUES(?,0,NULL,0,0,0,?)").run(toolId, initializedAt);
  }

  function getIntegration(toolId) {
    if (!ASSISTANT_INTEGRATION_TOOLS.includes(toolId)) throw assistantError("integration_not_found", "The Magic Box integration was not found.", 404);
    return store.db.prepare("SELECT * FROM integrations WHERE tool_id=?").get(toolId);
  }

  function list() {
    return { integrations: ASSISTANT_INTEGRATION_TOOLS.map((toolId) => serializeIntegration(getIntegration(toolId))) };
  }

  async function update(toolId, input) {
    const current = getIntegration(toolId);
    if (input?.confirmation !== true) throw assistantError("integration_grant_mismatch", "Confirm the integration permission change.", 409);
    if (!input.enabled) {
      const generation = Number(current.generation) + 1;
      store.db.prepare("UPDATE integrations SET enabled=0,output_root=NULL,generation=?,pending_count=0,updated_at=? WHERE tool_id=?").run(generation, isoNow(), toolId);
      await core.activity.append({ kind: "integration", action: "integration.grant-disabled", status: "completed", summary: `${toolId} output handoff disabled` });
      return serializeIntegration(getIntegration(toolId));
    }
    const canonical = await assertDirectoryNoLinks(input.outputRootPath);
    const generation = Number(current.generation) + 1;
    store.db.prepare("UPDATE integrations SET enabled=1,output_root=?,generation=?,updated_at=? WHERE tool_id=?").run(canonical, generation, isoNow(), toolId);
    await core.activity.append({ kind: "integration", action: current.enabled ? "integration.grant-changed" : "integration.grant-enabled", status: "completed", summary: `${toolId} completed outputs will be sent to Assistant` });
    return serializeIntegration(getIntegration(toolId));
  }

  function capture(toolId, { outputRootPath, producerJobId } = {}) {
    const row = getIntegration(toolId);
    if (!row.enabled || !row.output_root) return null;
    if (outputRootPath && !isPathInside(row.output_root, outputRootPath)) return null;
    const ticket = Object.freeze({
      toolId,
      generation: Number(row.generation),
      outputRootPath: row.output_root,
      producerJobId: String(producerJobId || createId("producer")),
      capturedAt: isoNow()
    });
    return {
      ticket,
      complete({ producerEventId, files }) {
        const eventId = String(producerEventId || `${ticket.toolId}:${ticket.producerJobId}`);
        const candidates = normalizeCandidateFiles(files);
        const payloadHash = sha256(JSON.stringify(candidates));
        const deliveryKey = `${ticket.toolId}:${eventId}`;
        const inflightHash = completionPayloadHashes.get(deliveryKey);
        if (inflightHash && inflightHash !== payloadHash) throw assistantError("integration_delivery_conflict", "This producer event was already completed with a different file list.", 409);
        const existing = store.db.prepare("SELECT * FROM integration_deliveries WHERE tool_id=? AND producer_event_id=?").get(ticket.toolId, eventId);
        if (existing && existing.payload_hash && existing.payload_hash !== payloadHash) throw assistantError("integration_delivery_conflict", "This producer event was already completed with a different file list.", 409);
        if (existing) {
          queueMicrotask(() => deliver(ticket, { producerEventId: eventId, files: jsonParse(existing.files_json, []) }).catch(() => {}));
          return Promise.resolve({ deliveryId: existing.id });
        }
        if (capturePromises.has(deliveryKey)) return capturePromises.get(deliveryKey);
        completionPayloadHashes.set(deliveryKey, payloadHash);
        const completion = captureAndQueueDelivery(ticket, eventId, candidates, payloadHash)
          .finally(() => {
            capturePromises.delete(deliveryKey);
            completionPayloadHashes.delete(deliveryKey);
          });
        capturePromises.set(deliveryKey, completion);
        completion.catch(() => {});
        return completion;
      }
    };
  }

  function normalizeCandidateFiles(files) {
    return [...new Set((files || []).map((file) => typeof file === "string" ? file : file?.path).filter(Boolean).map((filePath) => path.resolve(filePath)))].slice(0, 100);
  }

  function normalizeCandidateRecords(files) {
    const records = new Map();
    for (const file of files || []) {
      const filePath = path.resolve(typeof file === "string" ? file : file?.path || "");
      if (!filePath || records.has(normalizePathKey(filePath))) continue;
      records.set(normalizePathKey(filePath), typeof file === "string"
        ? { path: filePath, fingerprint: null, identity: null, captureError: "integration_identity_missing" }
        : { path: filePath, fingerprint: file.fingerprint || null, identity: file.identity || null, captureError: file.captureError || null });
      if (records.size >= 100) break;
    }
    return [...records.values()];
  }

  function fileIdentity(stats) {
    return { dev: Number(stats.dev), ino: Number(stats.ino), size: Number(stats.size), mtimeMs: Number(stats.mtimeMs) };
  }

  function identityMatches(first, second) {
    return Boolean(first && second)
      && Number(first.dev) === Number(second.dev)
      && Number(first.ino) === Number(second.ino)
      && Number(first.size) === Number(second.size)
      && Number(first.mtimeMs) === Number(second.mtimeMs);
  }

  async function validateCapturedRecord(ticket, record) {
    if (!record.fingerprint || !record.identity || record.captureError) throw assistantError(record.captureError || "integration_identity_missing", "The producer did not supply a verified completion-time file identity.", 409);
    const { canonical, stats } = await assertRegularFileNoLinks(record.path);
    if (!isPathInside(ticket.outputRootPath, canonical)) throw assistantError("integration_path_not_allowed", "An output was outside the approved integration folder.", 403);
    if (normalizePathKey(canonical) !== normalizePathKey(record.path) || !identityMatches(fileIdentity(stats), record.identity) || await core.hashFile(canonical) !== record.fingerprint) {
      throw assistantError("integration_output_changed", "An output changed after producer completion and was not admitted.", 409);
    }
    return { canonical, stats };
  }

  function rollbackProvisionalAdmission(itemId, before) {
    store.transaction(() => {
      if (before) {
        if (before.item.id !== itemId) {
          const provisionalChunkIds = store.db.prepare("SELECT id FROM chunks WHERE item_id=?").all(itemId);
          for (const chunk of provisionalChunkIds) store.db.prepare("DELETE FROM chunks_fts WHERE chunk_id=?").run(chunk.id);
          store.db.prepare("DELETE FROM chunks WHERE item_id=?").run(itemId);
          store.db.prepare("DELETE FROM items WHERE id=?").run(itemId);
          return;
        }
        const currentChunkIds = store.db.prepare("SELECT id FROM chunks WHERE item_id=?").all(itemId);
        for (const chunk of currentChunkIds) store.db.prepare("DELETE FROM chunks_fts WHERE chunk_id=?").run(chunk.id);
        store.db.prepare("DELETE FROM chunks WHERE item_id=?").run(itemId);
        for (const chunk of before.chunks) {
          store.db.prepare("INSERT INTO chunks(id,item_id,item_revision,ordinal,text,page,section,vector_json,embedding_model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
            .run(chunk.id, chunk.item_id, chunk.item_revision, chunk.ordinal, chunk.text, chunk.page, chunk.section, chunk.vector_json, chunk.embedding_model, chunk.created_at);
          store.db.prepare("INSERT INTO chunks_fts(chunk_id,item_id,text) VALUES(?,?,?)").run(chunk.id, chunk.item_id, chunk.text);
        }
        store.db.prepare("UPDATE items SET display_name=?,canonical_path=?,path_key=?,managed_path=?,source=?,state=?,content_type=?,size_bytes=?,fingerprint=?,revision=?,metadata_revision=?,tags_json=?,summary=?,origins_json=?,details_ref=?,extracted_text=?,created_at=?,updated_at=?,last_error=? WHERE id=?")
          .run(
            before.item.display_name,
            before.item.canonical_path,
            before.item.path_key,
            before.item.managed_path,
            before.item.source,
            before.item.state,
            before.item.content_type,
            before.item.size_bytes,
            before.item.fingerprint,
            before.item.revision,
            before.item.metadata_revision,
            before.item.tags_json,
            before.item.summary,
            before.item.origins_json,
            before.item.details_ref,
            before.item.extracted_text,
            before.item.created_at,
            before.item.updated_at,
            before.item.last_error,
            itemId
          );
        return;
      }
      const chunkIds = store.db.prepare("SELECT id FROM chunks WHERE item_id=?").all(itemId);
      for (const chunk of chunkIds) store.db.prepare("DELETE FROM chunks_fts WHERE chunk_id=?").run(chunk.id);
      store.db.prepare("DELETE FROM chunks WHERE item_id=?").run(itemId);
      store.db.prepare("DELETE FROM items WHERE id=?").run(itemId);
    });
  }

  async function captureCandidateRecords(ticket, candidates) {
    const records = [];
    for (const candidate of candidates) {
      try {
        const before = await assertRegularFileNoLinks(candidate);
        if (!isPathInside(ticket.outputRootPath, before.canonical)) throw assistantError("integration_path_not_allowed", "An output was outside the approved integration folder.", 403);
        const fingerprint = await core.hashFile(before.canonical);
        const after = await assertRegularFileNoLinks(before.canonical);
        const beforeIdentity = fileIdentity(before.stats);
        const afterIdentity = fileIdentity(after.stats);
        if (!identityMatches(beforeIdentity, afterIdentity)) throw assistantError("integration_output_changed", "An output changed while completion identity was captured.", 409);
        records.push({ path: after.canonical, fingerprint, identity: afterIdentity });
      } catch (error) {
        records.push({ path: candidate, fingerprint: null, identity: null, captureError: error.code || "integration_identity_capture_failed" });
      }
    }
    return records;
  }

  async function captureAndQueueDelivery(ticket, eventId, candidates, payloadHash) {
    const captured = await captureCandidateRecords(ticket, candidates);
    const createdAt = isoNow();
    const deliveryId = createId("delivery");
    store.transaction(() => {
      const existing = store.db.prepare("SELECT * FROM integration_deliveries WHERE tool_id=? AND producer_event_id=?").get(ticket.toolId, eventId);
      if (existing) {
        if (existing.payload_hash && existing.payload_hash !== payloadHash) throw assistantError("integration_delivery_conflict", "This producer event was already completed with a different file list.", 409);
        return;
      }
      store.db.prepare("INSERT INTO integration_deliveries(id,tool_id,producer_event_id,generation,files_json,payload_hash,status,result_json,attempt,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',NULL,1,?,?)")
        .run(deliveryId, ticket.toolId, eventId, ticket.generation, JSON.stringify(captured), payloadHash, createdAt, createdAt);
      store.db.prepare("UPDATE integrations SET pending_count=pending_count+1,updated_at=? WHERE tool_id=?").run(createdAt, ticket.toolId);
    });
    const row = store.db.prepare("SELECT * FROM integration_deliveries WHERE tool_id=? AND producer_event_id=?").get(ticket.toolId, eventId);
    setImmediate(() => deliver(ticket, { producerEventId: eventId, files: jsonParse(row.files_json, []) }).catch(() => {}));
    return { deliveryId: row.id };
  }

  function grantStillMatches(ticket) {
    const current = getIntegration(ticket.toolId);
    return Boolean(current.enabled)
      && Number(current.generation) === Number(ticket.generation)
      && normalizePathKey(current.output_root) === normalizePathKey(ticket.outputRootPath);
  }

  async function finalizeDelivery(row) {
    const result = jsonParse(row.result_json, {});
    const activityGeneration = row.activity_generation === null || row.activity_generation === undefined ? core.activity.currentGeneration() : Number(row.activity_generation);
    if (row.activity_generation === null || row.activity_generation === undefined) store.db.prepare("UPDATE integration_deliveries SET activity_generation=? WHERE id=?").run(activityGeneration, row.id);
    if (!row.event_published) {
      core.events.publish({ id: stableUuid(`magic-box:tool-completed:${row.tool_id}:${row.producer_event_id}`), type: "tool-completed", causationId: stableUuid(`magic-box:producer:${row.tool_id}:${row.producer_event_id}`), lineage: [], payload: { toolId: row.tool_id, producerEventId: row.producer_event_id, itemIds: result.admittedItemIds || [] } });
      store.db.prepare("UPDATE integration_deliveries SET event_published=1,updated_at=? WHERE id=?").run(isoNow(), row.id);
    }
    if (!row.activity_published) {
      const status = result.status || "failed";
      await core.activity.append({ eventKey: `integration:${row.id}:${status}`, activityGeneration, kind: "integration", action: status === "completed" || status === "partial" ? "integration.delivery-completed" : "integration.delivery-failed", status, summary: `${row.tool_id}: ${(result.admittedItemIds || []).length} output(s) sent to Assistant`, counts: { requested: jsonParse(row.files_json, []).length, completed: (result.admittedItemIds || []).length, failed: (result.rejected || []).length, skipped: 0 }, related: { itemIds: result.admittedItemIds || [] } });
      store.db.prepare("UPDATE integration_deliveries SET activity_published=1,updated_at=? WHERE id=?").run(isoNow(), row.id);
    }
    store.transaction(() => {
      const current = store.db.prepare("SELECT status FROM integration_deliveries WHERE id=?").get(row.id);
      if (current?.status === "admitted") {
        store.db.prepare("UPDATE integration_deliveries SET status=?,updated_at=? WHERE id=?").run(result.status || "failed", isoNow(), row.id);
        store.db.prepare("UPDATE integrations SET pending_count=MAX(0,pending_count-1),failed_count=failed_count+?,updated_at=? WHERE tool_id=?").run(result.status === "failed" ? 1 : 0, isoNow(), row.tool_id);
      }
    });
    return result;
  }

  async function deliverOnce(ticket, { producerEventId, files }) {
    const eventId = String(producerEventId || `${ticket.toolId}:${ticket.producerJobId}`);
    const existing = store.db.prepare("SELECT * FROM integration_deliveries WHERE tool_id=? AND producer_event_id=?").get(ticket.toolId, eventId);
    const records = normalizeCandidateRecords(files);
    const candidates = records.map((record) => record.path);
    const payloadHash = sha256(JSON.stringify(candidates));
    if (existing?.payload_hash && existing.payload_hash !== payloadHash) throw assistantError("integration_delivery_conflict", "This producer event was already completed with a different file list.", 409);
    if (existing?.status === "admitted" || (existing && existing.event_published && !existing.activity_published)) return finalizeDelivery(existing);
    if (existing && ["completed", "partial", "failed"].includes(existing.status) && existing.event_published && existing.activity_published) return jsonParse(existing.result_json, {});
    const current = getIntegration(ticket.toolId);
    if (!current.enabled || Number(current.generation) !== ticket.generation || normalizePathKey(current.output_root) !== normalizePathKey(ticket.outputRootPath)) {
      if (existing?.status === "pending") {
        store.transaction(() => {
          store.db.prepare("UPDATE integration_deliveries SET status='failed',result_json=?,updated_at=? WHERE id=?")
            .run(JSON.stringify({ code: "integration_grant_disabled" }), isoNow(), existing.id);
          store.db.prepare("UPDATE integrations SET pending_count=MAX(0,pending_count-1),failed_count=failed_count+1,updated_at=? WHERE tool_id=?").run(isoNow(), ticket.toolId);
        });
      }
      throw assistantError("integration_grant_disabled", "The integration permission changed before delivery.", 409);
    }
    const deliveryId = existing?.id || createId("delivery");
    const createdAt = existing?.created_at || isoNow();
    if (!existing) {
      store.db.prepare("INSERT INTO integration_deliveries(id,tool_id,producer_event_id,generation,files_json,payload_hash,status,result_json,attempt,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',NULL,1,?,?)")
        .run(deliveryId, ticket.toolId, eventId, ticket.generation, JSON.stringify(records), payloadHash, createdAt, isoNow());
      store.db.prepare("UPDATE integrations SET pending_count=pending_count+1,updated_at=? WHERE tool_id=?").run(isoNow(), ticket.toolId);
    }
    const itemIds = [];
    const rejected = [];
    try {
      for (const record of records) {
        const candidate = record.path;
        try {
          const { canonical, stats } = await validateCapturedRecord(ticket, record);
          let itemId;
          await core.withPathLock(normalizePathKey(canonical), async () => {
            const current = await validateCapturedRecord(ticket, record);
            const existingBeforeAdmission = store.db.prepare("SELECT * FROM items WHERE path_key=? ORDER BY created_at LIMIT 1").get(normalizePathKey(current.canonical));
            const before = existingBeforeAdmission ? {
              item: existingBeforeAdmission,
              chunks: store.db.prepare("SELECT * FROM chunks WHERE item_id=? ORDER BY item_revision,ordinal,id").all(existingBeforeAdmission.id)
            } : null;
            const admission = core.upsertReferencedItem({ canonical: current.canonical, stats: current.stats, root: { id: `integration:${ticket.toolId}`, generation: ticket.generation }, source: ticket.toolId, returnDetails: true });
            itemId = admission.itemId;
            try {
              await core.indexItem(itemId, { itemLockHeld: true, commitGuard: () => grantStillMatches(ticket), validateBeforeCommit: () => validateCapturedRecord(ticket, record) });
            } catch (error) {
              rollbackProvisionalAdmission(itemId, before);
              throw error;
            }
          });
          itemIds.push(itemId);
        } catch (error) {
          rejected.push({ file: path.basename(candidate), code: error.code || "integration_delivery_failed" });
        }
      }
      const status = itemIds.length && rejected.length ? "partial" : itemIds.length ? "completed" : "failed";
      const result = { deliveryId, producerEventId: eventId, admittedItemIds: itemIds, rejected, status };
      store.db.prepare("UPDATE integration_deliveries SET status='admitted',result_json=?,activity_generation=?,updated_at=? WHERE id=?").run(JSON.stringify(result), core.activity.currentGeneration(), isoNow(), deliveryId);
      return finalizeDelivery(store.db.prepare("SELECT * FROM integration_deliveries WHERE id=?").get(deliveryId));
    } catch (error) {
      const state = store.db.prepare("SELECT status FROM integration_deliveries WHERE id=?").get(deliveryId)?.status;
      if (state === "pending") {
        store.db.prepare("UPDATE integration_deliveries SET status='failed',result_json=?,updated_at=? WHERE id=?").run(JSON.stringify({ code: error.code || "integration_delivery_failed" }), isoNow(), deliveryId);
        store.db.prepare("UPDATE integrations SET pending_count=MAX(0,pending_count-1),failed_count=failed_count+1,updated_at=? WHERE tool_id=?").run(isoNow(), ticket.toolId);
      }
      throw error;
    }
  }

  function deliver(ticket, input) {
    const key = `${ticket.toolId}:${String(input.producerEventId || ticket.producerJobId)}`;
    if (deliveryPromises.has(key)) return deliveryPromises.get(key);
    const promise = deliverOnce(ticket, input).finally(() => deliveryPromises.delete(key));
    deliveryPromises.set(key, promise);
    return promise;
  }

  async function retry(toolId, producerEventId) {
    const row = store.db.prepare("SELECT * FROM integration_deliveries WHERE tool_id=? AND producer_event_id=?").get(toolId, producerEventId);
    if (!row) throw assistantError("integration_delivery_not_found", "The delivery was not found.", 404);
    const integration = getIntegration(toolId);
    if (!integration.enabled) throw assistantError("integration_grant_disabled", "Enable this integration before retrying delivery.", 409);
    if (Number(integration.generation) !== Number(row.generation)) throw assistantError("integration_grant_disabled", "The integration permission changed after this delivery was captured.", 409);
    if (row.status === "failed") {
      store.transaction(() => {
        store.db.prepare("UPDATE integration_deliveries SET status='pending',attempt=attempt+1,updated_at=? WHERE id=?").run(isoNow(), row.id);
        store.db.prepare("UPDATE integrations SET pending_count=pending_count+1,failed_count=MAX(0,failed_count-1),updated_at=? WHERE tool_id=?").run(isoNow(), toolId);
      });
    }
    return deliver({ toolId, generation: Number(integration.generation), outputRootPath: integration.output_root, producerJobId: producerEventId }, { producerEventId, files: jsonParse(row.files_json, []) });
  }

  function replayPendingDeliveries() {
    const rows = store.db.prepare("SELECT * FROM integration_deliveries WHERE status IN ('pending','admitted') OR event_published=0 OR activity_published=0 ORDER BY created_at,id").all();
    for (const row of rows) {
      const integration = getIntegration(row.tool_id);
      if (row.status === "admitted" || row.event_published || row.activity_published) {
        queueMicrotask(() => finalizeDelivery(row).catch(() => {}));
        continue;
      }
      if (!integration.enabled || !integration.output_root || Number(integration.generation) !== Number(row.generation)) {
        store.transaction(() => {
          store.db.prepare("UPDATE integration_deliveries SET status='failed',result_json=?,updated_at=? WHERE id=?")
            .run(JSON.stringify({ code: "integration_grant_disabled" }), isoNow(), row.id);
          store.db.prepare("UPDATE integrations SET pending_count=MAX(0,pending_count-1),failed_count=failed_count+1,updated_at=? WHERE tool_id=?").run(isoNow(), row.tool_id);
        });
        continue;
      }
      queueMicrotask(() => deliver(
        { toolId: row.tool_id, generation: Number(row.generation), outputRootPath: integration.output_root, producerJobId: row.producer_event_id },
        { producerEventId: row.producer_event_id, files: jsonParse(row.files_json, []) }
      ).catch(() => {}));
    }
  }

  async function waitForIdle() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      const pending = [...capturePromises.values(), ...deliveryPromises.values()];
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
    throw assistantError("integration_delivery_busy", "Integration deliveries did not become idle.", 409, true);
  }

  core.registerCloseHook(async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pending = [...capturePromises.values(), ...deliveryPromises.values()];
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  });

  function route(handler) {
    return async (request, response) => {
      try { response.json(await handler(request, response)); }
      catch (error) { sendAssistantError(response, error); }
    };
  }

  router.get("/integrations", route(() => list()));
  router.put("/integrations/:toolId", route((request) => update(request.params.toolId, request.body || {})));
  router.post("/integrations/:toolId/deliveries/:producerEventId/retry", route((request) => retry(request.params.toolId, request.params.producerEventId)));

  replayPendingDeliveries();

  return { list, update, capture, deliver, retry, waitForIdle };
}
