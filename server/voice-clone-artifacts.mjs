import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createArtifactRecord, normalizeRelativeArtifactPath, resolveManagedArtifactPath } from "../shared/voiceClonePipeline.mjs";

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function artifactFromAbsolutePath({ absolutePath, managedRoot, profileId = "", kind = "voice_artifact" } = {}) {
  const resolvedRoot = path.resolve(String(managedRoot || ""));
  const resolvedPath = path.resolve(String(absolutePath || ""));
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const stats = await fs.stat(resolvedPath);
  if (!stats.isFile()) return null;
  return createArtifactRecord({
    profileId,
    kind,
    relativePath: normalizeRelativeArtifactPath(relative),
    sha256: await sha256File(resolvedPath),
    byteSize: stats.size
  });
}

export async function verifyArtifactRecord({ artifact, managedRoot } = {}) {
  const absolutePath = resolveManagedArtifactPath(managedRoot, artifact?.relativePath);
  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch {
    const error = new Error(`Voice artifact was not found: ${artifact?.relativePath}`);
    error.code = "VOICE_ARTIFACT_NOT_FOUND";
    throw error;
  }
  const actualSha256 = await sha256File(absolutePath);
  return {
    absolutePath,
    exists: true,
    byteSize: stats.size,
    sha256: actualSha256,
    hashMatches: !artifact?.sha256 || actualSha256 === String(artifact.sha256).toLowerCase()
  };
}

