import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Copy the installed, locked production tree without reinstalling packages or
// rerunning native postinstall scripts. Development dependencies stay in the repo.
export async function copyProductionDependencies(sourceRoot, targetRoot, { platform = process.platform, arch = process.arch } = {}) {
  sourceRoot = await fs.realpath(sourceRoot);
  targetRoot = path.resolve(targetRoot);
  const relative = path.relative(sourceRoot, targetRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).includes("node_modules")) {
    throw new Error("Dependency target must be a separate directory inside the workspace.");
  }
  // Reject links in the target ancestry before making any changes.
  let cursor = sourceRoot;
  for (const segment of relative.split(path.sep).concat("node_modules")) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (stat?.isSymbolicLink()) throw new Error(`Dependency target rejects links: ${cursor}`);
  }
  const lock = JSON.parse(await fs.readFile(path.join(sourceRoot, "package-lock.json"), "utf8"));
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages) throw new Error("A version 2/3 npm package lock is required.");
  const packages = [];
  for (const [key, record] of Object.entries(lock.packages)) {
    if (!key || record.dev) continue;
    if (!/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(key)
      || key.split("/").some((segment) => segment === ".." || segment === "." || segment.includes("\\") || segment.includes(":"))) {
      throw new Error(`Unsafe package lock path: ${key}`);
    }
    const source = path.join(sourceRoot, key);
    const stat = await fs.lstat(source).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (!stat && record.optional) continue;
    if (!stat?.isDirectory() || stat.isSymbolicLink() || record.link) throw new Error(`Missing or linked production dependency: ${key}`);
    const manifest = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
    if (record.version && manifest.version !== record.version) throw new Error(`Installed dependency differs from lock: ${key}`);
    packages.push({ key, source, manifest });
  }
  // Fail closed before replacing the previous tree if any required package is missing.
  const modules = path.join(targetRoot, "node_modules");
  await fs.rm(modules, { recursive: true, force: true });
  await fs.mkdir(modules, { recursive: true });
  for (const { key, source, manifest } of packages) {
    await fs.cp(source, path.join(targetRoot, key), {
      recursive: true,
      filter: async (entry) => {
        const local = path.relative(source, entry).split(path.sep);
        if (local.includes("node_modules")) return false;
        // ffprobe-static ships all operating systems. Its entry point selects
        // exactly bin/<platform>/<arch>; preserve that complete directory.
        if (manifest.name === "ffprobe-static" && local[0] === "bin") {
          if (local.length > 1 && local[1] !== platform) return false;
          if (local.length > 2 && local[2] !== arch) return false;
        }
        if ((await fs.lstat(entry)).isSymbolicLink()) throw new Error(`Dependency payload rejects links: ${entry}`);
        return true;
      }
    });
    // Preserve installed command shims for production packages, including nested ones.
    const bins = typeof manifest.bin === "string"
      ? [manifest.name.split("/").pop()] : Object.keys(manifest.bin || {});
    const moduleParent = key.slice(0, key.lastIndexOf("node_modules/") + "node_modules".length);
    for (const bin of bins) {
      if (!/^[A-Za-z0-9_.-]+$/.test(bin) || bin === "." || bin === "..") throw new Error(`Unsafe dependency command: ${bin}`);
      for (const suffix of ["", ".cmd", ".ps1"]) {
        const shim = path.join(moduleParent, ".bin", bin + suffix);
        try {
          await fs.mkdir(path.dirname(path.join(targetRoot, shim)), { recursive: true });
          await fs.copyFile(path.join(sourceRoot, shim), path.join(targetRoot, shim));
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
  }
  return { packageCount: packages.length, platform, arch };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error("Usage: copy-production-dependencies.mjs <workspace> <package>");
  console.log(JSON.stringify(await copyProductionDependencies(process.argv[2], process.argv[3])));
}
