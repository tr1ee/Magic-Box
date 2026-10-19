import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Inspect exactly what Git will publish, independently of .gitignore.
const files = execFileSync("git", ["ls-files", "--cached", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
if (!files.length) throw new Error("No source files are staged/tracked.");
const roots = new Set(["src", "public", "server", "shared", "scripts", "test", "desktop", ".github"]);
const top = new Set([".gitignore", ".gitattributes", "AGENTS.md", "Build-Mac.command", "README.md", "package.json", "package-lock.json", "index.html", "vite.config.js", "vitest.config.mjs"]);
const docs = new Set(["docs/USER_GUIDE.md", "docs/DEVELOPMENT.md", "docs/THIRD_PARTY.md", "docs/macos.md", "docs/startup-motion-assets.md", "docs/startup-v6-generation-prompts.json"]);
const suspicious = /(?:sk-proj-[a-zA-Z0-9_-]{25,}|github_pat_[a-zA-Z0-9_]{25,}|gh[pousr]_[a-zA-Z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
let bytes = 0;
const manifest = [];
for (const file of files) {
  if (!top.has(file) && !docs.has(file) && !roots.has(file.split("/")[0])) throw new Error(`Unexpected public source path: ${file}`);
  if (/(?:^|\/)(?:node_modules|vendor|MagicBoxData|voice_clone|artifacts|backups|__pycache__|\.cache|\.env)(?:\/|$)/.test(file)
    || /\.(?:gguf|ggml|safetensors|ckpt|pth|pt|onnx|pkl|npz|npy|bin|exe|dll|dylib|so|node|pyc|sqlite|pem|key)$/i.test(file)) throw new Error(`Private/model/binary source path: ${file}`);
  // Read the indexed bytes so a later unstaged edit cannot hide staged secrets.
  const content = execFileSync("git", ["show", `:${file}`], { maxBuffer: 16 * 1024 * 1024 });
  if (content.length > 10 * 1024 * 1024) throw new Error(`Unexpected large source file: ${file}`);
  if (/\.(?:mjs|js|jsx|json|md|yml|py|ps1|cs|swift|html|txt)$/i.test(file) && suspicious.test(content.toString("utf8"))) throw new Error(`Possible credential in source: ${file}`);
  bytes += content.length;
  manifest.push({ file, size: content.length, sha256: createHash("sha256").update(content).digest("hex") });
}
const result = { verified: true, modelsIncluded: false, knownCredentialPatterns: false, files: files.length, bytes };
await fs.mkdir(".cache/publication", { recursive: true });
await fs.writeFile(".cache/publication/source-manifest.json", JSON.stringify({ ...result, manifest }, null, 2));
console.log(JSON.stringify(result));
