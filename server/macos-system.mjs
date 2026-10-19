import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export async function chooseMacFolder(currentPath = "", execute = run) {
  // Pass the path as data. Never interpolate it into AppleScript source.
  const script = `on run argv
    try
      if (count of argv) > 0 and item 1 of argv is not "" then
        try
          set initialFolder to POSIX file (item 1 of argv) as alias
          return POSIX path of (choose folder with prompt "Choose save folder" default location initialFolder)
        on error number -128
          return ""
        on error
          return POSIX path of (choose folder with prompt "Choose save folder")
        end try
      end if
      return POSIX path of (choose folder with prompt "Choose save folder")
    on error number -128
      return ""
    end try
  end run`;
  const { stdout } = await execute("/usr/bin/osascript", ["-e", script, "--", String(currentPath || "")], { encoding: "utf8" });
  return stdout.trim();
}

export function voiceInstallPlatformError(platform = process.platform, fake = process.env.MAGIC_BOX_VOICE_ENGINE_FAKE === "1") {
  return platform === "darwin" && !fake
    ? "macOS 基础版未包含语音模型，语音克隆/训练自动安装器目前仅支持 Windows。Mac 上的本地 AI 助手模型可在 Private Assistant → Models 查看大小和许可后按需下载。"
    : null;
}
