import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { copyProductionDependencies } from "../scripts/copy-production-dependencies.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-package-storage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packages = { "": { dependencies: { runtime: "1.0.0" } } };
  async function write(file, content = "fixture") {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  async function pkg(key, flags = {}, manifest = {}) {
    packages[key] = { version: "1.0.0", ...flags };
    await write(`${key}/package.json`, JSON.stringify({ name: key.split("/").pop(), version: "1.0.0", ...manifest }));
    await write(`${key}/index.js`);
  }
  const lock = () => write("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages }));
  return { root, packages, write, pkg, lock, target: path.join(root, "release", "MagicBox") };
}

test("production package preserves nested/optional dependencies and bins, excludes development caches and foreign FFprobe binaries", async (t) => {
  const f = await fixture(t);
  await f.pkg("node_modules/runtime", {}, { bin: { runtime: "index.js" } });
  await f.pkg("node_modules/runtime/node_modules/nested");
  await f.pkg("node_modules/runtime/node_modules/dev-only", { dev: true });
  await f.pkg("node_modules/native", { optional: true, devOptional: true });
  await f.pkg("node_modules/dev-tool", { dev: true });
  await f.pkg("node_modules/ffprobe-static");
  f.packages["node_modules/absent-native"] = { version: "1.0.0", optional: true };
  await f.write("node_modules/.vite/cache");
  await f.write("node_modules/.bin/runtime.cmd", "runtime shim");
  for (const variant of ["win32/x64/ffprobe.exe", "win32/ia32/ffprobe.exe", "linux/x64/ffprobe", "darwin/arm64/ffprobe"]) {
    await f.write(`node_modules/ffprobe-static/bin/${variant}`);
  }
  await f.lock();
  await f.write("release/MagicBox/node_modules/stale/index.js");
  const result = await copyProductionDependencies(f.root, f.target, { platform: "win32", arch: "x64" });
  assert.equal(result.packageCount, 4);
  for (const file of ["runtime/index.js", "runtime/node_modules/nested/index.js", "native/index.js", ".bin/runtime.cmd", "ffprobe-static/bin/win32/x64/ffprobe.exe"]) {
    assert.equal(await fs.readFile(path.join(f.target, "node_modules", file), "utf8"), await fs.readFile(path.join(f.root, "node_modules", file), "utf8"));
  }
  for (const excluded of ["dev-tool", "runtime/node_modules/dev-only", ".vite", "stale", "ffprobe-static/bin/linux", "ffprobe-static/bin/darwin", "ffprobe-static/bin/win32/ia32"]) {
    await assert.rejects(fs.access(path.join(f.target, "node_modules", excluded)), { code: "ENOENT" });
  }
  await fs.access(path.join(f.root, "node_modules/dev-tool/index.js"));
});

test("missing required or mismatched production dependencies fail before deleting an existing package", async (t) => {
  const f = await fixture(t);
  await f.pkg("node_modules/runtime");
  f.packages["node_modules/missing"] = { version: "1.0.0" };
  await f.write("release/MagicBox/node_modules/sentinel", "keep");
  await f.lock();
  await assert.rejects(copyProductionDependencies(f.root, f.target), /Missing or linked/);
  delete f.packages["node_modules/missing"];
  f.packages["node_modules/runtime"].version = "2.0.0";
  await f.lock();
  await assert.rejects(copyProductionDependencies(f.root, f.target), /differs from lock/);
  assert.equal(await fs.readFile(path.join(f.target, "node_modules/sentinel"), "utf8"), "keep");
});

test("dependency copier rejects escaping paths and workspace/installed-tree destinations", async (t) => {
  const f = await fixture(t);
  f.packages["node_modules/../../escape"] = { version: "1.0.0" };
  await f.lock();
  await assert.rejects(copyProductionDependencies(f.root, f.target), /Unsafe package lock path/);
  for (const target of [f.root, path.dirname(f.root), path.join(f.root, "node_modules/target")]) {
    await assert.rejects(copyProductionDependencies(f.root, target), /separate directory/);
  }
});

test("cleanup preserves SQLite-only training assets and offline caches, and WhatIf changes nothing", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  await f.write("scripts/cleanup-magicbox.ps1", await fs.readFile(new URL("../scripts/cleanup-magicbox.ps1", import.meta.url)));
  const protectedFiles = [
    "release/chromium/MagicBox/voice_clone/profiles/p/training/sqlite-model/weights.pth",
    "release/chromium/MagicBox/voice_clone/voice_clone.json",
    "release/chromium/MagicBox/voice_clone/voice_clone.sqlite",
    "release/chromium/MagicBox/voice_clone/engine/cache/offline.pth",
    "release/chromium/MagicBox/voice_clone/engine/downloads/model.pth",
    "release/chromium/MagicBox/voice_clone/temp/active.wav"
  ];
  for (const file of protectedFiles) await f.write(file, "preserve");
  await f.write("server/__pycache__/generated.pyc");
  const run = (extra = []) => {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(f.root, "scripts/cleanup-magicbox.ps1"), ...extra], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  run(["-WhatIf"]);
  await fs.access(path.join(f.root, "server/__pycache__/generated.pyc"));
  run();
  await assert.rejects(fs.access(path.join(f.root, "server/__pycache__/generated.pyc")), { code: "ENOENT" });
  for (const file of protectedFiles) assert.equal(await fs.readFile(path.join(f.root, file), "utf8"), "preserve");
});
