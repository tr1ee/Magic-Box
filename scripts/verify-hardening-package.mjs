import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const hasFlag = (name) => args.includes(name);
const packageRoot = path.resolve(value("--package") || "release/chromium/MagicBox");
const sourceRoot = process.cwd();
const pairedArtifacts = [
  "package.json",
  "package-lock.json",
  "server/index.mjs",
  "server/routes/voice-clone-routes.mjs",
  "server/voice_engine_worker_openvoice.py",
  "server/voice_engine_worker_gpt_sovits.py",
  "server/voice_engine_worker_preparation.py",
  "scripts/verify-ui-test-discovery.mjs",
  "scripts/verify-lazy-tool-pages.mjs",
  "scripts/package-voice-ingress-smoke.mjs",
  "scripts/install-voice-preparation.ps1",
  "scripts/verify-voice-clone-package.mjs",
  "scripts/verify-hardening-package.mjs",
  "shared/voiceClone.mjs",
  "dist/.vite/manifest.json"
];

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function requireFile(relativePath) {
  const filePath = path.join(packageRoot, relativePath);
  const info = await fs.stat(filePath);
  if (!info.isFile()) throw new Error(`Required packaged file is not a regular file: ${relativePath}`);
  return { filePath, info };
}

async function collectIpVersions(root) {
  const found = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      const child = path.join(directory, entry.name);
      const packageJson = path.join(child, "package.json");
      try {
        const manifest = JSON.parse(await fs.readFile(packageJson, "utf8"));
        if (manifest.name === "ip") found.push({ version: manifest.version || "unknown" });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await visit(child);
    }
  }
  await visit(root);
  return found;
}

function secretPatternCount(text) {
  const patterns = [
    /\b(?:authorization|proxy-authorization|cookie|set-cookie|token|access_token|id_token|signature|sig|upsig|key|x-amz-[a-z0-9-]+|x-goog-[a-z0-9-]+)\b\s*[:=]\s*(?!(?:bearer\s+|basic\s+)?\[redacted\])(?:bearer\s+|basic\s+)?[^\s,;]+/gi,
    /\b(?:bearer|basic)\s+(?!\[redacted\])[a-z0-9._~+/=-]+/gi,
    /https?:\/\/[^\s<>"']*(?:@|[?#][^\s<>"']+)/gi
  ];
  return patterns.reduce((count, pattern) => count + (text.match(pattern)?.length || 0), 0);
}

async function scanLauncherLogs() {
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    path.join(packageRoot, "MagicBox-launch.log"),
    path.join(packageRoot, "logs", "MagicBox-launch.log"),
    localAppData && path.join(localAppData, "MagicBox", "MagicBox-launch.log"),
    localAppData && path.join(localAppData, "MagicBox", "logs", "MagicBox-launch.log")
  ].filter(Boolean);
  const scanned = [];
  let prohibitedMatches = 0;
  for (const logPath of [...new Set(candidates.map((entry) => path.resolve(entry)))]) {
    try {
      const content = await fs.readFile(logPath, "utf8");
      const matches = secretPatternCount(content);
      scanned.push({ path: logPath, exists: true, prohibitedMatches: matches });
      prohibitedMatches += matches;
    } catch (error) {
      if (error.code === "ENOENT") scanned.push({ path: logPath, exists: false, prohibitedMatches: 0 });
      else throw error;
    }
  }
  if (prohibitedMatches) {
    throw new Error(`Launcher log privacy scan found ${prohibitedMatches} prohibited secret-pattern match(es); values were intentionally not printed.`);
  }
  return scanned;
}

async function run(file, commandArgs, { cwd = packageRoot, timeoutMs = 180000 } = {}) {
  const child = spawn(file, commandArgs, { cwd, shell: false, stdio: "inherit", windowsHide: true });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(file)} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode ?? 1);
    });
  });
  if (code !== 0) throw new Error(`${path.basename(file)} ${commandArgs.join(" ")} failed with exit code ${code}.`);
}

