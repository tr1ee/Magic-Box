import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function isOwnedTempName(name) {
  return /^voice-(?:job|vtv|song-v2v|seed-vc-v2v|vtv-multi-engine)[a-z0-9._-]*$/iu.test(String(name || ""));
}

function isExpired(mtimeMs, now, ttlMs) {
  return Number.isFinite(Number(mtimeMs)) && Number(now) - Number(mtimeMs) >= ttlMs;
}

/** Remove only VTV-owned, expired temporary directories. */
export async function sweepVtvTempArtifacts({
  rootDir,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  orphanRoots = [],
  removeExpired = true,
  removeAllOrphans = false
} = {}) {
  const root = path.resolve(String(rootDir || ""));
  if (!root || root === path.parse(root).root) {
    throw new Error("VTV temp cleanup requires a scoped root directory.");
  }
  const ttl = Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS);
  const removed = [];
  const skipped = [];
  const roots = Array.from(new Set((Array.isArray(orphanRoots) ? orphanRoots : [])
    .map((entry) => path.resolve(root, String(entry || "")))
    .filter((entry) => entry.startsWith(`${root}${path.sep}`))));

  for (const directory of roots) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || (!removeAllOrphans && !isOwnedTempName(entry.name))) {
        skipped.push(path.join(directory, entry.name));
        continue;
      }
      const candidate = path.join(directory, entry.name);
      const metadata = await fs.stat(candidate).catch(() => null);
      if (removeAllOrphans || (removeExpired && metadata && isExpired(metadata.mtimeMs, now, ttl))) {
        await fs.rm(candidate, { recursive: true, force: true });
        removed.push(candidate);
      } else {
        skipped.push(candidate);
      }
    }
  }
  return { removed, skipped, ttlMs: ttl };
}

export { DEFAULT_TTL_MS, isOwnedTempName };
