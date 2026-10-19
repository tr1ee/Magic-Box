import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { assistantError, boundedText, contentTypeForName, createId, isoNow, jsonParse, sendAssistantError } from "./utils.mjs";

const semanticCorpusLimit = 10_000;
const semanticTopK = 100;
const semanticDeadlineMs = 750;
const MAX_EXTRACT_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_TEXT = 10 * 1024 * 1024;

function normalizePlainText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/[\t\f\v]+/g, " ").replace(/ {3,}/g, "  ").replace(/\n{4,}/g, "\n\n\n").trim();
}

async function extractPlainText(filePath, signal) {
  if (signal?.aborted) throw assistantError("job_cancelled", "Indexing was cancelled.", 409);
  const stats = await fs.stat(filePath);
  if (!stats.isFile() || stats.size > MAX_EXTRACT_BYTES) throw assistantError("extraction_limit_exceeded", "Documents larger than 50 MiB are not indexed.", 413);
  const text = normalizePlainText(await fs.readFile(filePath, "utf8"));
  if (Buffer.byteLength(text, "utf8") > MAX_EXTRACTED_TEXT) throw assistantError("extraction_limit_exceeded", "Extracted text exceeded the 10 MiB safety limit.", 413);
  if (signal?.aborted) throw assistantError("job_cancelled", "Indexing was cancelled.", 409);
  return [{ page: null, text }];
}

async function extractDocument(filePath, signal) {
  const extension = path.extname(filePath).toLowerCase();
  if ([".txt", ".md", ".markdown"].includes(extension)) return extractPlainText(filePath, signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./extract-worker.mjs", import.meta.url), {
      workerData: { filePath },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 }
    });
    let settled = false;
    const finish = async (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      await worker.terminate().catch(() => {});
      callback(value);
    };
    const onAbort = () => { void finish(reject, assistantError("job_cancelled", "Indexing was cancelled.", 409)); };
    const timer = setTimeout(() => { void finish(reject, assistantError("extraction_timeout", "Document extraction exceeded 120 seconds.", 503, true)); }, 120_000);
    worker.once("message", (message) => message?.ok
      ? void finish(resolve, message.sections)
      : void finish(reject, assistantError(message?.code || "document_extraction_failed", message?.message || "Document extraction failed.", 400)));
    worker.once("error", (error) => { void finish(reject, assistantError("document_extraction_failed", error.message, 503, true)); });
    worker.once("exit", (code) => { if (code && !settled) void finish(reject, assistantError("document_extraction_failed", "Document extraction worker stopped unexpectedly.", 503, true)); });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function chunkSections(sections, maxChars = 1200, overlap = 160) {
  const chunks = [];
  for (const section of sections) {
    const text = section.text;
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(text.length, offset + maxChars);
      if (end < text.length) {
        const candidates = [text.lastIndexOf("\n", end), text.lastIndexOf(". ", end), text.lastIndexOf("。", end), text.lastIndexOf(" ", end)];
        const boundary = Math.max(...candidates);
        if (boundary > offset + Math.floor(maxChars * 0.6)) end = boundary + 1;
      }
      const value = text.slice(offset, end).trim();
      if (value) chunks.push({ page: section.page, text: value });
      if (end >= text.length) break;
      offset = Math.max(offset + 1, end - overlap);
    }
  }
  return chunks.slice(0, 10_000);
}

function ftsQuery(text) {
  const terms = String(text || "").toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
  return terms.slice(0, 20).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aa += a[index] * a[index];
    bb += b[index] * b[index];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}