const requiredFiles = [
  "MagicBox.exe",
  "node.exe",
  "server/index.mjs",
  "server/routes/voice-clone-routes.mjs",
  "server/voice_engine_worker_openvoice.py",
  "server/voice_engine_worker_gpt_sovits.py",
  "server/voice_engine_worker_preparation.py",
  "scripts/install-voice-preparation.ps1",
  "scripts/verify-voice-clone-package.mjs",
  "voice_clone/voice_engine/runtime/openvoice_worker.py",
  "voice_clone/voice_engine/gpt-sovits/runtime/gpt_sovits_worker.py",
  "voice_clone/voice_engine/preparation/runtime/voice_preparation_worker.py",
  "voice_clone/voice_engine/quality-evaluators/eres2netv2/pretrained_eres2netv2.ckpt",
  "voice_clone/voice_engine/quality-evaluators/nisqa/weights/nisqa.tar",
  "voice_clone/voice_engine/quality-evaluators/utmosv2-cache/models/fusion_stage3/fold0_s42_best_model.pth",
  "dist/.vite/manifest.json",
  "scripts/verify-lazy-tool-pages.mjs",
  "scripts/package-voice-ingress-smoke.mjs",
  "scripts/verify-hardening-package.mjs"
];
for (const required of requiredFiles) await requireFile(required);
for (const required of ["voice_clone/voice_engine/quality-evaluators/hf-cache/hub/models--facebook--wav2vec2-base"]) {
  const info = await fs.stat(path.join(packageRoot, required));
  if (!info.isDirectory()) throw new Error(`Required packaged evaluator directory is not a directory: ${required}`);
}

const artifactHashes = [];
for (const relativePath of pairedArtifacts) {
  const sourcePath = path.join(sourceRoot, relativePath);
  const packagePath = path.join(packageRoot, relativePath);
  const [sourceHash, packageHash] = await Promise.all([sha256(sourcePath), sha256(packagePath)]);
  if (sourceHash !== packageHash) throw new Error(`Source/package artifact mismatch: ${relativePath}`);
  artifactHashes.push({ path: relativePath, sha256: sourceHash });
}
const managedWorkerPairs = [
  ["server/voice_engine_worker_openvoice.py", "voice_clone/voice_engine/runtime/openvoice_worker.py"],
  ["server/voice_engine_worker_gpt_sovits.py", "voice_clone/voice_engine/gpt-sovits/runtime/gpt_sovits_worker.py"],
  ["server/voice_engine_worker_preparation.py", "voice_clone/voice_engine/preparation/runtime/voice_preparation_worker.py"]
];
for (const [sourceRelativePath, packageRelativePath] of managedWorkerPairs) {
  const [sourceHash, packageHash] = await Promise.all([
    sha256(path.join(sourceRoot, sourceRelativePath)),
    sha256(path.join(packageRoot, packageRelativePath))
  ]);
  if (sourceHash !== packageHash) throw new Error(`Source/package managed worker mismatch: ${sourceRelativePath} -> ${packageRelativePath}`);
  artifactHashes.push({ path: `${sourceRelativePath} -> ${packageRelativePath}`, sha256: sourceHash });
}

const [sourceIp, packageIp] = await Promise.all([
  collectIpVersions(path.join(sourceRoot, "node_modules")),
  collectIpVersions(path.join(packageRoot, "node_modules"))
]);
const vulnerableSource = sourceIp.filter((entry) => entry.version === "2.0.1");
const vulnerablePackage = packageIp.filter((entry) => entry.version === "2.0.1");
if (vulnerableSource.length || vulnerablePackage.length) {
  throw new Error(`Vulnerable ip@2.0.1 found (source=${vulnerableSource.length}, package=${vulnerablePackage.length}).`);
}

const executable = await requireFile("MagicBox.exe");
const packageManifest = JSON.parse(await fs.readFile(path.join(packageRoot, "assistant-package-manifest.json"), "utf8"));
if (!packageManifest.files?.some((entry) => entry.relativePath === "MagicBox.exe" && entry.sha256)) {
  throw new Error("Package manifest does not attest MagicBox.exe.");
}

const packageNode = path.join(packageRoot, "node.exe");
if (hasFlag("--verify-lazy-pages")) {
  await run(packageNode, [
    path.join(packageRoot, "scripts", "verify-lazy-tool-pages.mjs"),
    "--manifest", path.join(packageRoot, "dist", ".vite", "manifest.json"),
    "--entry-budget", "300000"
  ]);
}
if (hasFlag("--voice-ingress")) {
  await run(packageNode, [path.join(packageRoot, "scripts", "package-voice-ingress-smoke.mjs"), "--package", packageRoot]);
}
if (hasFlag("--launch-smoke")) {
  await run(path.join(packageRoot, "MagicBox.exe"), ["--diagnostic-smoke"]);
}

const scannedLogPaths = await scanLauncherLogs();
console.log(JSON.stringify({
  verified: true,
  packageRoot,
  packageBuildId: packageManifest.buildId,
  magicBoxExe: { bytes: executable.info.size, modifiedAt: executable.info.mtime.toISOString() },
  matchedArtifactCount: artifactHashes.length,
  artifactHashes,
  ipPackages: { sourceCount: sourceIp.length, packageCount: packageIp.length },
  scannedLogPaths
}, null, 2));
