import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export const VTV_BASELINE_SCHEMA = "vtv-baseline-manifest-v1";
export const VTV_BASELINE_SEED_VC_COMMIT = "51383efd921027683c89e5348211d93ff12ac2a8";

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".m4a", ".ogg"]);
const MODEL_EXTENSIONS = new Set([".bin", ".ckpt", ".onnx", ".pt", ".pth", ".safetensors", ".yaml", ".yml", ".json"]);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function walkFiles(root, { maxFiles = 5000, extensions = null } = {}) {
  if (!(await exists(root))) return [];
  const output = [];
  async function visit(directory) {
    if (output.length >= maxFiles) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (output.length >= maxFiles) break;
      if (entry.name === "__pycache__" || entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (!extensions || extensions.has(path.extname(entry.name).toLowerCase())) {
        output.push(absolute);
      }
    }
  }
  await visit(root);
  return output;
}

async function resolveDeclaredBaselineCase(filePath) {
  if (await exists(filePath)) return filePath;
  const searchRoot = path.dirname(filePath);
  const matches = (await walkFiles(searchRoot, { extensions: AUDIO_EXTENSIONS, maxFiles: 5000 }))
    .filter((candidate) => path.basename(candidate).toLowerCase() === path.basename(filePath).toLowerCase())
    .sort((left, right) => left.localeCompare(right));
  return matches[0] || filePath;
}

