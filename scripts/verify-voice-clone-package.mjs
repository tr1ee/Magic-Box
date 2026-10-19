import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const hasFlag = (name) => args.includes(name);
const packageRoot = path.resolve(value("--package") || "release/chromium/MagicBox");
// Desktop installations may keep large managed runtimes beside user data.
// Require an explicit root; a missing bundled runtime must not silently pass.
const voiceDataRoot = path.resolve(value("--voice-data-root") || path.join(packageRoot, "voice_clone"));
const preparationPython = path.join(voiceDataRoot, "voice_engine", "preparation", "runtime", "python", "python.exe");
const sourceRoot = process.cwd();
const requiredFiles = [
  "MagicBox.exe",
  "node.exe",
  "server/index.mjs",
  "server/routes/voice-clone-routes.mjs",
  "server/voice_engine_worker_openvoice.py",
  "server/voice_engine_worker_gpt_sovits.py",
  "server/voice_engine_worker_preparation.py",
  "server/voice_engine_worker_seed_vc.py",
  "server/voice_engine_worker_fake.mjs",
  "scripts/install-voice-preparation.ps1",
  "scripts/verify-voice-clone-package.mjs",
  "voice_clone/voice_engine/runtime/openvoice_worker.py",
  "voice_clone/voice_engine/gpt-sovits/runtime/gpt_sovits_worker.py",
  "voice_clone/voice_engine/preparation/runtime/voice_preparation_worker.py",
  "voice_clone/voice_engine/seed-vc/runtime/seed_vc_worker.py",
  "dist/.vite/manifest.json"
];

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function requireFile(relativePath) {
  const filePath = path.join(packageRoot, relativePath);
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error(`Required Voice Clone package artifact is not a regular file: ${relativePath}`);
  return { filePath, stats };
}

async function assertFrontendPackageParity() {
  const manifestRelativePath = path.join("dist", ".vite", "manifest.json");
  const [sourceText, packageText] = await Promise.all([
    fs.readFile(path.join(sourceRoot, manifestRelativePath), "utf8"),
    fs.readFile(path.join(packageRoot, manifestRelativePath), "utf8")
  ]);
  const sourceManifest = JSON.parse(sourceText);
  const packageManifest = JSON.parse(packageText);
  assert.deepEqual(packageManifest, sourceManifest, "Packaged Vite manifest differs from the current source build.");
  const assets = new Set();
  for (const entry of Object.values(sourceManifest)) {
    if (!entry || typeof entry !== "object") continue;
    for (const asset of [entry.file, ...(entry.css || []), ...(entry.assets || [])]) {
      if (typeof asset !== "string" || !asset || path.isAbsolute(asset) || asset.includes("..")) {
        throw new Error("Vite manifest contains an unsafe frontend asset path.");
      }
      assets.add(asset);
    }
  }
  for (const asset of assets) {
    const [sourceHash, packageHash] = await Promise.all([
      sha256(path.join(sourceRoot, "dist", asset)),
      sha256(path.join(packageRoot, "dist", asset))
    ]);
    if (sourceHash !== packageHash) throw new Error(`Source/package frontend asset mismatch: dist/${asset}`);
  }
  return assets.size;
}

