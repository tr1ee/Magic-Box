import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const releaseRoot = path.resolve(process.argv[2] || "release/chromium/MagicBox");
const manifestPath = path.join(releaseRoot, "assistant-package-manifest.json");
const requiredRoots = [
  "MagicBox.exe",
  "MagicBox.FileOps.exe",
  "Microsoft.Web.WebView2.Core.dll",
  "Microsoft.Web.WebView2.WinForms.dll",
  "WebView2Loader.dll",
  "node.exe",
  "dist",
  "server",
  "node_modules",
  "shared",
  "scripts",
  "vendor/llama",
  "vendor/ffmpeg",
  "package.json",
  "package-lock.json"
];
if (!await fs.access(path.join(releaseRoot, "basic-package.json")).then(() => true, () => false)) {
  requiredRoots.push("artifacts/live-voice-benchmark.json", "vendor/webview2-fixed");
} else {
  requiredRoots.push("basic-package.json", "vendor/python/bin/yt-dlp.exe");
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function enumerate(relativePath) {
  const absolute = path.join(releaseRoot, relativePath);
  const stats = await fs.lstat(absolute);
  if (stats.isSymbolicLink()) throw new Error(`Package manifest rejects links: ${relativePath}`);
  if (stats.isFile()) return [{ relativePath: relativePath.replaceAll("\\", "/"), sizeBytes: stats.size, sha256: await sha256(absolute) }];
  if (!stats.isDirectory()) return [];
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) files.push(...await enumerate(path.join(relativePath, entry.name)));
  return files;
}

const files = [];
for (const required of requiredRoots) {
  try { files.push(...await enumerate(required)); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error(`Required packaged path is missing: ${required}`);
    throw error;
  }
}
files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
const rootHash = createHash("sha256").update(files.map((entry) => `${entry.relativePath}\0${entry.sizeBytes}\0${entry.sha256}\n`).join(""), "utf8").digest("hex");
const manifest = {
  schemaVersion: 1,
  buildId: rootHash.slice(0, 20),
  rootHash,
  generatedAt: new Date().toISOString(),
  immutableRoots: requiredRoots,
  mutablePortablePaths: ["image-failure-manifests/**"],
  fileCount: files.length,
  files
};
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "w" });
console.log(`Package manifest ${manifest.buildId}: ${files.length} files`);
