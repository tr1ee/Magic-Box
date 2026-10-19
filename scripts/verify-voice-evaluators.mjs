import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const dataRoot = path.join(rootDir, "MagicBoxData", "voice_clone", "voice_engine");
const python = path.join(dataRoot, "seed-vc", "runtime", "python", "python.exe");
const repoDir = path.join(dataRoot, "seed-vc", "runtime", "seed-vc");
const qualityRoot = path.join(dataRoot, "quality-evaluators");
const examples = path.join(qualityRoot, "eres2netv2", "examples");

async function requireFile(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing evaluator fixture or runtime file: ${filePath}`);
  }
}

function runWorker(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(rootDir, "server", "voice_engine_worker_seed_vc.py")], {
      cwd: rootDir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        MAGIC_BOX_VOICE_QUALITY_EVALUATOR_DIR: qualityRoot
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const line = lines.at(-1);
      if (!line) {
        reject(new Error(stderr.trim() || `Evaluator worker exited with code ${code}.`));
        return;
      }
      try {
        const response = JSON.parse(line);
        if (!response.ok) {
          reject(new Error(response.error || stderr.trim() || "Evaluator worker failed."));
          return;
        }
        resolve(response.result || {});
      } catch (error) {
        reject(new Error(`Evaluator worker returned invalid JSON: ${error.message}`));
      }
    });
    child.stdin.end(`${JSON.stringify({
      ...request,
      repoDir,
      qualityEvaluatorDir: qualityRoot
    })}\n`);
  });
}

const referenceA = path.join(examples, "speaker1_a_cn_16k.wav");
const referenceB = path.join(examples, "speaker1_b_cn_16k.wav");
const differentSpeaker = path.join(examples, "speaker2_a_cn_16k.wav");
await Promise.all([python, referenceA, referenceB, differentSpeaker].map(requireFile));

const quality = await runWorker({
  id: "quality-evaluator-regression",
  action: "evaluate-quality-batch",
  targetReferenceAudioPaths: [referenceA, referenceB],
  candidates: [
    { id: "same-speaker", audioPath: referenceA },
    { id: "different-speaker", audioPath: differentSpeaker }
  ]
});
const results = new Map((quality.results || []).map((item) => [item.id, item]));
const same = results.get("same-speaker");
const different = results.get("different-speaker");
if (!quality.available || !same || !different) throw new Error("Quality evaluator did not return both candidates.");
if (!(same.encoderB?.score > different.encoderB?.score)) throw new Error("ERes2NetV2 did not separate same and different speakers.");
if (!same.perceptual?.dnsMos || !same.perceptual?.nisqa || !Number.isFinite(Number(same.perceptual?.utmos))) {
  throw new Error("DNSMOS, NISQA, and UTMOSv2 metrics were not all available.");
}

const calibration = await runWorker({
  id: "identity-calibration-regression",
  action: "calibrate-speaker-identity",
  targetReferenceAudioPaths: [referenceA, referenceB]
});
if (calibration.encoderA?.referenceCount !== 2 || calibration.encoderB?.referenceCount !== 2) {
  throw new Error("Speaker identity calibration did not return both reference distributions.");
}

console.log(JSON.stringify({
  ok: true,
  device: quality.device,
  perceptualProvider: quality.perceptualProvider,
  evaluatorVersions: quality.evaluatorVersions,
  sameSpeaker: same.encoderB.score,
  differentSpeaker: different.encoderB.score,
  dnsMos: same.perceptual.dnsMos,
  nisqa: same.perceptual.nisqa,
  utmos: same.perceptual.utmos,
  calibrationReferenceCount: calibration.encoderA.referenceCount
}, null, 2));
