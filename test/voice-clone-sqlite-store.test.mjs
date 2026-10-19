import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  readVoiceCloneSqlite,
  voiceCloneSqliteEnabled,
  writeVoiceCloneSqlite
} from "../server/voice-clone-sqlite-store.mjs";

test("SQLite voice store keeps WAL metadata, outputs, and durable jobs/events", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-voice-sqlite-test-"));
  const sqlitePath = path.join(directory, "voice_clone.sqlite3");
  try {
    assert.equal(voiceCloneSqliteEnabled({ VOICE_CLONE_STORAGE: "sqlite" }), true);
    const source = {
      schemaVersion: 2,
      profiles: [{ id: "profile-1", status: "ready", voiceModel: { versionId: "model-1" }, modelVersions: [{ id: "model-1" }] }],
      samples: [{ id: "sample-1", profileId: "profile-1" }],
      outputs: [{ id: "output-1", profileId: "profile-1", settings: { modelVersionId: "model-1" } }],
      artifacts: [],
      referencePacks: [],
      attempts: [],
      qualityReports: [{ qualityReportId: "quality-1", outputId: "output-1" }],
      jobs: [{ id: "job-1", status: "completed", progress: 100 }],
      jobEvents: [{ id: "event-1", jobId: "job-1", status: "completed" }]
    };
    writeVoiceCloneSqlite(sqlitePath, source);
    const roundTrip = readVoiceCloneSqlite(sqlitePath);
    assert.equal(roundTrip.outputs.length, 1);
    assert.equal(roundTrip.qualityReports[0].outputId, "output-1");
    assert.equal(roundTrip.jobs[0].status, "completed");
    assert.equal(roundTrip.jobEvents[0].jobId, "job-1");
    const database = new DatabaseSync(sqlitePath);
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM model_versions").get().count, 1);
    database.close();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
