import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifyPublicPackage } from "../scripts/verify-public-package.mjs";

test("public package accepts programs but rejects model weights and personal data", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-public-package-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "node.exe"), "runtime");
  assert.equal((await verifyPublicPackage(dir)).modelsBundled, false);
  for (const file of ["model.gguf", "trained.pth", "model.safetensors", "pytorch_model.bin", "cookies.txt", ".env.local", "state.sqlite"]) {
    await fs.writeFile(path.join(dir, file), "private");
    await assert.rejects(verifyPublicPackage(dir), /Model\/private|Private data/);
    await fs.unlink(path.join(dir, file));
  }
  await fs.mkdir(path.join(dir, "voice_clone"));
  await assert.rejects(verifyPublicPackage(dir), /Private data/);
});

test("cache removal stays within the package and leaves source caches intact", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-public-cache-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source");
  const target = path.join(dir, "package");
  for (const root of [source, target]) {
    await fs.mkdir(path.join(root, "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(root, "__pycache__/worker.pyc"), "cache");
    await fs.writeFile(path.join(root, "worker.py"), "source");
  }
  await verifyPublicPackage(target, { cleanCaches: true });
  await assert.rejects(fs.access(path.join(target, "__pycache__")));
  await fs.access(path.join(source, "__pycache__/worker.pyc"));
  await fs.access(path.join(target, "worker.py"));
});
