import { execFile as nodeExecFile } from "node:child_process";

const allowedProtocols = new Set(["http:", "https:"]);
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const invalidHeaderValuePattern = /[\u0000-\u0008\u000a-\u001f\u007f]/;

function httpUrl(value) {
  if (typeof value !== "string" || /[\r\n\u0000]/.test(value)) return null;
  try {
    const url = new URL(value);
    return allowedProtocols.has(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function probeHeaders(video) {
  const source = video.httpHeaders ?? {};
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const entries = Object.entries(source);
  if (entries.length > 32) return null;
  const names = new Set();
  const headers = [];
  for (const [name, value] of entries) {
    if (!headerNamePattern.test(name) || typeof value !== "string" || invalidHeaderValuePattern.test(value)) return null;
    const key = name.toLowerCase();
    if (names.has(key)) return null;
    names.add(key);
    headers.push(`${name}: ${value}\r\n`);
  }
  if (!names.has("referer") && (video.referer || video.sourcePage)) {
    const referer = httpUrl(video.referer || video.sourcePage);
    if (!referer) return null;
    headers.push(`Referer: ${referer}\r\n`);
  }
  const result = headers.join("");
  return result.length <= 16384 ? result : null;
}

/** Read dimensions from a small media probe; failure leaves the source quality unknown. */
export async function probeVideoDimensions(video, { ffprobePath, timeoutMs = 8000, signal, execFile = nodeExecFile } = {}) {
  if (!video || typeof video !== "object" || signal?.aborted) return null;
  const url = httpUrl(video.url);
  if (!url || typeof ffprobePath !== "string" || !ffprobePath.trim() || ffprobePath.includes("\0")) return null;
  const headers = probeHeaders(video);
  if (headers === null || typeof execFile !== "function") return null;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(Math.ceil(timeoutMs), 30000) : 8000;
  const args = [
    "-v", "error",
    "-protocol_whitelist", "http,https,tcp,tls,crypto",
    "-rw_timeout", String(Math.min(timeout, 3000) * 1000),
    "-probesize", "1048576",
    "-analyzeduration", "2000000",
    ...(headers ? ["-headers", headers] : []),
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "json",
    "-read_intervals", "%+#1",
    "-i", url
  ];
  const output = await new Promise((resolve) => {
    try {
      execFile(ffprobePath, args, {
        windowsHide: true,
        shell: false,
        timeout,
        maxBuffer: 65536,
        encoding: "utf8",
        ...(signal ? { signal } : {})
      }, (error, stdout) => resolve(error ? null : stdout));
    } catch {
      resolve(null);
    }
  });
  if (!output || signal?.aborted) return null;
  try {
    const stream = JSON.parse(String(output))?.streams?.[0];
    const width = stream?.width;
    const height = stream?.height;
    if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 32768)) return null;
    return {
      qualityHeight: height,
      qualityWidth: width,
      qualityLabel: `${height}p`,
      qualityRank: height,
      qualityExplicit: true,
      qualitySource: "media-probe"
    };
  } catch {
    return null;
  }
}
