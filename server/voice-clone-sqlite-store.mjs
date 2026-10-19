import { copyFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const ARRAY_TABLES = Object.freeze({
  profiles: "profiles",
  samples: "samples",
  outputs: "outputs",
  artifacts: "artifacts",
  referencePacks: "reference_packs",
  attempts: "generation_attempts",
  qualityReports: "quality_reports",
  jobs: "jobs",
  jobEvents: "job_events"
});

export function voiceCloneSqliteEnabled(env = process.env) {
  const value = String(env.VOICE_CLONE_STORAGE || "").trim().toLowerCase();
  return value === "sqlite" || value === "sqlite-wal";
}

export function voiceCloneSqlitePath(jsonPath, env = process.env) {
  return env.VOICE_CLONE_SQLITE_PATH
    ? String(env.VOICE_CLONE_SQLITE_PATH)
    : String(jsonPath).replace(/\.json$/iu, ".sqlite3");
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function tableDefinitions() {
  return `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, status TEXT, engine TEXT, quality_mode TEXT, active_model_version_id TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS samples (id TEXT PRIMARY KEY, profile_id TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, profile_id TEXT, output_id TEXT, relative_path TEXT, sha256 TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reference_packs (id TEXT PRIMARY KEY, profile_id TEXT, model_version_id TEXT, purpose TEXT, sha256 TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS model_versions (id TEXT PRIMARY KEY, profile_id TEXT, engine TEXT, quality_mode TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS generation_attempts (id TEXT PRIMARY KEY, output_id TEXT, profile_id TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quality_reports (id TEXT PRIMARY KEY, output_id TEXT, profile_id TEXT, policy_version TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outputs (id TEXT PRIMARY KEY, profile_id TEXT, model_version_id TEXT, generation_path TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_events (id TEXT PRIMARY KEY, job_id TEXT, payload_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_samples_profile ON samples(profile_id);
    CREATE INDEX IF NOT EXISTS idx_outputs_profile ON outputs(profile_id);
    CREATE INDEX IF NOT EXISTS idx_quality_reports_output ON quality_reports(output_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_output ON generation_attempts(output_id);
    CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id);
  `;
}

function parseRows(database, table) {
  return database.prepare(`SELECT payload_json FROM ${table}`).all().flatMap((row) => {
    try {
      const value = JSON.parse(String(row.payload_json || "null"));
      return value && typeof value === "object" ? [value] : [];
    } catch {
      return [];
    }
  });
}

export function readVoiceCloneSqlite(sqlitePath) {
  if (!existsSync(sqlitePath)) return null;
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    database.exec(tableDefinitions());
    const metaRows = database.prepare("SELECT key, value FROM meta").all();
    const meta = Object.fromEntries(metaRows.map((row) => [String(row.key), String(row.value)]));
    return {
      schemaVersion: Math.max(2, Number(meta.schemaVersion) || 2),
      profiles: parseRows(database, ARRAY_TABLES.profiles),
      samples: parseRows(database, ARRAY_TABLES.samples),
      outputs: parseRows(database, ARRAY_TABLES.outputs),
      artifacts: parseRows(database, ARRAY_TABLES.artifacts),
      referencePacks: parseRows(database, ARRAY_TABLES.referencePacks),
      attempts: parseRows(database, ARRAY_TABLES.attempts),
      qualityReports: parseRows(database, ARRAY_TABLES.qualityReports),
      jobs: parseRows(database, ARRAY_TABLES.jobs),
      jobEvents: parseRows(database, ARRAY_TABLES.jobEvents)
    };
  } finally {
    database.close();
  }
}

function insertRows(database, table, rows, columns, values) {
  const placeholders = columns.map(() => "?").join(",");
  const statement = database.prepare(`INSERT OR REPLACE INTO ${table}(${columns.join(",")}) VALUES(${placeholders})`);
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    statement.run(...values(item));
  }
}

export function writeVoiceCloneSqlite(sqlitePath, source) {
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    database.exec(tableDefinitions());
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const table of Object.values(ARRAY_TABLES)) database.exec(`DELETE FROM ${table}`);
      database.exec("DELETE FROM model_versions");
      const meta = database.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)");
      meta.run("schemaVersion", String(Math.max(2, Number(source?.schemaVersion) || 2)));
      meta.run("updatedAt", new Date().toISOString());
      insertRows(database, ARRAY_TABLES.profiles, source.profiles, ["id", "status", "engine", "quality_mode", "active_model_version_id", "payload_json"], (item) => [
        String(item.id || ""), String(item.status || ""), String(item.engine || item.voiceModel?.engine || ""), String(item.qualityMode || ""), String(item.activeModelVersionId || item.voiceModel?.versionId || ""), json(item)
      ]);
      insertRows(database, "model_versions", (source.profiles || []).flatMap((profile) => (Array.isArray(profile?.modelVersions) ? profile.modelVersions : []).map((version) => ({ ...version, profileId: profile.id }))), ["id", "profile_id", "engine", "quality_mode", "payload_json"], (item) => [
        String(item.id || item.versionId || ""), String(item.profileId || ""), String(item.engine || item.voiceModel?.engine || ""), String(item.qualityMode || item.voiceModel?.qualityMode || ""), json(item)
      ]);
      insertRows(database, ARRAY_TABLES.samples, source.samples, ["id", "profile_id", "payload_json"], (item) => [String(item.id || ""), String(item.profileId || ""), json(item)]);
      insertRows(database, ARRAY_TABLES.outputs, source.outputs, ["id", "profile_id", "model_version_id", "generation_path", "payload_json"], (item) => [String(item.id || ""), String(item.profileId || ""), String(item.modelVersionId || item.settings?.modelVersionId || ""), String(item.settings?.generationPath || item.generationPath || ""), json(item)]);
      insertRows(database, ARRAY_TABLES.artifacts, source.artifacts, ["id", "profile_id", "output_id", "relative_path", "sha256", "payload_json"], (item) => [String(item.id || item.artifactId || ""), String(item.profileId || ""), String(item.outputId || ""), String(item.relativePath || ""), String(item.sha256 || ""), json(item)]);
      insertRows(database, ARRAY_TABLES.referencePacks, source.referencePacks, ["id", "profile_id", "model_version_id", "purpose", "sha256", "payload_json"], (item) => [String(item.referencePackId || item.id || ""), String(item.profileId || ""), String(item.modelVersionId || ""), String(item.purpose || ""), String(item.sha256 || ""), json(item)]);
      insertRows(database, ARRAY_TABLES.attempts, source.attempts, ["id", "output_id", "profile_id", "payload_json"], (item) => [String(item.id || item.attemptId || ""), String(item.outputId || ""), String(item.profileId || ""), json(item)]);
      insertRows(database, ARRAY_TABLES.qualityReports, source.qualityReports, ["id", "output_id", "profile_id", "policy_version", "payload_json"], (item) => [String(item.qualityReportId || item.id || ""), String(item.outputId || ""), String(item.profileId || ""), String(item.policyVersion || ""), json(item)]);
      insertRows(database, ARRAY_TABLES.jobs, source.jobs, ["id", "status", "payload_json"], (item) => [String(item.id || ""), String(item.status || ""), json(item)]);
      insertRows(database, ARRAY_TABLES.jobEvents, source.jobEvents, ["id", "job_id", "payload_json"], (item) => [String(item.id || item.eventId || ""), String(item.jobId || ""), json(item)]);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  try { copyFileSync(sqlitePath, `${sqlitePath}.backup`); } catch {}
  return sqlitePath;
}
