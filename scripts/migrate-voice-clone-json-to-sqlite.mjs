import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

const rootDir = path.resolve(import.meta.dirname, "..");
const dataRoot = path.join(rootDir, "MagicBoxData", "voice_clone");
const jsonPath = path.resolve(argument("--db", path.join(dataRoot, "voice_clone.json")));
const sqlitePath = path.resolve(argument("--sqlite", path.join(dataRoot, "voice_clone.sqlite3")));
const apply = process.argv.includes("--apply");

const raw = await fs.readFile(jsonPath, "utf8");
const source = JSON.parse(raw);
const arrays = {
  profiles: Array.isArray(source.profiles) ? source.profiles : [],
  samples: Array.isArray(source.samples) ? source.samples : [],
  outputs: Array.isArray(source.outputs) ? source.outputs : [],
  artifacts: Array.isArray(source.artifacts) ? source.artifacts : [],
  referencePacks: Array.isArray(source.referencePacks) ? source.referencePacks : [],
  attempts: Array.isArray(source.attempts) ? source.attempts : [],
  qualityReports: Array.isArray(source.qualityReports) ? source.qualityReports : [],
  jobs: Array.isArray(source.jobs) ? source.jobs : [],
  jobEvents: Array.isArray(source.jobEvents) ? source.jobEvents : []
};
const sourceSha256 = createHash("sha256").update(raw, "utf8").digest("hex");
const counts = Object.fromEntries(Object.entries(arrays).map(([key, value]) => [key, value.length]));

if (!apply) {
  console.log(JSON.stringify({ dryRun: true, jsonPath, sqlitePath, sourceSha256, counts }, null, 2));
  process.exit(0);
}

