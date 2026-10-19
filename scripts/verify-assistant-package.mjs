import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const packageRoot = path.resolve(value("--package") || "release/chromium/MagicBox");
const manifestPath = path.join(packageRoot, "assistant-package-manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const sha256 = async (filePath) => { const hash = createHash("sha256"); for await (const chunk of createReadStream(filePath)) hash.update(chunk); return hash.digest("hex"); };
let verifiedBytes = 0;
for (const entry of manifest.files) {
  const filePath = path.join(packageRoot, entry.relativePath);
  const stats = await fs.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== entry.sizeBytes || await sha256(filePath) !== entry.sha256) throw new Error(`Packaged file failed verification: ${entry.relativePath}`);
  verifiedBytes += stats.size;
}
for (const required of ["MagicBox.exe", "MagicBox.FileOps.exe", "node.exe", "server/assistant/models.mjs", "server/assistant/extract-worker.mjs", "vendor/llama/b9637/llama-server.exe"]) await fs.access(path.join(packageRoot, required));
console.log(JSON.stringify({ verified: true, packageRoot, buildId: manifest.buildId, rootHash: manifest.rootHash, fileCount: manifest.fileCount, verifiedBytes }, null, 2));
