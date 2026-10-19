import fs from "node:fs/promises";
import path from "node:path";
import { artifactFromAbsolutePath } from "../server/voice-clone-artifacts.mjs";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

const rootDir = path.resolve(process.cwd());
const managedRoot = path.resolve(argument("--managed-root", process.env.MAGIC_BOX_VOICE_DATA_ROOT || path.join(rootDir, "MagicBoxData", "voice_clone")));
const dbPath = path.resolve(argument("--db", path.join(managedRoot, "voice_clone.json")));
const reportPath = path.resolve(argument("--report", path.join(managedRoot, "voice-clone-artifact-migration-report.json")));
const apply = process.argv.includes("--apply");
const raw = await fs.readFile(dbPath, "utf8");
const db = JSON.parse(raw);
const artifacts = [];
const missing = [];
const duplicates = [];
const convertedReferences = [];
const seen = new Map();

function classify(key) {
  if (/reference|prompt/iu.test(key)) return "reference_audio";
  if (/segment|audio|vocal|accompaniment/iu.test(key)) return "voice_audio";
  if (/model|weight|checkpoint|dataset/iu.test(key)) return "voice_model_artifact";
  return "voice_artifact";
}

async function visit(value, context = {}) {
  if (Array.isArray(value)) {
    for (const item of value) await visit(item, context);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && path.isAbsolute(child) && /path|audio|file/iu.test(key)) {
      const artifact = await artifactFromAbsolutePath({
        absolutePath: child,
        managedRoot,
        profileId: context.profileId || value.profileId || "",
        kind: classify(key)
      }).catch(() => null);
      if (!artifact) {
        const resolved = path.resolve(child);
        const relative = path.relative(managedRoot, resolved);
        if (!relative.startsWith("..") && !path.isAbsolute(relative)) missing.push({ key, path: child });
        continue;
      }
      convertedReferences.push({
        key,
        profileId: context.profileId || value.profileId || "",
        legacyAbsolutePath: child,
        relativePath: artifact.relativePath,
        artifactId: artifact.artifactId,
        sha256: artifact.sha256
      });
      const existing = seen.get(artifact.sha256);
      if (existing) {
        duplicates.push({ sha256: artifact.sha256, paths: [existing.relativePath, artifact.relativePath] });
      } else {
        seen.set(artifact.sha256, artifact);
        artifacts.push(artifact);
      }
    }
    await visit(child, { ...context, profileId: value.profileId || context.profileId || "" });
  }
}

await visit(db);
const report = {
  schemaVersion: "voice-clone-artifact-migration-v2",
  dryRun: !apply,
  dbPath,
  managedRoot,
  createdAt: new Date().toISOString(),
  artifactCount: artifacts.length,
  missing,
  duplicates,
  convertedReferences,
  artifacts
};

if (apply) {
  const backupPath = `${dbPath}.before-artifact-migration-${Date.now()}.backup`;
  await fs.copyFile(dbPath, backupPath);
  const existingArtifacts = [
    ...(Array.isArray(db.artifacts) ? db.artifacts : []),
    ...(Array.isArray(db.voiceCloneArtifacts) ? db.voiceCloneArtifacts : [])
  ];
  const mergedArtifacts = [
    ...existingArtifacts,
    ...artifacts.filter((artifact) => !existingArtifacts.some((existing) => existing.sha256 === artifact.sha256 && existing.relativePath === artifact.relativePath))
  ].filter((artifact, index, list) => list.findIndex((item) => item.sha256 === artifact.sha256 && item.relativePath === artifact.relativePath) === index);
  db.schemaVersion = Math.max(2, Number(db.schemaVersion) || 2);
  db.artifacts = mergedArtifacts;
  // Keep the legacy key for older MagicBox builds. The migration is additive;
  // no source file or legacy absolute field is removed automatically.
  db.voiceCloneArtifacts = mergedArtifacts;
  const tempPath = `${dbPath}.${process.pid}.migration.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(db, null, 2), "utf8");
  await fs.rename(tempPath, dbPath);
  report.backupPath = backupPath;
}

await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
