import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";

const MAX_HTML_CHARS = 8 * 1024 * 1024;
const activeProfiles = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const busyError = () => failure("VIDEO_VERIFICATION_BUSY", "A verification window is already open for this site. Finish or close that window first.");
const childIsRunning = (child) => Boolean(child?.pid && child.exitCode == null && child.signalCode == null);

function waitForChildExit(child, timeoutMs) {
  if (!childIsRunning(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const finished = () => { clearTimeout(timer); child.removeListener("exit", finished); resolve(); };
    const timer = setTimeout(finished, timeoutMs);
    child.once("exit", finished);
  });
}

async function removeStaleProfileLock(lockPath) {
  // Serialize stale-lock recovery so two new server processes cannot remove
  // each other's freshly acquired lease after observing the same dead owner.
  let recovery;
  try { recovery = await fs.open(`${lockPath}.recovery`, "wx"); }
  catch (error) { if (error.code === "EEXIST") throw busyError(); throw error; }
  try {
    let existing;
    try { existing = JSON.parse(await fs.readFile(lockPath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw busyError(); }
    let ownerGone = false;
    if (Number.isSafeInteger(existing?.pid) && existing.pid > 0) {
      try { process.kill(existing.pid, 0); } catch (error) { ownerGone = error.code === "ESRCH"; }
    }
    if (!ownerGone) throw busyError();
    await fs.unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  } finally {
    await recovery.close().catch(() => {});
    await fs.unlink(`${lockPath}.recovery`).catch(() => {});
  }
}

function verifiedUrl(value) {
  let url;
  try { url = new URL(value); } catch { /* Report one consistent public error. */ }
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw failure("VIDEO_VERIFICATION_REQUIRED", "Browser verification requires an HTTP or HTTPS page URL without embedded credentials.");
  }
  return url;
}

// These checks describe the page we actually read, not a site's advertised
// player URL. A redirect cannot grant another origin access to its session.
export function verifiedPageState(page, expectedUrl) {
  const expected = verifiedUrl(expectedUrl);
  if (!page?.url || page.url === "about:blank") return "loading";
  let current;
  try { current = new URL(page.url); } catch { return "loading"; }
  if (current.origin !== expected.origin) return "redirect";
  const headers = page.headers || {};
  const mitigated = Object.entries(headers).some(([key, value]) => key.toLowerCase() === "cf-mitigated" && /challenge/i.test(String(value)));
  const html = String(page.html || "");
  const challengeTitle = /just a moment|attention required.*cloudflare|checking your browser|verify (?:that )?you are human|安全验证|人机验证/i.test(String(page.title || ""));
  const challengeShell = /\b_cf_chl_opt\s*=|\bid\s*=\s*["'](?:challenge-form|challenge-running|challenge-stage|cf-error-details)["']/i.test(html);
  if (mitigated || challengeTitle || challengeShell) return "challenge";
  if (page.status !== 200 || page.readyState !== "complete" || !html.trim()) return "loading";
  if (html.length > MAX_HTML_CHARS) return "oversize";
  return "ready";
}

// Keep site sessions in an application-owned profile. The lock also prevents a
// second server process from attaching to or closing the first one's browser.
function verificationProfilePath(profileRoot, pageUrl) {
  if (typeof profileRoot !== "string" || !profileRoot.trim()) throw failure("VIDEO_BROWSER_UNAVAILABLE", "A browser verification profile directory is required.");
  const origin = verifiedUrl(pageUrl).origin;
  return path.join(path.resolve(profileRoot), createHash("sha256").update(origin).digest("hex").slice(0, 32));
}

export async function hasVerificationProfile(profileRoot, pageUrl) {
  try { return (await fs.stat(verificationProfilePath(profileRoot, pageUrl))).isDirectory(); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
}

export async function acquireVerificationProfile(profileRoot, pageUrl) {
  const profile = verificationProfilePath(profileRoot, pageUrl);
  if (activeProfiles.has(profile)) throw busyError();
  activeProfiles.add(profile);
  const lockPath = `${profile}.lock`;
  let lock;
  const nonce = randomUUID();
  try {
    await fs.mkdir(path.dirname(profile), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try { lock = await fs.open(lockPath, "wx"); break; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (attempt) throw busyError();
        await removeStaleProfileLock(lockPath);
      }
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid, nonce }));
    await fs.mkdir(profile, { recursive: true });
    let released = false;
    return { profile, async release() {
      if (released) return;
      released = true;
      await lock.close().catch(() => {});
      const current = await fs.readFile(lockPath, "utf8").then(JSON.parse).catch(() => null);
      if (current?.nonce === nonce) await fs.unlink(lockPath).catch(() => {});
      activeProfiles.delete(profile);
    } };
  } catch (error) {
    if (lock) {
      await lock.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
    activeProfiles.delete(profile);
    throw error;
  }
}

async function findBrowser(executablePath) {
  const candidates = executablePath ? [executablePath] : [];
  if (!executablePath) {
    for (const directory of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(directory, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(directory, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  }
  for (const candidate of candidates) {
    if (await fs.stat(candidate).then((stat) => stat.isFile()).catch(() => false)) return candidate;
  }
  throw failure("VIDEO_BROWSER_UNAVAILABLE", "Install Chrome or Edge to open a browser verification window.");
}

// Call only after an explicit user action. This opens a visible browser and
// waits for the user to complete the site's own verification. It never clicks
// a challenge, reads cookies, or uses the user's ordinary browser profile.
export async function captureVerifiedVideoPage(pageUrl, { profileRoot, timeoutMs = 150000, signal, executablePath, headless = false, inspectPage } = {}) {
  const requested = verifiedUrl(pageUrl);
  if (signal?.aborted) throw failure("VIDEO_VERIFICATION_CANCELLED", "Browser verification was cancelled.");
  const timeout = Math.min(180000, Math.max(1000, Number(timeoutMs) || 150000));
  const lease = await acquireVerificationProfile(profileRoot, requested.href);
  const pending = new Map();
  const documents = new Map();
  let child, socket, timer, pageSessionId, nextId = 0, closing = false, stoppedError, sawChallenge = false;
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  stopped.catch(() => {});
  const stop = (error) => {
    if (closing || stoppedError) return;
    stoppedError = error;
    rejectStopped(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const cancelled = () => stop(failure("VIDEO_VERIFICATION_CANCELLED", "Browser verification was cancelled or its window was closed."));
  const race = (promise) => Promise.race([promise, stopped]);
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) { reject(failure("VIDEO_VERIFICATION_CANCELLED", "The verification browser disconnected.")); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
      if (error) { pending.delete(id); reject(error); }
    });
  });
  try {
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
    timer = setTimeout(() => stop(failure(sawChallenge ? "VIDEO_VERIFICATION_REQUIRED" : "VIDEO_VERIFICATION_TIMEOUT", sawChallenge
      ? "The site still requires browser verification. Open verification again and complete the site's check."
      : "The browser did not finish loading this page in time. Try verification again.")), timeout);
    const executable = await race(findBrowser(executablePath));
    // A stale endpoint belongs to an earlier launch. Never attach to it.
    await fs.unlink(path.join(lease.profile, "DevToolsActivePort")).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (stoppedError) throw stoppedError;
    try {
      child = spawn(executable, [
        ...(headless ? ["--headless=new", "--disable-gpu"] : ["--new-window"]),
        "--disable-extensions", "--disable-background-networking", "--no-first-run", "--no-default-browser-check",
        "--mute-audio", "--autoplay-policy=document-user-activation-required", "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1", `--user-data-dir=${lease.profile}`, "about:blank"
      ], { windowsHide: headless, stdio: "ignore" });
    } catch (error) {
      throw failure("VIDEO_BROWSER_UNAVAILABLE", "The verification browser could not start.", error);
    }
    child.once("error", (error) => stop(failure("VIDEO_BROWSER_UNAVAILABLE", "The verification browser could not start.", error)));
    child.once("exit", cancelled);
    let endpoint;
    while (!endpoint) {
      if (stoppedError) throw stoppedError;
      endpoint = await race(fs.readFile(path.join(lease.profile, "DevToolsActivePort"), "utf8").catch(() => null));
      if (!endpoint) await race(delay(100));
    }
    const [port, browserPath] = endpoint.trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browserPath || "")) {
      throw failure("VIDEO_BROWSER_UNAVAILABLE", "The verification browser returned an invalid connection endpoint.");
    }
    socket = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`, { maxPayload: MAX_HTML_CHARS * 4 + 65536 });
    socket.on("error", (error) => stop(failure("VIDEO_BROWSER_UNAVAILABLE", "Could not connect to the verification browser.", error)));
    socket.on("close", cancelled);
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.id) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          const changedContext = typeof inspectPage === "function" && /execution context was destroyed|cannot find context|inspected target navigated/i.test(String(message.error.message || ""));
          request?.reject(failure(changedContext ? "VIDEO_BROWSER_CONTEXT_CHANGED" : "VIDEO_BROWSER_UNAVAILABLE", changedContext
            ? "The browser page changed during inspection."
            : "A verification browser command failed."));
        }
        else request?.resolve(message.result);
      } else if (message.method === "Network.responseReceived" && message.params?.type === "Document") {
        documents.set(message.params.loaderId, message.params.response);
        if (documents.size > 100) documents.delete(documents.keys().next().value);
      } else if (message.method === "Target.detachedFromTarget" && message.params?.sessionId === pageSessionId) {
        cancelled();
      }
    });
    await race(new Promise((resolve) => socket.once("open", resolve)));
    const { userAgent } = await race(send("Browser.getVersion"));
    const { targetId } = await race(send("Target.createTarget", { url: "about:blank" }));
    const { sessionId } = await race(send("Target.attachToTarget", { targetId, flatten: true }));
    pageSessionId = sessionId;
    await race(send("Network.enable", {}, sessionId));
    await race(send("Network.setBlockedURLs", { urls: ["mp4", "m3u8", "mpd", "m4s", "webm", "mp3", "aac", "ogg", "wav"].flatMap((extension) => [`*.${extension}`, `*.${extension}?*`]) }, sessionId));
    await race(send("Page.enable", {}, sessionId));
    await race(send("Target.activateTarget", { targetId }));
    const navigation = await race(send("Page.navigate", { url: requested.href }, sessionId));
    if (navigation.errorText) throw failure("VIDEO_VERIFICATION_REQUIRED", "The verification browser could not load this page.");
    let readySince = 0, readyLoader, nextInspectionAt = 0;
    const evaluate = async (expression) => {
      if (typeof expression !== "string" || !expression.trim()) throw failure("VIDEO_BROWSER_EVALUATION_FAILED", "A browser inspection expression is required.");
      // Guard inside the execution context too: navigation may happen after the
      // document snapshot but before an inspection's credentialed request.
      const result = await race(send("Runtime.evaluate", {
        expression: `(async () => { if (location.origin !== ${JSON.stringify(requested.origin)}) throw new Error("MAGICBOX_VERIFICATION_ORIGIN_CHANGED"); return await (${expression}); })()`,
        awaitPromise: true,
        returnByValue: true
      }, sessionId));
      if (result.exceptionDetails) {
        const description = String(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "");
        if (description.includes("MAGICBOX_VERIFICATION_ORIGIN_CHANGED")) throw failure("VIDEO_VERIFICATION_REDIRECT", "Verification redirected to a different site. Scan that site's page URL separately.");
        if (/execution context was destroyed|cannot find context|inspected target navigated/i.test(description)) throw failure("VIDEO_BROWSER_CONTEXT_CHANGED", "The browser page changed during inspection.");
        throw failure("VIDEO_BROWSER_EVALUATION_FAILED", "The browser could not inspect this video's page.");
      }
      return result.result?.value;
    };
    while (true) {
      const { frameTree } = await race(send("Page.getFrameTree", {}, sessionId));
      const frame = frameTree?.frame;
      const response = documents.get(frame?.loaderId);
      let snapshot;
      try {
        const result = await race(send("Runtime.evaluate", {
          expression: `JSON.stringify({url:document.location.href,title:document.title,readyState:document.readyState,html:document.documentElement && document.documentElement.outerHTML.length <= ${MAX_HTML_CHARS} ? document.documentElement.outerHTML : null,oversize:!!document.documentElement && document.documentElement.outerHTML.length > ${MAX_HTML_CHARS}})`,
          returnByValue: true
        }, sessionId));
        if (result.exceptionDetails || typeof result.result?.value !== "string") throw new Error("Document changed while reading.");
        snapshot = JSON.parse(result.result.value);
      } catch (error) {
        if (stoppedError) throw stoppedError;
        readySince = 0;
        await race(delay(200));
        continue;
      }
      if (snapshot.oversize) throw failure("VIDEO_VERIFICATION_REQUIRED", "This page is too large for the video scanner.");
      const currentDocumentUrl = `${frame?.url || ""}${frame?.urlFragment || ""}`;
      const state = verifiedPageState({ ...snapshot, status: snapshot.url === currentDocumentUrl ? response?.status : undefined, headers: response?.headers }, requested.href);
      if (state === "redirect") throw failure("VIDEO_VERIFICATION_REDIRECT", "Verification redirected to a different site. Scan that site's page URL separately.");
      if (state === "challenge") sawChallenge = true;
      if (state === "ready") {
        if (!readySince || readyLoader !== frame.loaderId) { readySince = Date.now(); readyLoader = frame.loaderId; }
        if (Date.now() - readySince >= 1500) {
          const capture = { html: snapshot.html, finalUrl: snapshot.url, userAgent };
          if (typeof inspectPage !== "function") return capture;
          if (Date.now() >= nextInspectionAt) {
            nextInspectionAt = Date.now() + 2000;
            try {
              const inspection = await race(Promise.resolve().then(() => inspectPage({ ...capture, evaluate })));
              if (inspection) {
                const { frameTree: inspectedTree } = await race(send("Page.getFrameTree", {}, sessionId));
                const inspectedFrame = inspectedTree?.frame;
                if (new URL(inspectedFrame?.url || requested.href).origin !== requested.origin) throw failure("VIDEO_VERIFICATION_REDIRECT", "Verification redirected to a different site. Scan that site's page URL separately.");
                if (inspectedFrame?.loaderId === readyLoader) return { ...capture, inspection };
                readySince = 0;
              }
            } catch (error) {
              if (stoppedError) throw stoppedError;
              if (error.code !== "VIDEO_BROWSER_CONTEXT_CHANGED") throw error;
              readySince = 0;
            }
          }
        }
      } else readySince = 0;
      await race(delay(250));
    }
  } finally {
    closing = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancelled);
    if (socket?.readyState === WebSocket.OPEN) {
      await Promise.race([send("Browser.close").catch(() => {}), delay(800)]);
      socket.terminate();
    } else socket?.terminate();
    for (const request of pending.values()) request.reject(failure("VIDEO_VERIFICATION_CANCELLED", "Browser verification ended."));
    pending.clear();
    if (childIsRunning(child)) {
      await waitForChildExit(child, 1200);
      if (childIsRunning(child)) {
        // Only this invocation's process can be terminated. Keep the profile
        // leased until its exit is observed, including a delayed OS shutdown.
        try { child.kill(); } catch { /* Its user-visible window may still close normally. */ }
        await waitForChildExit(child, 1200);
      }
    }
    if (childIsRunning(child)) child.once("exit", () => { lease.release().catch(() => {}); });
    else await lease.release();
  }
}
