import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function cookieFileError(message) {
  return Object.assign(new Error(message), { code: "INVALID_VIDEO_COOKIES_FILE" });
}

export async function validateVideoCookiesFile(value) {
  if (value == null || value === "") return null;
  const filename = String(value).trim().replace(/^"(.*)"$/, "$1");
  if (!path.isAbsolute(filename) || filename.length > 2048 || /[\r\n\0]/.test(filename) || /^\\\\/.test(filename)) {
    throw cookieFileError("Enter the full path to a local Netscape cookies.txt file.");
  }
  let handle;
  try {
    handle = await fs.open(filename, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) {
      throw cookieFileError("Choose a Netscape cookies.txt file smaller than 10 MB.");
    }
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!/^# (?:Netscape )?HTTP Cookie File(?:\r?\n|$)/.test(buffer.subarray(0, bytesRead).toString("utf8"))) {
      throw cookieFileError("The login file must use Netscape cookies.txt format. Export fresh cookies for the video site and scan again.");
    }
    return path.resolve(filename);
  } catch (error) {
    if (error.code === "INVALID_VIDEO_COOKIES_FILE") throw error;
    throw cookieFileError("The cookies.txt file could not be read. Check the local path and permissions, then scan again.");
  } finally {
    await handle?.close();
  }
}

// yt-dlp saves its cookie jar on exit. Give each invocation its own copy so a
// scan/download never overwrites the user's export or shares a mutable jar.
export async function prepareVideoCookieArgs(args) {
  const index = args.indexOf("--cookies");
  if (index < 0) return { args, cleanup: async () => {} };
  const source = await validateVideoCookiesFile(args[index + 1]);
  if (!source) throw cookieFileError("Choose a cookies.txt file before using file login.");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-video-cookies-"));
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try {
    const target = path.join(directory, "cookies.txt");
    await fs.copyFile(source, target);
    await fs.chmod(target, 0o600);
    const copiedArgs = [...args];
    copiedArgs[index + 1] = target;
    return { args: copiedArgs, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function createVideoAuthenticationRegistry({ now = Date.now, ttlMs = 12 * 60 * 60 * 1000, maxEntries = 100 } = {}) {
  const sessions = new Map();
  return {
    bind(videos, cookiesFile) {
      if (!cookiesFile) return videos;
      for (const [key, session] of sessions) {
        if (session.expiresAt <= now()) sessions.delete(key);
      }
      while (sessions.size >= maxEntries) sessions.delete(sessions.keys().next().value);
      const authSessionId = randomUUID();
      sessions.set(authSessionId, { cookiesFile, expiresAt: now() + ttlMs });
      const sanitize = (video) => {
        const { cookiesFile: _privatePath, variants, ...rest } = video;
        return {
          ...rest,
          authSessionId,
          ...(Array.isArray(variants) ? { variants: variants.map(sanitize) } : {})
        };
      };
      return videos.map(sanitize);
    },
    resolve(authSessionId) {
      if (!authSessionId) return null;
      const session = sessions.get(authSessionId);
      if (!session || session.expiresAt <= now()) {
        sessions.delete(authSessionId);
        throw Object.assign(new Error("Video login has expired. Enable site login and scan the video again before downloading."), { code: "VIDEO_LOGIN_EXPIRED" });
      }
      return session.cookiesFile;
    }
  };
}