async function run(file, commandArgs, { cwd = packageRoot, timeoutMs = 180000 } = {}) {
  const child = spawn(file, commandArgs, { cwd, shell: false, windowsHide: true, stdio: "inherit" });
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

async function preparationDependencyVersions() {
  const python = preparationPython;
  const script = "import importlib.metadata,json;print(json.dumps({'pypinyin':importlib.metadata.version('pypinyin'),'cn2an':importlib.metadata.version('cn2an')}))";
  const child = spawn(python, ["-c", script], { cwd: packageRoot, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`Packaged Voice Preparation dependency probe failed: ${stderr.trim()}`);
  const versions = JSON.parse(stdout.trim());
  const numericVersion = (value) => String(value).split(".").slice(0, 3).map((part) => Number(part) || 0);
  const atLeast = (value, required) => numericVersion(value).reduce((result, part, index) => result || Math.sign(part - required[index]), 0) >= 0;
  assert.ok(atLeast(versions.pypinyin, [0, 50, 0]), `Packaged pypinyin ${versions.pypinyin} is below 0.50.0.`);
  assert.ok(atLeast(versions.cn2an, [0, 5, 22]), `Packaged cn2an ${versions.cn2an} is below 0.5.22.`);
  return versions;
}

function wavFixture(durationSeconds = 4, rawAudioCanary = "") {
  const sampleRate = 24000;
  const frameCount = Math.max(sampleRate, Math.round(sampleRate * durationSeconds));
  const rawAudioTrailer = Buffer.from(rawAudioCanary, "utf8");
  const buffer = Buffer.alloc(44 + frameCount * 2 + rawAudioTrailer.length);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + frameCount * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(frameCount * 2, 40);
  for (let index = 0; index < frameCount; index += 1) {
    const value = Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * 220) * 0.24 * 32767);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  rawAudioTrailer.copy(buffer, 44 + frameCount * 2);
  return buffer;
}

async function waitForJob(baseUrl, job) {
  let current = job;
  for (let attempt = 0; attempt < 120 && !["completed", "failed", "cancelled"].includes(current.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const response = await fetch(`${baseUrl}/api/voice-clone/jobs/${encodeURIComponent(job.id)}`);
    assert.equal(response.status, 200);
    current = await response.json();
  }
  return current;
}

async function fixturePreparationSmoke() {
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "magic-box-voice-preparation-package-"));
  const previousSettings = process.env.MAGIC_BOX_SETTINGS_FILE;
  const previousFakeEngine = process.env.MAGIC_BOX_VOICE_ENGINE_FAKE;
  const transcriptCanary = "VOICE_TRANSCRIPT_PRIVATE_CANARY";
  const rawAudioCanary = "VOICE_RAW_AUDIO_PRIVATE_CANARY";
  const capturedDiagnostics = [];
  const originalConsole = Object.fromEntries(["log", "warn", "error"].map((method) => [method, console[method]]));
  let context;
  try {
    for (const method of Object.keys(originalConsole)) {
      console[method] = (...values) => {
        capturedDiagnostics.push(values.map((value) => String(value)).join(" "));
      };
    }
    process.env.MAGIC_BOX_SETTINGS_FILE = path.join(smokeRoot, "settings.json");
    process.env.MAGIC_BOX_VOICE_ENGINE_FAKE = "1";
    const { startServer } = await import(pathToFileURL(path.join(packageRoot, "server", "index.mjs")).href);
    context = await startServer({
      port: 0,
      dht: false,
      lsd: false,
      tracker: false,
      defaultDownloadDir: path.join(smokeRoot, "downloads"),
      assistantDataDir: path.join(smokeRoot, "assistant")
    });
    const profileResponse = await fetch(`${context.url}/api/voice-clone/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Package preparation fixture", language: "en", consentConfirmed: true })
    });
    assert.equal(profileResponse.status, 201);
    const profile = await profileResponse.json();
    const form = new FormData();
    form.append("metadataJson", JSON.stringify([{ transcript: transcriptCanary, transcriptLanguage: "en" }]));
    form.append("files", new Blob([wavFixture(4, rawAudioCanary)], { type: "audio/wav" }), "fixture.wav");
    const uploadResponse = await fetch(`${context.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, {
      method: "POST",
      body: form
    });
    assert.equal(uploadResponse.status, 202);
    const upload = await uploadResponse.json();
    assert.equal(upload.job?.type, "prepare-profile-source");
    const preparationJob = await waitForJob(context.url, upload.job);
    assert.equal(preparationJob.status, "completed", preparationJob.error || "Voice Preparation fixture job failed.");
    const jobDiagnostics = JSON.stringify({ uploadJob: upload.job, preparationJob });
    const diagnosticText = capturedDiagnostics.join("\n");
    assert.doesNotMatch(jobDiagnostics, new RegExp(transcriptCanary));
    assert.doesNotMatch(jobDiagnostics, new RegExp(rawAudioCanary));
    assert.doesNotMatch(diagnosticText, new RegExp(transcriptCanary));
    assert.doesNotMatch(diagnosticText, new RegExp(rawAudioCanary));
    const profilesResponse = await fetch(`${context.url}/api/voice-clone/profiles`);
    assert.equal(profilesResponse.status, 200);
    const preparedProfile = (await profilesResponse.json()).find((entry) => entry.id === profile.id);
    const sample = preparedProfile?.samples?.[0];
    assert.equal(sample?.preparation?.status, "ready");
    assert.ok(sample.preparation.vocalPath && sample.preparation.vocalPath !== sample.storedPath);
    assert.ok(sample.segments?.some((segment) => segment.qualityVerdict === "eligible" && segment.audioPath && segment.audioPath !== sample.storedPath));
    const vocalResponse = await fetch(`${context.url}${sample.preparation.vocalAudioUrl}`);
    assert.equal(vocalResponse.status, 200);
    const eligibleSegment = sample.segments.find((segment) => segment.qualityVerdict === "eligible");
    const clipResponse = await fetch(`${context.url}${eligibleSegment.audioUrl}`);
    assert.equal(clipResponse.status, 200);
    const buildResponse = await fetch(`${context.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: "gpt-sovits-local", qualityMode: "quick" })
    });
    assert.equal(buildResponse.status, 202);
    const built = await waitForJob(context.url, await buildResponse.json());
    assert.equal(built.status, "completed", built.error || "Prepared GPT-SoVITS fixture build failed.");
    const ttsResponse = await fetch(`${context.url}/api/voice-clone/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: profile.id,
        text: "Every requested sentence must stay present. A second requested sentence must also stay present.",
        language: "en",
        settings: { integrityFixture: "clause-2-retry-once" }
      })
    });
    assert.equal(ttsResponse.status, 202);
    const tts = await waitForJob(context.url, await ttsResponse.json());
    assert.equal(tts.status, "completed", tts.error || "Synthesis integrity fixture failed.");
    const integrity = tts.result?.output?.settings?.synthesisIntegrity;
    assert.equal(integrity?.clauses?.length, 2);
    assert.deepEqual(integrity.clauses[1].attempts.map((item) => item.accepted), [false, true]);
    return {
      preparationStatus: sample.preparation.status,
      eligibleClipCount: sample.segments.filter((segment) => segment.qualityVerdict === "eligible").length,
      integrityCoverage: Number(tts.result?.output?.settings?.synthesisIntegrity?.coverage) || 0,
      diagnosticsContainRawContent: false
    };
  } finally {
    await context?.close();
    await fs.rm(smokeRoot, { recursive: true, force: true });
    for (const [method, original] of Object.entries(originalConsole)) {
      console[method] = original;
    }
    if (previousSettings === undefined) delete process.env.MAGIC_BOX_SETTINGS_FILE;
    else process.env.MAGIC_BOX_SETTINGS_FILE = previousSettings;
    if (previousFakeEngine === undefined) delete process.env.MAGIC_BOX_VOICE_ENGINE_FAKE;
    else process.env.MAGIC_BOX_VOICE_ENGINE_FAKE = previousFakeEngine;
  }
}