function compareText(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareStableRows(left, right, valueKey) {
  const value = Number(right[valueKey] || 0) - Number(left[valueKey] || 0);
  if (value) return value;
  return compareText(left.item_id, right.item_id)
    || Number(left.item_revision || 0) - Number(right.item_revision || 0)
    || Number(left.ordinal || 0) - Number(right.ordinal || 0)
    || compareText(left.id, right.id);
}

function insertBounded(rows, row, limit) {
  let index = 0;
  while (index < rows.length && compareStableRows(rows[index], row, "semantic") <= 0) index += 1;
  if (index >= limit && rows.length >= limit) return;
  rows.splice(index, 0, row);
  if (rows.length > limit) rows.pop();
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const timedOut = signal.reason === "search_timeout";
  throw assistantError(timedOut ? "search_timeout" : "search_cancelled", timedOut ? "Search exceeded its request time budget." : "Search was cancelled.", timedOut ? 503 : 409, timedOut);
}

export function createWorkspaceIndex({ manager, modelRuntime }) {
  const { store, core, router } = manager;

  async function index({ item, filePath, signal, report, canCommit, validateBeforeCommit }) {
    if (![".txt", ".md", ".markdown", ".pdf", ".docx"].includes(path.extname(filePath).toLowerCase())) {
      return {
        state: "unsupported",
        extractedText: null,
        detailsRef: `index:${item.id}:${item.revision}`,
        summary: null,
        fingerprint: item.fingerprint,
        indexedChunks: 0,
        embeddingModel: null
      };
    }
    const sections = await extractDocument(filePath, signal);
    const chunks = chunkSections(sections);
    if (!chunks.length) return { state: "indexed", extractedText: "", detailsRef: `index:${item.id}:${item.revision}`, summary: null, fingerprint: item.fingerprint, indexedChunks: 0, embeddingModel: null };
    let embeddingModel = null;
    let vectors = null;
    if (modelRuntime.status().embeddings === "ready") {
      try {
        vectors = [];
        for (let offset = 0; offset < chunks.length; offset += 32) {
          if (signal?.aborted) throw assistantError("job_cancelled", "Indexing was cancelled.", 409);
          const result = await modelRuntime.embed({ purpose: "document", texts: chunks.slice(offset, offset + 32).map((chunk) => chunk.text), signal });
          embeddingModel = result.model;
          vectors.push(...result.vectors);
          report?.({ stage: "embedding", message: `Embedded ${Math.min(chunks.length, offset + 32)} of ${chunks.length} chunk(s)` });
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        embeddingModel = null;
        vectors = null;
      }
    }
    const createdAt = isoNow();
    await validateBeforeCommit?.();
    store.transaction(() => {
      if (canCommit && !canCommit()) throw assistantError("stale_workspace_generation", "The Assistant workspace changed before indexing could commit.", 409, true);
      const oldIds = store.db.prepare("SELECT id FROM chunks WHERE item_id=?").all(item.id);
      for (const old of oldIds) store.db.prepare("DELETE FROM chunks_fts WHERE chunk_id=?").run(old.id);
      store.db.prepare("DELETE FROM chunks WHERE item_id=?").run(item.id);
      chunks.forEach((chunk, ordinal) => {
        const id = createId("chunk");
        store.db.prepare("INSERT INTO chunks(id,item_id,item_revision,ordinal,text,page,section,vector_json,embedding_model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(id, item.id, item.revision, ordinal, chunk.text, chunk.page, null, vectors ? JSON.stringify(vectors[ordinal]) : null, embeddingModel, createdAt);
        store.db.prepare("INSERT INTO chunks_fts(chunk_id,item_id,text) VALUES(?,?,?)").run(id, item.id, chunk.text);
      });
    });
    const combined = sections.map((section) => section.text).join("\n\n");
    const summary = boundedText(combined.replace(/\s+/g, " "), 320);
    return {
      state: "indexed",
      extractedText: combined,
      detailsRef: `index:${item.id}:${item.revision}`,
      summary,
      fingerprint: item.fingerprint,
      indexedChunks: chunks.length,
      embeddingModel
    };
  }

  async function search({ query, scope, limit = 12, signal }) {
    const normalized = boundedText(query, 4096);
    if (!normalized) throw assistantError("invalid_search_query", "Enter a search question.", 400);
    const hasItemScope = scope && Object.prototype.hasOwnProperty.call(scope, "itemIds");
    const hasRootScope = scope && Object.prototype.hasOwnProperty.call(scope, "workspaceRootIds");
    if ((hasItemScope && (!Array.isArray(scope.itemIds) || !scope.itemIds.length || scope.itemIds.length > 100)) || (hasRootScope && (!Array.isArray(scope.workspaceRootIds) || !scope.workspaceRootIds.length || scope.workspaceRootIds.length > 50))) {
      throw assistantError("invalid_search_scope", "Search scope must contain 1-100 items or 1-50 approved workspace roots.", 400);
    }
    const scopeItemIds = hasItemScope ? [...new Set(scope.itemIds)] : null;
    const scopeRootIds = hasRootScope ? [...new Set(scope.workspaceRootIds)] : null;
    let allowedItemIds = null;
    if (scopeItemIds || scopeRootIds) {
      const allowed = new Set(scopeItemIds || []);
      if (scopeRootIds?.length) {
        for (const rootId of scopeRootIds) {
          if (!store.db.prepare("SELECT id FROM workspace_roots WHERE id=?").get(rootId)) throw assistantError("workspace_root_not_found", "The workspace folder was not found or is no longer approved.", 404);
        }
        for (const row of store.db.prepare("SELECT id,origins_json FROM items").all()) {
          if (jsonParse(row.origins_json, []).some((origin) => origin.kind === "workspace" && scopeRootIds.includes(origin.rootId))) allowed.add(row.id);
        }
      }
      allowedItemIds = allowed;
    }
    const queryExpression = ftsQuery(normalized);
    const scopedIds = allowedItemIds ? [...allowedItemIds] : null;
    const scopeSql = scopedIds ? ` AND c.item_id IN (${scopedIds.map(() => "?").join(",") || "NULL"})` : "";
    let candidates = [];
    if (queryExpression) {
      candidates = store.db.prepare(`SELECT c.*,bm25(chunks_fts) AS rank,i.display_name,i.state FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.chunk_id JOIN items i ON i.id=c.item_id WHERE chunks_fts MATCH ? AND i.state='indexed'${scopeSql} ORDER BY rank LIMIT 100`).all(queryExpression, ...(scopedIds || []));
    }
    if (candidates.length < 50) {
      const fallback = store.db.prepare(`SELECT c.*,0 AS rank,i.display_name,i.state FROM chunks c JOIN items i ON i.id=c.item_id WHERE LOWER(c.text) LIKE ? AND i.state='indexed'${scopeSql} ORDER BY i.updated_at DESC,c.ordinal LIMIT 100`).all(`%${normalized.toLowerCase().slice(0, 120)}%`, ...(scopedIds || []));
      const seen = new Set(candidates.map((row) => row.id));
      candidates.push(...fallback.filter((row) => !seen.has(row.id)));
    }
    candidates = candidates.filter((row) => row.state === "indexed");
    let retrieval = "keyword";
    const warnings = [];
    if (modelRuntime.status().embeddings === "ready") {
      const embeddingModel = modelRuntime.status().activeModels?.embeddings;
      const compatibleVectorCount = embeddingModel
        ? store.compatibleVectorProbe({ embeddingModel, itemIds: scopedIds, limit: semanticCorpusLimit + 1 })
        : 0;
      if (compatibleVectorCount > semanticCorpusLimit) {
        warnings.push("semantic_corpus_limit");
      } else if (compatibleVectorCount > 0) {
        try {
          throwIfAborted(signal);
          const semanticDeadline = Date.now() + semanticDeadlineMs;
          const embedded = await modelRuntime.embed({ purpose: "query", texts: [normalized], signal });
          throwIfAborted(signal);
          const semanticRows = [];
          let timedOut = Date.now() > semanticDeadline;
          if (!timedOut) {
            const queryVector = embedded.vectors[0];
            for (const row of store.iterateCompatibleVectors({ embeddingModel: embedded.model, itemIds: scopedIds })) {
              throwIfAborted(signal);
              if (Date.now() > semanticDeadline) {
                timedOut = true;
                break;
              }
              const semantic = cosineSimilarity(queryVector, jsonParse(row.vector_json, []));
              if (Number.isFinite(semantic)) insertBounded(semanticRows, { ...row, semantic }, semanticTopK);
            }
          }
          if (timedOut) {
            warnings.push("semantic_timeout");
          } else {
            const merged = new Map();
            candidates.forEach((row, ordinal) => merged.set(row.id, { ...row, score: Math.max(0, 1 - ordinal / Math.max(1, candidates.length)) * 0.45 }));
            semanticRows.forEach((row) => {
              const existing = merged.get(row.id);
              merged.set(row.id, { ...(existing || row), score: (existing?.score || 0) + Math.max(0, row.semantic) * 0.55 });
            });
            candidates = [...merged.values()].sort((a, b) => compareStableRows(a, b, "score"));
            retrieval = "hybrid";
          }
        } catch (error) {
          if (signal?.aborted || error?.code === "search_cancelled" || error?.code === "search_timeout") throw error;
          warnings.push("semantic_unavailable");
        }
      }
    } else {
      warnings.push("embeddings_not_active");
    }
    const results = candidates.slice(0, Math.max(1, Math.min(50, limit))).map((row, ordinal) => ({
      itemId: row.item_id,
      itemRevision: Number(row.item_revision),
      chunkId: row.id,
      displayName: row.display_name,
      excerpt: row.text,
      page: row.page === null ? null : Number(row.page),
      section: row.section,
      score: Number(row.score ?? Math.max(0, 1 - ordinal / Math.max(1, candidates.length)))
    }));
    return { query: normalized, retrieval, warnings, results };
  }

  function getChunk({ itemId, revision, chunkId }) {
    const row = store.db.prepare("SELECT c.*,i.display_name,i.revision AS current_revision,i.state FROM chunks c JOIN items i ON i.id=c.item_id WHERE c.id=? AND c.item_id=? AND c.item_revision=?").get(chunkId, itemId, revision);
    if (!row) throw assistantError("source_not_found", "The source excerpt was not found.", 404);
    return {
      itemId,
      itemRevision: Number(revision),
      chunkId,
      displayName: row.display_name,
      excerpt: row.text,
      page: row.page === null ? null : Number(row.page),
      section: row.section,
      liveStatus: Number(row.current_revision) === Number(revision) && row.state === "indexed" ? "current" : "stale"
    };
  }

  function route(handler) {
    return async (request, response) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("search_timeout"), 3_000);
      request.once("aborted", () => controller.abort("client_aborted"));
      try { response.json(await handler(request, response, controller.signal)); }
      catch (error) { sendAssistantError(response, error); }
      finally { clearTimeout(timeout); }
    };
  }

  core.setIndexer({ index });
  core.setCapability("contentIndex", "ready");
  router.get("/index/status", route(() => ({ state: "ready", indexedItems: Number(store.db.prepare("SELECT COUNT(*) AS count FROM items WHERE state='indexed'").get().count), embeddings: modelRuntime.status().embeddings })));
  router.post("/search", route((request, _response, signal) => search({ ...request.body, signal })));
  router.get("/items/:itemId/revisions/:revision/chunks/:chunkId", route((request) => getChunk({ itemId: request.params.itemId, revision: Number(request.params.revision), chunkId: request.params.chunkId })));

  return { index, search, getChunk };
}
