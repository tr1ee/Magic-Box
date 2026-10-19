import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const ASSISTANT_FILE_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".pdf", ".docx"]);

export function isoNow(now = Date.now) {
  return new Date(now()).toISOString();
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function jsonParse(value, fallback) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function createId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function normalizePathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInside(parentPath, candidatePath) {
  const parent = normalizePathKey(parentPath);
  const candidate = normalizePathKey(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

export function boundedText(value, maxLength = 512) {
  const text = String(value ?? "").trim();
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function assistantError(code, message, status = 400, retryable = false, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  error.details = details;
  return error;
}

export function sendAssistantError(response, error) {
  const status = Number(error?.status) || 500;
  const code = error?.code || "assistant_internal_error";
  const message = status >= 500 && !error?.code
    ? "The private assistant could not complete this request."
    : boundedText(error?.message || "The request could not be completed.", 512);
  response.status(status).json({
    code,
    message,
    retryable: Boolean(error?.retryable),
    ...(error?.details ? { details: error.details } : {})
  });
}

export async function assertRegularFileNoLinks(filePath) {
  const resolved = path.resolve(filePath);
  const stats = await fs.lstat(resolved);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw assistantError("path_not_allowed", "Only regular files can be added.", 403);
  }
  const canonical = await fs.realpath(resolved);
  const canonicalStats = await fs.stat(canonical);
  if (!canonicalStats.isFile()) {
    throw assistantError("path_not_allowed", "Only regular files can be added.", 403);
  }
  return { canonical, stats: canonicalStats };
}

export async function assertDirectoryNoLinks(directoryPath) {
  const resolved = path.resolve(directoryPath);
  const stats = await fs.lstat(resolved);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw assistantError("path_not_allowed", "Choose a regular local folder.", 403);
  }
  const canonical = await fs.realpath(resolved);
  const canonicalStats = await fs.stat(canonical);
  if (!canonicalStats.isDirectory()) {
    throw assistantError("path_not_allowed", "Choose a regular local folder.", 403);
  }
  return canonical;
}

export async function enumerateSupportedFiles(rootPath, { signal, limit = 10_000 } = {}) {
  const files = [];
  const queue = [rootPath];
  while (queue.length) {
    if (signal?.aborted) throw assistantError("job_cancelled", "The scan was cancelled.", 409);
    const current = queue.shift();
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (signal?.aborted) throw assistantError("job_cancelled", "The scan was cancelled.", 409);
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
        if (files.length > limit) {
          throw assistantError("workspace_scan_limit_exceeded", `A workspace scan is limited to ${limit} regular files.`, 400);
        }
      }
    }
  }
  return files;
}

export function contentTypeForName(name) {
  switch (path.extname(name).toLowerCase()) {
    case ".txt": return "text/plain";
    case ".md":
    case ".markdown": return "text/markdown";
    case ".pdf": return "application/pdf";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default: return "application/octet-stream";
  }
}

export function safeDisplayName(name) {
  const value = path.basename(String(name || "untitled"));
  return boundedText(value.replace(/[\u0000-\u001f]/g, ""), 240) || "untitled";
}

export function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
