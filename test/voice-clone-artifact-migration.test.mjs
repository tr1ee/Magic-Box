import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("artifact migration is dry-run by default and apply is additive and repeatable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-artifact-migration-"));
  const audioPath = path.join(root, "profiles", "p1", "reference.wav");
  await fs.mkdir(path.dirname(audioPath), { recursive: true });
  await fs.writeFile(audioPath, Buffer.from("voice-fixture"));
  const dbPath = path.join(root, "voice_clone.json");
  await fs.writeFile(dbPath, JSON.stringify({ profiles: [{ id: "p1", voiceModel: { referenceAudioPath: audioPath } }], samples: [], outputs: [] }));
  const script = path.resolve("scripts/migrate-voice-clone-artifacts-v2.mjs");
  const reportPath = path.join(root, "report.json");
  const dryRun = await execFileAsync(process.execPath, [script, "--managed-root", root, "--db", dbPath, "--report", reportPath], { windowsHide: true });
  const dryReport = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.equal(dryReport.dryRun, true);
  assert.equal(JSON.parse(await fs.readFile(dbPath, "utf8")).artifacts, undefined);
  assert.ok(dryRun.stdout.includes("artifactCount"));

  await execFileAsync(process.execPath, [script, "--apply", "--managed-root", root, "--db", dbPath, "--report", reportPath], { windowsHide: true });
  const applied = JSON.parse(await fs.readFile(dbPath, "utf8"));
  assert.equal(applied.artifacts.length, 1);
  const backupFiles = (await fs.readdir(root)).filter((name) => name.includes("before-artifact-migration"));
  assert.ok(backupFiles.length >= 1);

  await execFileAsync(process.execPath, [script, "--apply", "--managed-root", root, "--db", dbPath, "--report", reportPath], { windowsHide: true });
  const repeated = JSON.parse(await fs.readFile(dbPath, "utf8"));
  assert.equal(repeated.artifacts.length, 1);
  assert.ok((await fs.readdir(root)).filter((name) => name.includes("before-artifact-migration")).length >= backupFiles.length);
});
