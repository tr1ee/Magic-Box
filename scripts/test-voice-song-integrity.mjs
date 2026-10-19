import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixturePath = fileURLToPath(new URL("../test/voice_song_integrity_test.py", import.meta.url));
const packagedSeedPython = fileURLToPath(new URL("../release/chromium/MagicBox/voice_clone/voice_engine/seed-vc/runtime/python/python.exe", import.meta.url));
const localSeedPython = fileURLToPath(new URL("../voice_clone/voice_engine/seed-vc/runtime/python/python.exe", import.meta.url));
const requestedPython = process.env.MAGIC_BOX_VOICE_SONG_TEST_PYTHON;
const candidates = [requestedPython, packagedSeedPython, localSeedPython, process.env.PYTHON, "python", "python3"].filter(Boolean);
let selectedPython = "";

for (const candidate of candidates) {
  try {
    await execFileAsync(candidate, ["-c", "import numpy"], { windowsHide: true });
    selectedPython = candidate;
    break;
  } catch {
    // The managed Seed-VC runtime includes NumPy; developers may override its path explicitly.
  }
}

if (!selectedPython) {
  throw new Error("Song integrity tests need a Python runtime with NumPy. Set MAGIC_BOX_VOICE_SONG_TEST_PYTHON to the installed runtime.");
}

const { stdout, stderr } = await execFileAsync(selectedPython, [fixturePath], {
  windowsHide: true,
  maxBuffer: 2 * 1024 * 1024
});
if (stdout.trim()) process.stdout.write(`${stdout.trim()}\n`);
if (stderr.trim()) process.stderr.write(`${stderr.trim()}\n`);
