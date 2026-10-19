import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { jsonParse } from "./utils.mjs";

const SCHEMA_VERSION = 3;

export class AssistantStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.dbPath = path.join(this.dataDir, "assistant.sqlite3");
    this.backupPath = `${this.dbPath}.backup`;
    this.recoveryState = "primary";
    this.db = this.openWithRecovery();
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.initializeSchema();
  }

  openChecked(filePath) {
    const db = new DatabaseSync(filePath);
    const result = db.prepare("PRAGMA quick_check").get();
    if (!result || Object.values(result)[0] !== "ok") { db.close(); throw new Error("Assistant database integrity check failed."); }
    return db;
  }

  openWithRecovery() {
    try { return this.openChecked(this.dbPath); }
    catch (primaryError) {
      const suffix = new Date().toISOString().replace(/[:.]/g, "-");
      for (const candidate of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
        if (fs.existsSync(candidate)) fs.renameSync(candidate, `${candidate}.quarantine-${suffix}`);
      }
      if (fs.existsSync(this.backupPath)) {
        try {
          fs.copyFileSync(this.backupPath, this.dbPath, fs.constants.COPYFILE_EXCL);
          this.recoveryState = "backup-restored";
          return this.openChecked(this.dbPath);
        } catch { try { fs.rmSync(this.dbPath, { force: true }); } catch {} }
      }
      this.recoveryState = "rebuilt-empty";
      return new DatabaseSync(this.dbPath);
    }
  }

  initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        path_key TEXT NOT NULL,
        managed_path TEXT,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        fingerprint TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        metadata_revision INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        origins_json TEXT NOT NULL DEFAULT '[]',
        details_ref TEXT,
        extracted_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_items_path_key ON items(path_key);
      CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        item_revision INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        page INTEGER,
        section TEXT,
        vector_json TEXT,
        embedding_model TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(item_id, item_revision, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_item ON chunks(item_id, item_revision, ordinal);
      CREATE INDEX IF NOT EXISTS idx_chunks_embedding_model_item ON chunks(embedding_model, item_id, item_revision, ordinal, id) WHERE vector_json IS NOT NULL;
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id UNINDEXED,
        item_id UNINDEXED,
        text,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS workspace_roots (
        id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL,
        path_key TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_scan_job_id TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        progress REAL,
        cancellable INTEGER NOT NULL DEFAULT 0,
        requested INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS activity (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL,
        event_key TEXT,
        payload_hash TEXT,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        counts_json TEXT,
        related_json TEXT,
        operations_json TEXT,
        undo_json TEXT,
        details_ref TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(generation, event_key)
      );
      CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at DESC, sequence DESC);
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        causation_id TEXT,
        lineage_json TEXT NOT NULL DEFAULT '[]',
        blocked_job_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_cursors (
        subscriber_id TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS models (
        model_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        manifest_revision TEXT NOT NULL,
        display_name TEXT NOT NULL,
        state TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        license_id TEXT,
        installed_path TEXT,
        source_url TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(model_id, capability)
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        grounding TEXT,
        retrieval TEXT,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        sources_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(conversation_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS assistant_memories (
        memory_key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        source_conversation_id TEXT,
        source_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_requests (
        request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        conversation_id TEXT,
        response_json TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_outbox (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        generation INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner, owner_key)
      );
      CREATE INDEX IF NOT EXISTS idx_activity_outbox_pending ON activity_outbox(state, created_at, id);
      CREATE TABLE IF NOT EXISTS recipes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'suggest',
        enabled INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        approved_revision INTEGER,
        trigger_json TEXT NOT NULL,
        conditions_json TEXT NOT NULL DEFAULT '[]',
        actions_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL,
        recipe_revision INTEGER,
        state TEXT NOT NULL,
        hash TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        approval_hash TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS undo_entries (
        activity_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS automation_operations (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        operation_index INTEGER NOT NULL,
        action TEXT NOT NULL,
        phase TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(plan_id, operation_index)
      );
      CREATE INDEX IF NOT EXISTS idx_automation_operations_phase ON automation_operations(phase, updated_at, id);
      CREATE TABLE IF NOT EXISTS integrations (
        tool_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        output_root TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        pending_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integration_deliveries (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL,
        producer_event_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        files_json TEXT NOT NULL,
        payload_hash TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        activity_generation INTEGER,
        event_published INTEGER NOT NULL DEFAULT 0,
        activity_published INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tool_id, producer_event_id)
      );
    `);
    for (const statement of [
      "ALTER TABLE recipes ADD COLUMN mode TEXT NOT NULL DEFAULT 'suggest'",
      "ALTER TABLE recipes ADD COLUMN approved_revision INTEGER",
      "ALTER TABLE integration_deliveries ADD COLUMN payload_hash TEXT",
      "ALTER TABLE integration_deliveries ADD COLUMN activity_generation INTEGER",
      "ALTER TABLE integration_deliveries ADD COLUMN event_published INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE integration_deliveries ADD COLUMN activity_published INTEGER NOT NULL DEFAULT 0"
    ]) {
      try { this.db.exec(statement); } catch (error) {
        if (!String(error.message).includes("duplicate column name")) throw error;
      }
    }
    this.setMetaDefault("schema_version", String(SCHEMA_VERSION));
    this.setMetaDefault("activity_generation", "1");
    this.setMetaDefault("workspace_generation", "1");
    this.setMetaDefault("retention", JSON.stringify({ conversationDays: 90, activityDays: 90, undoDays: 7 }));
    if (Number(this.getMeta("schema_version", "0")) < SCHEMA_VERSION) {
      this.transaction(() => {
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_embedding_model_item ON chunks(embedding_model, item_id, item_revision, ordinal, id) WHERE vector_json IS NOT NULL;");
        this.db.exec("CREATE TABLE IF NOT EXISTS assistant_memories (memory_key TEXT PRIMARY KEY,value TEXT NOT NULL,source_conversation_id TEXT,source_message_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);");
        this.setMeta("schema_version", String(SCHEMA_VERSION));
      });
    }
  }

  setMetaDefault(key, value) {
    this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)").run(key, value);
  }

  getMeta(key, fallback = null) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? fallback;
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
  }

  getRetention() {
    return jsonParse(this.getMeta("retention"), { conversationDays: 90, activityDays: 90, undoDays: 7 });
  }

  compatibleVectorProbe({ embeddingModel, itemIds = null, limit = 10_001 }) {
    if (Array.isArray(itemIds) && !itemIds.length) return 0;
    const scopeIds = Array.isArray(itemIds) ? itemIds : null;
    const scopeSql = scopeIds ? ` AND c.item_id IN (${scopeIds.map(() => "?").join(",")})` : "";
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM (SELECT c.id FROM chunks c JOIN items i ON i.id=c.item_id WHERE c.vector_json IS NOT NULL AND c.embedding_model=? AND i.state='indexed'${scopeSql} ORDER BY c.item_id,c.item_revision,c.ordinal,c.id LIMIT ?)`)
      .get(embeddingModel, ...(scopeIds || []), Math.max(1, Math.min(10_001, Number(limit) || 10_001)));
    return Number(row?.count || 0);
  }

  iterateCompatibleVectors({ embeddingModel, itemIds = null }) {
    if (Array.isArray(itemIds) && !itemIds.length) return [][Symbol.iterator]();
    const scopeIds = Array.isArray(itemIds) ? itemIds : null;
    const scopeSql = scopeIds ? ` AND c.item_id IN (${scopeIds.map(() => "?").join(",")})` : "";
    return this.db.prepare(`SELECT c.id,c.item_id,c.item_revision,c.ordinal,c.text,c.page,c.section,c.vector_json,i.display_name FROM chunks c JOIN items i ON i.id=c.item_id WHERE c.vector_json IS NOT NULL AND c.embedding_model=? AND i.state='indexed'${scopeSql} ORDER BY c.item_id,c.item_revision,c.ordinal,c.id LIMIT 10000`)
      .iterate(embeddingModel, ...(scopeIds || []));
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  checkpoint() {
    this.db.exec("PRAGMA wal_checkpoint(FULL)");
    const temporary = `${this.backupPath}.next`;
    fs.copyFileSync(this.dbPath, temporary);
    if (fs.existsSync(this.backupPath)) fs.rmSync(this.backupPath, { force: true });
    fs.renameSync(temporary, this.backupPath);
  }

  close() {
    this.checkpoint();
    this.db.close();
  }
}
