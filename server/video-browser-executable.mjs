import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Scanning and manual verification must discover the same installed browsers.
// Launch the executable inside a macOS bundle directly so CDP arguments and the
// dedicated MagicBox profile reach a new browser process.
export async function findVideoBrowserExecutable(executablePath, {
  platform = process.platform, env = process.env, homeDir = os.homedir(),
  appRoot = root, allowBundledRuntime = false
} = {}) {
  const candidates = executablePath ? [executablePath] : [];
  if (!executablePath && platform === "darwin") {
    for (const directory of ["/Applications", path.join(homeDir, "Applications")]) {
      for (const [bundle, executable] of [
        ["Google Chrome", "Google Chrome"],
        ["Microsoft Edge", "Microsoft Edge"],
        ["Chromium", "Chromium"]
      ]) candidates.push(path.join(directory, `${bundle}.app`, "Contents", "MacOS", executable));
    }
  }
  if (!executablePath && platform === "win32") {
    for (const directory of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.win32.join(directory, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.win32.join(directory, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
    // Preserve the portable Windows scanner's bundled runtime fallback.
    if (allowBundledRuntime) {
      const fixedRoot = path.join(appRoot, "vendor", "webview2-fixed");
      for (const version of await fs.readdir(fixedRoot).catch(() => [])) {
        const versionRoot = path.join(fixedRoot, version);
        for (const runtime of await fs.readdir(versionRoot).catch(() => [])) {
          candidates.push(path.join(versionRoot, runtime, "msedgewebview2.exe"));
        }
      }
    }
  }
  for (const candidate of candidates) {
    if (await fs.stat(candidate).then(stat => stat.isFile()).catch(() => false)) return candidate;
  }
  throw Object.assign(new Error(executablePath
    ? "The selected video browser could not be found."
    : "Install Chrome or Edge to open a video verification window and scan dynamic video pages."), {
    code: "VIDEO_BROWSER_UNAVAILABLE"
  });
}
