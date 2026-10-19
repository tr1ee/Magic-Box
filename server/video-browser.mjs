import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { acquireVerificationProfile } from "./video-verification-browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const childIsRunning = (child) => Boolean(child?.pid && child.exitCode == null && child.signalCode == null);

function waitForChildExit(child, timeoutMs) {
  if (!childIsRunning(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const finished = () => { clearTimeout(timer); child.removeListener("exit", finished); resolve(); };
    const timer = setTimeout(finished, timeoutMs);
    child.once("exit", finished);
  });
}

async function findVideoBrowser(executablePath) {
  if (executablePath) {
    if (await fs.stat(executablePath).then((stat) => stat.isFile()).catch(() => false)) return executablePath;
    throw failure("VIDEO_BROWSER_UNAVAILABLE", "The selected video browser could not be found.");
  }
  const candidates = [];
  for (const directory of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean)) {
    candidates.push(path.join(directory, "Google", "Chrome", "Application", "chrome.exe"));
    candidates.push(path.join(directory, "Microsoft", "Edge", "Application", "msedge.exe"));
  }
  // Portable builds ship a Chromium runtime as well as the desktop launcher.
  const fixedRoot = path.join(root, "vendor", "webview2-fixed");
  for (const version of await fs.readdir(fixedRoot).catch(() => [])) {
    const versionRoot = path.join(fixedRoot, version);
    for (const runtime of await fs.readdir(versionRoot).catch(() => [])) {
      candidates.push(path.join(versionRoot, runtime, "msedgewebview2.exe"));
    }
  }
  for (const executable of candidates) {
    if (await fs.stat(executable).then((stat) => stat.isFile()).catch(() => false)) return executable;
  }
  throw Object.assign(new Error("Install Chrome or Edge to scan Douyin pages that load video data dynamically."), { code: "VIDEO_BROWSER_UNAVAILABLE" });
}

