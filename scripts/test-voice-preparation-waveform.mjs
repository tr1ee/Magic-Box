import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixturePath = fileURLToPath(new URL("../test/voice_preparation_waveform_test.py", import.meta.url));
const requestedPython = process.env.MAGIC_BOX_VOICE_PREPARATION_TEST_PYTHON;
const candidates = [requestedPython, process.env.PYTHON, "python", "python3"].filter(Boolean);
let selectedPython = "";

for (const candidate of candidates) {
  try {
    await execFileAsync(candidate, ["-c", "import numpy"], { windowsHide: true });
    selectedPython = candidate;
    break;
  } catch {
    // The production Voice Preparation runtime installs NumPy. Keep this
    // dedicated worker-level test explicit when a developer has not installed
    // that local runtime yet.
  }
}

if (!selectedPython) {
  throw new Error("Voice Preparation waveform test needs a Python runtime with NumPy. Set MAGIC_BOX_VOICE_PREPARATION_TEST_PYTHON to the installed runtime.");
}

const { stdout, stderr } = await execFileAsync(selectedPython, [fixturePath], {
  windowsHide: true,
  maxBuffer: 2 * 1024 * 1024
});
if (stdout.trim()) process.stdout.write(`${stdout.trim()}\n`);
if (stderr.trim()) process.stderr.write(`${stderr.trim()}\n`);