await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
const tempPath = `${sqlitePath}.migration-${process.pid}-${Date.now()}.tmp`;
const backupPath = `${sqlitePath}.backup`;
const db = new DatabaseSync(tempPath);
try {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, status TEXT, engine TEXT, quality_mode TEXT, active_model_version_id TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE samples (id TEXT PRIMARY KEY, profile_id TEXT, payload_json TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, profile_id TEXT, output_id TEXT, relative_path TEXT, sha256 TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE reference_packs (id TEXT PRIMARY KEY, profile_id TEXT, model_version_id TEXT, purpose TEXT, sha256 TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE model_versions (id TEXT PRIMARY KEY, profile_id TEXT, engine TEXT, quality_mode TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE job_events (id TEXT PRIMARY KEY, job_id TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE generation_attempts (id TEXT PRIMARY KEY, output_id TEXT, profile_id TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE quality_reports (id TEXT PRIMARY KEY, output_id TEXT, profile_id TEXT, policy_version TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE outputs (id TEXT PRIMARY KEY, profile_id TEXT, model_version_id TEXT, generation_path TEXT, payload_json TEXT NOT NULL);
    CREATE INDEX idx_samples_profile ON samples(profile_id);
    CREATE INDEX idx_outputs_profile ON outputs(profile_id);
    CREATE INDEX idx_quality_reports_output ON quality_reports(output_id);
    CREATE INDEX idx_attempts_output ON generation_attempts(output_id);
  `);
  const insertMeta = db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)");
  insertMeta.run("schemaVersion", "1");
  insertMeta.run("sourceJsonPath", jsonPath);
  insertMeta.run("sourceSha256", sourceSha256);
  insertMeta.run("migratedAt", new Date().toISOString());

  const insertProfile = db.prepare("INSERT OR REPLACE INTO profiles(id,status,engine,quality_mode,active_model_version_id,payload_json) VALUES(?,?,?,?,?,?)");
  const insertSample = db.prepare("INSERT OR REPLACE INTO samples(id,profile_id,payload_json) VALUES(?,?,?)");
  const insertOutput = db.prepare("INSERT OR REPLACE INTO outputs(id,profile_id,model_version_id,generation_path,payload_json) VALUES(?,?,?,?,?)");
  const insertArtifact = db.prepare("INSERT OR REPLACE INTO artifacts(id,profile_id,output_id,relative_path,sha256,payload_json) VALUES(?,?,?,?,?,?)");
  const insertPack = db.prepare("INSERT OR REPLACE INTO reference_packs(id,profile_id,model_version_id,purpose,sha256,payload_json) VALUES(?,?,?,?,?,?)");
  const insertAttempt = db.prepare("INSERT OR REPLACE INTO generation_attempts(id,output_id,profile_id,payload_json) VALUES(?,?,?,?)");
  const insertQuality = db.prepare("INSERT OR REPLACE INTO quality_reports(id,output_id,profile_id,policy_version,payload_json) VALUES(?,?,?,?,?)");
  const insertModel = db.prepare("INSERT OR REPLACE INTO model_versions(id,profile_id,engine,quality_mode,payload_json) VALUES(?,?,?,?,?)");
  const insertJob = db.prepare("INSERT OR REPLACE INTO jobs(id,status,payload_json) VALUES(?,?,?)");
  const insertJobEvent = db.prepare("INSERT OR REPLACE INTO job_events(id,job_id,payload_json) VALUES(?,?,?)");

  for (const item of arrays.profiles) {
    const id = String(item.id || `profile-${Math.random().toString(16).slice(2)}`);
    insertProfile.run(id, item.status || "", item.engine || item.voiceModel?.engine || "", item.qualityMode || "", item.activeModelVersionId || item.voiceModel?.versionId || "", JSON.stringify(item));
    for (const version of Array.isArray(item.modelVersions) ? item.modelVersions : []) {
      if (!version?.id) continue;
      insertModel.run(String(version.id), id, version.engine || version.voiceModel?.engine || "", version.qualityMode || version.voiceModel?.qualityMode || "", JSON.stringify(version));
    }
  }
  for (const item of arrays.samples) {
    insertSample.run(String(item.id), String(item.profileId || ""), JSON.stringify(item));
  }
  for (const item of arrays.outputs) {
    insertOutput.run(String(item.id), String(item.profileId || ""), String(item.modelVersionId || item.settings?.modelVersionId || ""), String(item.settings?.generationPath || item.generationPath || ""), JSON.stringify(item));
  }
  for (const item of arrays.artifacts) {
    insertArtifact.run(String(item.id || item.artifactId), String(item.profileId || ""), String(item.outputId || ""), String(item.relativePath || ""), String(item.sha256 || ""), JSON.stringify(item));
  }
  for (const item of arrays.referencePacks) {
    insertPack.run(String(item.referencePackId || item.id), String(item.profileId || ""), String(item.modelVersionId || ""), String(item.purpose || ""), String(item.sha256 || ""), JSON.stringify(item));
  }
  for (const item of arrays.attempts) {
    insertAttempt.run(String(item.id || item.attemptId), String(item.outputId || ""), String(item.profileId || ""), JSON.stringify(item));
  }
  for (const item of arrays.qualityReports) {
    insertQuality.run(String(item.qualityReportId || item.id), String(item.outputId || ""), String(item.profileId || ""), String(item.policyVersion || ""), JSON.stringify(item));
  }
  for (const item of arrays.jobs) {
    insertJob.run(String(item.id || ""), String(item.status || ""), JSON.stringify(item));
  }
  for (const item of arrays.jobEvents) {
    insertJobEvent.run(String(item.id || item.eventId || ""), String(item.jobId || ""), JSON.stringify(item));
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
} finally {
  db.close();
}

try { await fs.copyFile(sqlitePath, backupPath); } catch {}
await fs.rename(tempPath, sqlitePath);
const verify = new DatabaseSync(sqlitePath);
try {
  verify.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  const rows = verify.prepare("SELECT 'profiles' AS name, COUNT(*) AS count FROM profiles UNION ALL SELECT 'samples', COUNT(*) FROM samples UNION ALL SELECT 'outputs', COUNT(*) FROM outputs UNION ALL SELECT 'artifacts', COUNT(*) FROM artifacts UNION ALL SELECT 'referencePacks', COUNT(*) FROM reference_packs UNION ALL SELECT 'attempts', COUNT(*) FROM generation_attempts UNION ALL SELECT 'qualityReports', COUNT(*) FROM quality_reports UNION ALL SELECT 'jobs', COUNT(*) FROM jobs UNION ALL SELECT 'jobEvents', COUNT(*) FROM job_events").all();
  const verifiedCounts = Object.fromEntries(rows.map((row) => [row.name, Number(row.count)]));
  console.log(JSON.stringify({ applied: true, jsonPath, sqlitePath, backupPath, sourceSha256, counts, verifiedCounts }, null, 2));
} finally {
  verify.close();
}
