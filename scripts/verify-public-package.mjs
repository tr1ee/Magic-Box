import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyPublicPackage(directory, { cleanCaches = false } = {}) {
  const root = await fs.realpath(directory);
  const disallowed = /\.(?:gguf|ggml|safetensors|ckpt|pth|pt|onnx|pkl|npz|npy|sqlite(?:-wal|-shm)?|db|pem|key)$/i;
  const privateDirs = new Set(["MagicBoxData", "voice_clone", "backups", "artifacts", "WebView2Profile", ".git", ".env"]);
  let files = 0, bytes = 0;
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const relative = path.relative(root, target);
      if (entry.isSymbolicLink()) throw new Error(`Public package rejects links: ${relative}`);
      if (entry.name === "__pycache__" || /\.py[co]$/i.test(entry.name)) {
        if (!cleanCaches) throw new Error(`Python cache in public package: ${relative}`);
        await fs.rm(target, { recursive: true, force: true });
        continue;
      }
      if (privateDirs.has(entry.name) || /^\.env(?:\.|$)/.test(entry.name) || /cookies.*\.txt$/i.test(entry.name)) throw new Error(`Private data in public package: ${relative}`);
      if (entry.isDirectory()) await walk(target);
      else {
        if (disallowed.test(entry.name) || /(?:pytorch_model|model-\d+-of-\d+).*\.bin$/i.test(entry.name)) throw new Error(`Model/private asset in public package: ${relative}`);
        const stat = await fs.stat(target);
        if (stat.size > 256 * 1024 * 1024) throw new Error(`Unexpected large asset: ${relative}`);
        files++;
        bytes += stat.size;
      }
    }
  }
  await walk(root);
  return { verified: true, modelsBundled: false, personalDataBundled: false, files, bytes };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await verifyPublicPackage(process.argv[2], { cleanCaches: process.argv.includes("--clean-caches") })));
}
