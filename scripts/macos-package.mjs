import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const kitDirectories = ["src", "public", "server", "shared", "desktop/macos", "scripts", "test"];
export const kitFiles = ["package.json", "package-lock.json", "index.html", "vite.config.js", "vitest.config.mjs", "README.md", "docs/macos.md", "docs/USER_GUIDE.md", "docs/DEVELOPMENT.md", "docs/THIRD_PARTY.md", "Build-Mac.command"];
const forbiddenDirectories = new Set(["node_modules", "MagicBoxData", "voice_clone", "models", "backups", "artifacts", "vendor", ".git", "__pycache__", ".cache", ".venvs", ".venv"]);
const modelExtension = /\.(?:gguf|safetensors|ckpt|pth|pt|onnx|pkl|npz|pyc|exe|dll)$/i;

export function includeSource(file) {
  const parts = file.replaceAll("\\", "/").split("/");
  return !parts.some(part => forbiddenDirectories.has(part)) && !modelExtension.test(parts.at(-1));
}

export async function copySources(source, destination, directories, files) {
  await fs.mkdir(destination, { recursive: true });
  for (const name of [...directories, ...files]) {
    const from = path.join(source, name);
    await fs.mkdir(path.dirname(path.join(destination, name)), { recursive: true });
    await fs.cp(from, path.join(destination, name), {
      recursive: true,
      filter: async file => {
        if (!includeSource(path.relative(source, file))) return false;
        if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`Source links are not packaged: ${file}`);
        return true;
      }
    });
  }
}

export async function sha256(file) {
  const hash = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyModelFree(root) {
  let bytes = 0;
  let files = 0;
  async function walk(dir, relative = "") {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected payload link: ${name}`);
      if (entry.isDirectory()) {
        if (["MagicBoxData", "voice_clone", "backups", "artifacts", "WebView2Profile"].includes(entry.name)) throw new Error(`User/model data was packaged: ${name}`);
        await walk(path.join(dir, entry.name), name);
      } else {
        if (modelExtension.test(entry.name)) throw new Error(`Model or Windows binary was packaged: ${name}`);
        const stat = await fs.stat(path.join(dir, entry.name));
        if (stat.size > 256 * 1024 * 1024) throw new Error(`Unexpected large asset: ${name}`);
        bytes += stat.size;
        files++;
      }
    }
  }
  await walk(root);
  return { modelFree: true, files, bytes };
}