async function readJson(filePath) {
  if (!(await exists(filePath))) return null;
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function gitValue(repoRoot, args) {
  try {
    const normalizedRepoRoot = path.resolve(repoRoot).replaceAll("\\", "/");
    const result = await execFileAsync("git", ["-c", `safe.directory=${normalizedRepoRoot}`, ...args], { cwd: repoRoot, windowsHide: true });
    return String(result.stdout || "").trim();
  } catch {
    return "";
  }
}

async function toolVersion(command, args = ["-version"]) {
  try {
    const result = await execFileAsync(command, args, { windowsHide: true, maxBuffer: 1024 * 1024 });
    return String(`${result.stdout || ""}${result.stderr || ""}`).split(/\r?\n/u).find(Boolean)?.trim() || "";
  } catch {
    return "";
  }
}

async function pythonDependencyEvidence(pythonPath) {
  if (!(await exists(pythonPath))) return { path: "", version: "", lockSha256: "", packageCount: 0 };
  try {
    const versionResult = await execFileAsync(pythonPath, ["--version"], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const freezeResult = await execFileAsync(pythonPath, ["-m", "pip", "freeze"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const lockText = String(freezeResult.stdout || "").replaceAll("\r\n", "\n").trim();
    return {
      path: pythonPath,
      version: String(`${versionResult.stdout || ""}${versionResult.stderr || ""}`).trim(),
      lockSha256: crypto.createHash("sha256").update(lockText, "utf8").digest("hex"),
      packageCount: lockText ? lockText.split("\n").length : 0
    };
  } catch {
    return { path: pythonPath, version: "", lockSha256: "", packageCount: 0 };
  }
}

async function resolveFfmpegPath(repoRoot) {
  const candidates = [
    path.join(repoRoot, "node_modules", "ffmpeg-static", "ffmpeg.exe"),
    path.join(repoRoot, "node_modules", "ffmpeg-static", "ffmpeg"),
    path.join(repoRoot, "vendor", "ffmpeg", "bin", "ffmpeg.exe"),
    path.join(repoRoot, "vendor", "ffmpeg", "bin", "ffmpeg")
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return "";
}

async function resolveFfprobePath(repoRoot) {
  const candidates = [
    path.join(repoRoot, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe"),
    path.join(repoRoot, "vendor", "ffmpeg", "bin", "ffprobe.exe"),
    path.join(repoRoot, "node_modules", "ffprobe-static", "bin", "darwin", "x64", "ffprobe")
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return "";
}

async function hashRecords(files, repoRoot, limit = 200) {
  const records = [];
  for (const filePath of files.slice(0, limit)) {
    records.push({
      path: path.relative(repoRoot, filePath).replaceAll(path.sep, "/"),
      sha256: await sha256File(filePath),
      bytes: (await fs.stat(filePath)).size
    });
  }
  return records;
}

export async function buildVtvBaselineManifest({ repoRoot, outputPath = "", maxAudioCases = 20 } = {}) {
  const root = path.resolve(repoRoot || process.cwd());
  const packagePath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const seedEngineRoot = path.join(root, "MagicBoxData", "voice_clone", "voice_engine", "seed-vc");
  const seedInstallStatePath = path.join(seedEngineRoot, "install_state.json");
  const seedInstallState = await readJson(seedInstallStatePath);
  const seedRepoDir = path.join(seedEngineRoot, "runtime", "seed-vc");
  const pythonPath = path.join(seedEngineRoot, "runtime", "python", "python.exe");
  const modelRoot = path.join(seedEngineRoot, "models", "seed-vc-svc-v1");
  const ffmpegPath = await resolveFfmpegPath(root);
  const ffprobePath = await resolveFfprobePath(root);
  const modelRoots = [
    modelRoot,
    path.join(seedRepoDir, "checkpoints", "magicbox_models"),
    path.join(seedRepoDir, "checkpoints", "models--Plachta--Seed-VC"),
    path.join(seedRepoDir, "checkpoints", "models--funasr--campplus")
  ];
  const modelFiles = [];
  for (const modelPath of modelRoots) {
    modelFiles.push(...await walkFiles(modelPath, { extensions: MODEL_EXTENSIONS, maxFiles: 400 }));
  }
  const uniqueModelFiles = [...new Map(modelFiles.map((filePath) => [path.resolve(filePath).toLowerCase(), filePath])).values()];
  const artifactAudioFiles = await walkFiles(path.join(root, "artifacts"), { extensions: AUDIO_EXTENSIONS, maxFiles: 100 });
  const declaredExternalCases = [
    "F:/AI Sounds/voice-clone-outputs/voice-output-1787615331754-3dab37-song-v2v-Ameath2.wav",
    "F:/AI Sounds/voice-clone-outputs/voice-output-1784711929188-9ede00-song-v2v-爱弥斯.wav"
  ];
  const sourceCases = [];
  for (const filePath of artifactAudioFiles.slice(0, maxAudioCases)) {
    sourceCases.push({
      caseId: `artifact-${sourceCases.length + 1}`,
      path: path.relative(root, filePath).replaceAll(path.sep, "/"),
      exists: true,
      sha256: await sha256File(filePath),
      bytes: (await fs.stat(filePath)).size,
      source: "workspace-artifact"
    });
  }
  for (const filePath of declaredExternalCases) {
    const resolvedPath = await resolveDeclaredBaselineCase(filePath);
    const caseExists = await exists(resolvedPath);
    sourceCases.push({
      caseId: `declared-external-${sourceCases.length + 1}`,
      path: caseExists ? resolvedPath : filePath,
      declaredPath: filePath,
      exists: caseExists,
      sha256: caseExists ? await sha256File(resolvedPath) : "",
      bytes: caseExists ? (await fs.stat(resolvedPath)).size : 0,
      source: "declared-baseline-case"
    });
  }
  const seedRepoCommit = await gitValue(seedRepoDir, ["rev-parse", "HEAD"]);
  const manifest = {
    schemaVersion: VTV_BASELINE_SCHEMA,
    pipelineVersion: "vtv-pipeline-v2",
    capturedAt: new Date().toISOString(),
    repository: {
      root: root.replaceAll("\\", "/"),
      commit: await gitValue(root, ["rev-parse", "HEAD"]),
      status: await gitValue(root, ["status", "--short"])
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ffmpeg: {
        path: ffmpegPath ? path.relative(root, ffmpegPath).replaceAll(path.sep, "/") : "",
        version: ffmpegPath ? await toolVersion(ffmpegPath) : await toolVersion("ffmpeg")
      },
      ffprobe: {
        path: ffprobePath ? path.relative(root, ffprobePath).replaceAll(path.sep, "/") : "",
        version: ffprobePath ? await toolVersion(ffprobePath) : await toolVersion("ffprobe")
      },
      python: await pythonDependencyEvidence(pythonPath),
      packageJsonSha256: await sha256File(packagePath),
      packageLockSha256: await sha256File(lockPath)
    },
    engines: {
      seedVc: {
        expectedCommit: VTV_BASELINE_SEED_VC_COMMIT,
        installedCommit: seedRepoCommit,
        commitPinned: seedRepoCommit === VTV_BASELINE_SEED_VC_COMMIT,
        installState: seedInstallState || null,
        installStateSha256: await exists(seedInstallStatePath) ? sha256File(seedInstallStatePath) : ""
      }
    },
    modelArtifacts: await hashRecords(uniqueModelFiles, root, 800),
    baselineCases: sourceCases,
    evidence: {
      missingDeclaredCases: sourceCases.filter((item) => item.source === "declared-baseline-case" && !item.exists).map((item) => item.declaredPath || item.path),
      reproducible: Boolean(seedRepoCommit && seedRepoCommit === VTV_BASELINE_SEED_VC_COMMIT && ffmpegPath && uniqueModelFiles.length > 0),
      notes: [
        "This manifest records immutable evidence without copying or modifying source audio.",
        "Declared baseline cases are resolved read-only by basename when a historical output directory added an extra nesting level; missing evidence still blocks promotion."
      ]
    }
  };
  if (outputPath) {
    const target = path.resolve(root, outputPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  return manifest;
}

export function validateVtvBaselineManifest(manifest) {
  const errors = [];
  if (!manifest || manifest.schemaVersion !== VTV_BASELINE_SCHEMA) errors.push("schema_version_invalid");
  if (manifest?.pipelineVersion !== "vtv-pipeline-v2") errors.push("pipeline_version_invalid");
  if (!manifest?.runtime?.packageJsonSha256 || !manifest?.runtime?.packageLockSha256) errors.push("package_hash_missing");
  if (manifest?.engines?.seedVc?.commitPinned !== true) errors.push("seed_vc_commit_not_pinned");
  if (!manifest?.runtime?.ffmpeg?.version) errors.push("ffmpeg_version_missing");
  if (!manifest?.runtime?.ffprobe?.version) errors.push("ffprobe_version_missing");
  if (!manifest?.runtime?.python?.lockSha256) errors.push("python_dependency_lock_missing");
  if (!Array.isArray(manifest?.modelArtifacts) || !manifest.modelArtifacts.length) errors.push("model_artifacts_missing");
  if (manifest?.evidence?.missingDeclaredCases?.length) errors.push("declared_baseline_case_missing");
  return { valid: errors.length === 0, errors };
}