export function isDouyinDetailResponse(urlInput) {
  try {
    const url = new URL(urlInput);
    return url.protocol === "https:" && (url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com")) &&
      /^\/aweme\/v\d+\/(?:web\/)?aweme\/detail\/?$/.test(url.pathname);
  } catch { return false; }
}

export function douyinDetailMatchesVideo(data, videoId) {
  const item = data?.aweme_detail || data?.awemeDetail;
  return String(item?.aweme_id || item?.awemeId || "") === String(videoId) && Boolean(item?.video);
}

export function isDouyinDetailAccessBlocked(urlInput, status, videoId) {
  if (![403, 429].includes(Number(status)) || !isDouyinDetailResponse(urlInput)) return false;
  return new URL(urlInput).searchParams.get("aweme_id") === String(videoId);
}

// Observe the site's own player response. A persistent profile, when supplied,
// belongs to MagicBox; the user's ordinary browser/cookie store is never read.
// Call with headless:false only after the user explicitly requests verification.
export async function captureDouyinVideoData(videoId, { timeoutMs = 25000, executablePath, headless = true, profileRoot, signal } = {}) {
  if (!/^\d{5,30}$/.test(String(videoId))) throw new Error("Invalid Douyin video ID.");
  if (signal?.aborted) throw failure("VIDEO_VERIFICATION_CANCELLED", "Douyin browser scanning was cancelled.");
  const isHeadless = headless !== false;
  const timeout = Math.min(180000, Math.max(1000, Number(timeoutMs) || 25000));
  const canonicalUrl = `https://www.douyin.com/video/${videoId}`;
  const lease = profileRoot == null ? null : await acquireVerificationProfile(profileRoot, canonicalUrl);
  const profile = lease?.profile || await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-video-browser-"));
  const pending = new Map();
  const responses = new Set();
  let nextId = 0, socket, timer, child, pageSessionId, stoppedError, closing = false;
  let resolveCapture, rejectStopped;
  const captured = new Promise((resolve) => { resolveCapture = resolve; });
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  stopped.catch(() => {});
  const stop = (error) => {
    if (closing || stoppedError) return;
    stoppedError = error;
    rejectStopped(error);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const cancelled = () => stop(failure("VIDEO_VERIFICATION_CANCELLED", "Douyin browser scanning was cancelled or its window was closed."));
  const race = (promise) => Promise.race([promise, stopped]);
  const timeoutError = () => failure(isHeadless ? "VIDEO_SCAN_TIMEOUT" : "VIDEO_VERIFICATION_TIMEOUT", isHeadless
    ? "Douyin's player did not return video data in time. Use browser verification to complete the site's check and try again."
    : "Douyin did not return this video's data in time. Retry browser verification and complete the site's check or login.");
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) { reject(failure("VIDEO_VERIFICATION_CANCELLED", "Video browser disconnected.")); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
      if (error) { pending.delete(id); reject(error); }
    });
  });
  try {
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
    timer = setTimeout(() => stop(timeoutError()), timeout);
    const executable = await race(findVideoBrowser(executablePath));
    // A persistent profile may retain an endpoint from an earlier launch.
    await race(fs.unlink(path.join(profile, "DevToolsActivePort")).catch((error) => { if (error.code !== "ENOENT") throw error; }));
    if (stoppedError) throw stoppedError;
    try {
      child = spawn(executable, [
        ...(isHeadless ? ["--headless=new", "--disable-gpu"] : ["--new-window"]),
        "--disable-extensions", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--mute-audio",
        "--autoplay-policy=document-user-activation-required", "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "about:blank"
      ], { windowsHide: isHeadless, stdio: "ignore" });
    } catch (error) { throw failure("VIDEO_BROWSER_UNAVAILABLE", "The Douyin video browser could not start.", error); }
    child.on("error", (error) => stop(failure("VIDEO_BROWSER_UNAVAILABLE", "The Douyin video browser could not start.", error)));
    child.once("exit", cancelled);
    let activePort;
    while (!activePort) {
      if (stoppedError) throw stoppedError;
      activePort = await race(fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(() => null));
      if (!activePort) await race(delay(100));
    }
    const [port, endpoint] = activePort.trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint || "")) {
      throw failure("VIDEO_BROWSER_UNAVAILABLE", "Invalid video browser endpoint.");
    }
    socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`, { maxPayload: 12 * 1024 * 1024 });
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.id) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request?.reject(failure("VIDEO_BROWSER_UNAVAILABLE", "Video browser command failed."));
        else request?.resolve(message.result);
        return;
      }
      const params = message.params || {};
      if (message.method === "Target.detachedFromTarget" && params.sessionId === pageSessionId) { cancelled(); return; }
      if (message.sessionId !== pageSessionId) return;
      const key = `${message.sessionId}:${params.requestId}`;
      if (message.method === "Network.responseReceived") {
        if (isHeadless && isDouyinDetailAccessBlocked(params.response?.url, params.response?.status, videoId)) {
          stop(failure("DOUYIN_SESSION_REQUIRED", "Douyin requires browser verification or a fresh login before it will return this video. Verify in the dedicated browser window and retry."));
          return;
        }
        if (params.response?.status === 200 && isDouyinDetailResponse(params.response.url)) responses.add(key);
      }
      if (message.method === "Network.loadingFailed") responses.delete(key);
      if (message.method === "Network.loadingFinished" && responses.delete(key) && params.encodedDataLength < 8 * 1024 * 1024) {
        send("Network.getResponseBody", { requestId: params.requestId }, message.sessionId).then((result) => {
          const body = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
          if (body.length > 8 * 1024 * 1024) return;
          const data = JSON.parse(body);
          if (douyinDetailMatchesVideo(data, videoId)) resolveCapture(data);
        }).catch(() => {});
      }
    });
    socket.on("error", (error) => stop(failure("VIDEO_BROWSER_UNAVAILABLE", "Could not connect to the Douyin video browser.", error)));
    socket.on("close", cancelled);
    await race(new Promise((resolve) => socket.once("open", resolve)));
    const { userAgent } = await race(send("Browser.getVersion"));
    const { targetId } = await race(send("Target.createTarget", { url: "about:blank" }));
    const { sessionId } = await race(send("Target.attachToTarget", { targetId, flatten: true }));
    pageSessionId = sessionId;
    await race(send("Network.enable", { maxTotalBufferSize: 12 * 1024 * 1024, maxResourceBufferSize: 8 * 1024 * 1024 }, sessionId));
    await race(send("Page.enable", {}, sessionId));
    if (!isHeadless) await race(send("Target.activateTarget", { targetId }));
    const navigation = await race(send("Page.navigate", { url: canonicalUrl }, sessionId));
    if (navigation.errorText) throw failure("DOUYIN_SESSION_REQUIRED", "The Douyin video page could not load. Check the link and retry browser verification.");
    return { data: await race(captured), userAgent };
  } finally {
    closing = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancelled);
    if (socket?.readyState === WebSocket.OPEN) {
      await Promise.race([send("Browser.close").catch(() => {}), delay(800)]);
      socket.terminate();
    } else socket?.terminate();
    for (const entry of pending.values()) entry.reject(failure("VIDEO_VERIFICATION_CANCELLED", "Video browser scan finished."));
    pending.clear();
    if (childIsRunning(child)) {
      await waitForChildExit(child, 1200);
      if (childIsRunning(child)) {
        try { child.kill(); } catch { /* Keep the profile leased until its process exits. */ }
        await waitForChildExit(child, 1200);
      }
    }
    const releaseProfile = () => lease ? lease.release()
      : fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    if (childIsRunning(child)) child.once("exit", () => { releaseProfile().catch(() => {}); });
    else await releaseProfile();
  }
}
