import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { includeSource, copySources, verifyModelFree } from "../scripts/macos-package.mjs";
import { chooseMacFolder, voiceInstallPlatformError } from "../server/macos-system.mjs";

test("Mac source packaging excludes models, training, caches and Windows binaries", () => {
  for (const file of ["MagicBoxData/voice_clone/a.json", "server/__pycache__/x.pyc", "server/models/base.gguf", "backups/a.txt", "vendor/node.exe", "desktop/x.dll", "server/weights.pth", "server/weights.safetensors"]) assert.equal(includeSource(file), false, file);
  for (const file of ["server/assistant/model-catalog.json", "server/live_voice_worker.py", "desktop/macos/MagicBox.swift", "src/App.jsx"]) assert.equal(includeSource(file), true, file);
});

test("model-free verification rejects leaked weights and private data", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-mac-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "basic.mjs"), "basic");
  assert.deepEqual(await verifyModelFree(dir), { modelFree: true, files: 1, bytes: 5 });
  await fs.writeFile(path.join(dir, "trained.ckpt"), "weight");
  await assert.rejects(verifyModelFree(dir), /Model or Windows binary/);
  await fs.unlink(path.join(dir, "trained.ckpt"));
  await fs.mkdir(path.join(dir, "voice_clone"));
  await assert.rejects(verifyModelFree(dir), /User\/model data/);
});

test("source staging copies basic assets while filtering cached models", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-mac-copy-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source");
  const target = path.join(dir, "target");
  await fs.mkdir(path.join(source, "server/models"), { recursive: true });
  await fs.writeFile(path.join(source, "server/index.mjs"), "basic");
  await fs.writeFile(path.join(source, "server/models/base.gguf"), "model");
  await copySources(source, target, ["server"], []);
  assert.equal(await fs.readFile(path.join(target, "server/index.mjs"), "utf8"), "basic");
  await assert.rejects(fs.access(path.join(target, "server/models")));
});

test("Mac folder paths are passed as arguments, and cancel returns empty", async () => {
  const dangerous = '/Users/name/Downloads/" & do shell script "touch /tmp/no"';
  assert.equal(await chooseMacFolder(dangerous, async (bin, args) => {
    assert.equal(bin, "/usr/bin/osascript");
    assert.equal(args.at(-1), dangerous);
    assert.equal(args[1].includes(dangerous), false);
    return { stdout: "/Users/name/Downloads/\n" };
  }), "/Users/name/Downloads/");
  assert.equal(await chooseMacFolder("", async () => ({ stdout: "\n" })), "");
});

test("Mac voice setup gives an actionable platform message without affecting Windows", () => {
  assert.match(voiceInstallPlatformError("darwin", false), /Private Assistant → Models/);
  assert.equal(voiceInstallPlatformError("win32", false), null);
  assert.equal(voiceInstallPlatformError("darwin", true), null);
});