for (const relativePath of requiredFiles) await requireFile(relativePath);
assert.ok((await fs.stat(preparationPython)).isFile(), "Voice Preparation Python must be a real installed file.");
const pairedArtifacts = [
  "server/index.mjs",
  "server/routes/voice-clone-routes.mjs",
  "server/voice_engine_worker_openvoice.py",
  "server/voice_engine_worker_gpt_sovits.py",
  "server/voice_engine_worker_preparation.py",
  "server/voice_engine_worker_seed_vc.py",
  "server/voice_engine_worker_fake.mjs",
  "scripts/install-voice-preparation.ps1",
  "scripts/verify-voice-clone-package.mjs",
  "shared/voiceClone.mjs"
];
for (const relativePath of pairedArtifacts) {
  const [sourceHash, packageHash] = await Promise.all([
    sha256(path.join(sourceRoot, relativePath)),
    sha256(path.join(packageRoot, relativePath))
  ]);
  if (sourceHash !== packageHash) throw new Error(`Source/package Voice Clone artifact mismatch: ${relativePath}`);
}
const managedWorkerPairs = [
  ["server/voice_engine_worker_openvoice.py", "voice_clone/voice_engine/runtime/openvoice_worker.py"],
  ["server/voice_engine_worker_gpt_sovits.py", "voice_clone/voice_engine/gpt-sovits/runtime/gpt_sovits_worker.py"],
  ["server/voice_engine_worker_preparation.py", "voice_clone/voice_engine/preparation/runtime/voice_preparation_worker.py"],
  ["server/voice_engine_worker_seed_vc.py", "voice_clone/voice_engine/seed-vc/runtime/seed_vc_worker.py"]
];
for (const [sourceRelativePath, packageRelativePath] of managedWorkerPairs) {
  const [sourceHash, packageHash] = await Promise.all([
    sha256(path.join(sourceRoot, sourceRelativePath)),
    sha256(path.join(packageRoot, packageRelativePath))
  ]);
  if (sourceHash !== packageHash) throw new Error(`Source/package managed worker mismatch: ${sourceRelativePath} -> ${packageRelativePath}`);
}
const frontendAssetCount = await assertFrontendPackageParity();
const preparationDependencies = await preparationDependencyVersions();

if (hasFlag("--launch-smoke")) {
  await run(path.join(packageRoot, "MagicBox.exe"), ["--diagnostic-smoke"]);
}
const fixturePreparation = hasFlag("--fixture-preparation") ? await fixturePreparationSmoke() : null;
console.log(JSON.stringify({ verified: true, packageRoot, voiceDataRoot, preparationPython, frontendAssetCount, preparationDependencies, fixturePreparation }, null, 2));
