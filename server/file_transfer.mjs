import express from "express";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import multer from "multer";
import QRCode from "qrcode";
import { transferNetworkAddresses } from "./file-transfer-network.mjs";

const maxTransferFiles = 100;
const maxTransferFileBytes = 20 * 1024 * 1024 * 1024;
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const authTokenBytes = 24;

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
}

function safeFilename(value) {
  const base = path.basename(String(value || "file"));
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return cleaned || "file";
}

function decodeUploadName(name) {
  // Browser multipart headers use UTF-8; preserve already-decoded Unicode and
  // genuine Latin-1 names when strict UTF-8 decoding is not possible.
  if ([...name].some((character) => character.charCodeAt(0) > 255)) return name;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(name, "latin1")); }
  catch { return name; }
}

async function reserveDiskFile(directory, originalName) {
  const safe = safeFilename(originalName);
  const extension = path.extname(safe);
  const stem = path.basename(safe, extension);
  let candidate = safe;
  let suffix = 2;
  while (true) {
    const filePath = path.join(directory, candidate);
    try {
      return { handle: await fs.open(filePath, "wx"), filename: candidate, path: filePath };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      candidate = `${stem} (${suffix})${extension}`;
      suffix += 1;
    }
  }
}

function publicFile(file) {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    direction: file.direction,
    createdAt: file.createdAt,
    downloadedAt: file.downloadedAt || null,
    sourceDevice: file.sourceDevice || null
  };
}

function isSessionExpired(session) {
  return !session || Date.now() >= session.expiresAt;
}

function remoteSessionSnapshot(session) {
  return {
    id: session.id,
    mode: session.mode,
    status: session.status,
    createdAt: session.createdAt,
    expiresAt: new Date(session.expiresAt).toISOString(),
    sharedFiles: session.sharedFiles.map(publicFile),
    receivedFiles: session.receivedFiles.map(publicFile),
    activeTransfer: session.activeTransfer,
    connectedDevices: Array.from(session.authorizedTokens.values()).map((device) => ({
      id: device.id,
      name: device.name,
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt
    }))
  };
}

function localSessionSnapshot(session) {
  if (!session) {
    return null;
  }
  return {
    ...remoteSessionSnapshot(session),
    receivedFiles: session.receivedFiles.map((file) => ({
      ...publicFile(file),
      path: file.path
    })),
    pairingCode: session.pairingCode,
    primaryUrl: session.primaryUrl,
    loopbackUrl: session.loopbackUrl,
    urls: session.urls,
    networkAddresses: session.networkAddresses,
    selectedAddress: session.selectedAddress,
    qrDataUrl: session.qrDataUrl,
    outputDir: session.outputDir,
    shareDir: session.shareDir,
    receiveDir: session.receiveDir,
    networkAvailable: session.urls.length > 0
  };
}

function jsonError(response, status, message) {
  response.status(status).json({ error: message });
}

export function createFileTransferManager({ defaultDownloadDir, rootDir, assistantIntegration = null, networkInterfaces = undefined }) {
  const localRouter = express.Router();
  const remoteApp = express();
  const mobilePagePath = [
    path.join(rootDir, "dist", "file-transfer.html"),
    path.join(rootDir, "public", "file-transfer.html")
  ].find((candidate) => existsSync(candidate));
  let listener = null;
  let listenerPort = 0;
  let listenerPromise = null;
  let session = null;

  function activeSession() {
    if (isSessionExpired(session)) {
      session = null;
    }
    return session;
  }

  function sessionForToken(token) {
    const current = activeSession();
    return current && current.status === "active" && current.token === token ? current : null;
  }

  function requireRemoteAuth(request, response, next) {
    const token = String(request.query.token || request.body?.token || request.headers["x-transfer-token"] || "");
    const auth = String(request.query.auth || request.headers.authorization?.replace(/^Bearer\s+/i, "") || "");
    const current = sessionForToken(token);
    const device = current?.authorizedTokens.get(auth);
    if (!current || !device) {
      jsonError(response, 401, "Pair with Magic Box before transferring files.");
      return;
    }
    device.lastSeenAt = new Date().toISOString();
    request.transferSession = current;
    request.transferDevice = device;
    next();
  }

  function sessionUploadStorage(kind) {
    return {
      _handleFile(request, file, callback) {
        file.originalname = decodeUploadName(file.originalname);
        const current = request.transferSession;
        const directory = kind === "received" ? current?.receiveDir : current?.shareDir;
        if (!current || !directory) {
          callback(new Error("Start a File Transfer room first."));
          return;
        }
        // Reserve atomically before consuming the stream. Multiple uploads may
        // have the same name, even within one multipart request.
        (async () => {
          const reserved = await reserveDiskFile(directory, file.originalname);
          try {
            const output = reserved.handle.createWriteStream();
            await pipeline(file.stream, output);
            return { destination: directory, filename: reserved.filename, path: reserved.path, size: output.bytesWritten };
          } catch (error) {
            await reserved.handle.close().catch(() => {});
            await fs.rm(reserved.path, { force: true }).catch(() => {});
            throw error;
          }
        })().then((result) => callback(null, result), callback);
      },
      _removeFile(_request, file, callback) {
        fs.rm(file.path, { force: true }).then(() => callback(null), callback);
      }
    };
  }

  const localUpload = multer({
    storage: sessionUploadStorage("shared"),
    limits: { fileSize: maxTransferFileBytes, files: maxTransferFiles }
  });
  const remoteUpload = multer({
    storage: sessionUploadStorage("received"),
    limits: { fileSize: maxTransferFileBytes, files: maxTransferFiles }
  });

  async function ensureListener() {
    if (listenerPromise) return listenerPromise;
    if (listener?.listening) {
      return listenerPort;
    }
    listenerPromise = (async () => {
      await new Promise((resolve, reject) => {
        listener = remoteApp.listen(0, "0.0.0.0");
        listener.once("listening", resolve);
        listener.once("error", reject);
      });
      const address = listener.address();
      listenerPort = typeof address === "object" && address ? address.port : 0;
      return listenerPort;
    })();
    try { return await listenerPromise; }
    finally { listenerPromise = null; }
  }

  async function refreshNetwork(current, requestedAddress) {
    // Serialize QR/address updates so a slow refresh cannot replace a more
    // recent manual selection. Pairing tokens and shared files remain intact.
    const previous = current.networkUpdate || Promise.resolve();
    const update = previous.catch(() => {}).then(async () => {
      const addresses = transferNetworkAddresses(networkInterfaces?.(), current.mode);
      if (requestedAddress && !addresses.some(item => item.address === requestedAddress)) {
        throw new Error("That network address is no longer available. Refresh the network list and choose again.");
      }
      let preferredAddress = requestedAddress ?? current.preferredAddress;
      if (!addresses.some(item => item.address === preferredAddress)) preferredAddress = "";
      let selectedAddress = preferredAddress;
      if (!addresses.some(item => item.address === selectedAddress)) selectedAddress = addresses[0]?.address || "";
      const networkAddresses = addresses.map(item => ({ ...item, url: `http://${item.address}:${listenerPort}/s/${current.token}` }));
      const primaryUrl = networkAddresses.find(item => item.address === selectedAddress)?.url || "";
      const qrDataUrl = primaryUrl === current.primaryUrl ? current.qrDataUrl : primaryUrl ? await QRCode.toDataURL(primaryUrl, {
        width: 320, margin: 1, color: { dark: "#10243f", light: "#ffffff" }
      }) : "";
      Object.assign(current, { preferredAddress, selectedAddress, networkAddresses, urls: networkAddresses.map(item => item.url), primaryUrl, qrDataUrl });
    });
    current.networkUpdate = update;
    await update;
  }

  async function startSession({ downloadPath, mode = "lan" } = {}) {
    const port = await ensureListener();
    const id = randomBytes(10).toString("hex");
    const token = randomBytes(24).toString("base64url");
    const pairingCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const baseDir = path.resolve(downloadPath || defaultDownloadDir);
    const outputDir = path.join(baseDir, "file-transfers", `MagicBox_${timestampSlug()}`);
    const shareDir = path.join(outputDir, "From Windows");
    const receiveDir = path.join(outputDir, "From Apple Devices");
    await Promise.all([
      fs.mkdir(shareDir, { recursive: true }),
      fs.mkdir(receiveDir, { recursive: true })
    ]);
    const loopbackUrl = `http://127.0.0.1:${port}/s/${token}`;
    const now = new Date();
    session = {
      id,
      token,
      pairingCode,
      mode: mode === "offline" ? "offline" : "lan",
      status: "active",
      createdAt: now.toISOString(),
      expiresAt: now.getTime() + sessionLifetimeMs,
      outputDir,
      shareDir,
      receiveDir,
      urls: [],
      networkAddresses: [],
      selectedAddress: "",
      primaryUrl: "",
      loopbackUrl,
      qrDataUrl: "",
      sharedFiles: [],
      receivedFiles: [],
      authorizedTokens: new Map(),
      failedPairAttempts: new Map(),
      activeTransfer: null
    };
    await refreshNetwork(session);
    return localSessionSnapshot(session);
  }

  function trackUploadProgress(request, current, direction) {
    const total = Number(request.headers["content-length"] || 0);
    let received = 0;
    current.activeTransfer = {
      direction,
      name: direction === "to-windows" ? "Receiving files" : "Preparing files",
      loaded: 0,
      total,
      percent: 0
    };
    request.on("data", (chunk) => {
      received += chunk.length;
      current.activeTransfer = {
        ...current.activeTransfer,
        loaded: received,
        percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0
      };
    });
  }

  localRouter.get("/sessions/current", async (_request, response) => {
    try {
      const current = activeSession();
      if (current) await refreshNetwork(current);
      response.json({ session: localSessionSnapshot(activeSession()) });
    } catch (error) { jsonError(response, 503, error.message); }
  });

  localRouter.post("/sessions/current/network", async (request, response) => {
    try {
      const current = activeSession();
      if (!current) return jsonError(response, 409, "Start a File Transfer room first.");
      await refreshNetwork(current, typeof request.body?.address === "string" ? request.body.address : undefined);
      response.json({ session: localSessionSnapshot(activeSession()) });
    } catch (error) { jsonError(response, 400, error.message); }
  });

  localRouter.post("/sessions", async (request, response) => {
    try {
      response.status(201).json({ session: await startSession(request.body || {}) });
    } catch (error) {
      jsonError(response, 400, error.message);
    }
  });

  localRouter.delete("/sessions/current", (_request, response) => {
    if (session) {
      session.status = "closed";
      session.authorizedTokens.clear();
      session = null;
    }
    response.status(204).end();
  });

  localRouter.post("/sessions/current/files", (request, response) => {
    const current = activeSession();
    if (!current) {
      jsonError(response, 409, "Start a File Transfer room first.");
      return;
    }
    trackUploadProgress(request, current, "to-device");
    request.transferSession = current;
    localUpload.array("files", maxTransferFiles)(request, response, (error) => {
      if (error) {
        current.activeTransfer = null;
        jsonError(response, 400, error.message);
        return;
      }
      const createdAt = new Date().toISOString();
      for (const file of request.files || []) {
        current.sharedFiles.push({
          id: randomBytes(10).toString("hex"),
          name: safeFilename(file.originalname),
          diskName: file.filename,
          path: file.path,
          size: file.size,
          direction: "to-device",
          createdAt
        });
      }
      current.activeTransfer = null;
      response.status(201).json({ session: localSessionSnapshot(current) });
    });
  });

  localRouter.delete("/sessions/current/files/:fileId", async (request, response) => {
    const current = activeSession();
    const index = current?.sharedFiles.findIndex((file) => file.id === request.params.fileId) ?? -1;
    if (!current || index < 0) {
      jsonError(response, 404, "Shared file was not found.");
      return;
    }
    const [file] = current.sharedFiles.splice(index, 1);
    await fs.rm(file.path, { force: true }).catch(() => {});
    response.status(204).end();
  });

  async function sendReceivedFile(request, response, disposition) {
    const current = activeSession();
    const file = current?.receivedFiles.find((item) => item.id === request.params.fileId);
    if (!current || !file) {
      jsonError(response, 404, "This received file is no longer available.");
      return;
    }
    try {
      await fs.stat(file.path);
      response.type(file.name);
      response.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      response.sendFile(file.path, (error) => {
        if (!error || response.destroyed) return;
        if (!response.headersSent) jsonError(response, 404, "The received file is missing from Windows.");
        else response.destroy();
      });
    } catch {
      jsonError(response, 404, "The received file is missing from Windows.");
    }
  }

  localRouter.get("/sessions/current/received/:fileId/preview", (request, response) => {
    sendReceivedFile(request, response, "inline");
  });

  localRouter.get("/sessions/current/received/:fileId/download", (request, response) => {
    sendReceivedFile(request, response, "attachment");
  });

  localRouter.post("/hotspot-settings", (_request, response) => {
    if (process.platform !== "win32") {
      jsonError(response, 400, "Mobile Hotspot settings are available on Windows only.");
      return;
    }
    execFile("explorer.exe", ["ms-settings:network-mobilehotspot"], { windowsHide: true }, (error) => {
      if (error) {
        jsonError(response, 400, "Could not open Windows Mobile Hotspot settings.");
        return;
      }
      response.json({ ok: true });
    });
  });

  remoteApp.use(express.json({ limit: "1mb" }));
  remoteApp.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  remoteApp.get("/s/:token", (request, response) => {
    if (!sessionForToken(request.params.token)) {
      response.status(404).send("This Magic Box transfer room is closed or expired.");
      return;
    }
    if (!mobilePagePath) {
      response.status(503).send("The File Transfer mobile page is missing. Rebuild Magic Box.");
      return;
    }
    response.sendFile(mobilePagePath);
  });

  remoteApp.post("/api/pair", (request, response) => {
    const token = String(request.body?.token || "");
    const code = String(request.body?.code || "").trim();
    const current = sessionForToken(token);
    if (!current) {
      jsonError(response, 404, "This transfer room is closed or expired.");
      return;
    }
    const remoteAddress = request.ip || request.socket.remoteAddress || "unknown";
    const attempt = current.failedPairAttempts.get(remoteAddress) || { count: 0, blockedUntil: 0 };
    if (Date.now() < attempt.blockedUntil) {
      jsonError(response, 429, "Too many pairing attempts. Wait one minute and try again.");
      return;
    }
    if (code !== current.pairingCode) {
      attempt.count += 1;
      if (attempt.count >= 8) {
        attempt.count = 0;
        attempt.blockedUntil = Date.now() + 60_000;
      }
      current.failedPairAttempts.set(remoteAddress, attempt);
      jsonError(response, 403, "The pairing code is not correct.");
      return;
    }
    current.failedPairAttempts.delete(remoteAddress);
    const auth = randomBytes(authTokenBytes).toString("base64url");
    const pairedAt = new Date().toISOString();
    const device = {
      id: randomBytes(8).toString("hex"),
      name: safeFilename(request.body?.deviceName || "Apple device"),
      pairedAt,
      lastSeenAt: pairedAt
    };
    current.authorizedTokens.set(auth, device);
    response.json({ auth, device, session: remoteSessionSnapshot(current) });
  });

  remoteApp.get("/api/session", requireRemoteAuth, (request, response) => {
    response.json({ session: remoteSessionSnapshot(request.transferSession) });
  });

  remoteApp.post("/api/upload", requireRemoteAuth, (request, response) => {
    const current = request.transferSession;
    const batchId = randomBytes(12).toString("hex");
    const assistantTicket = assistantIntegration?.capture("file-transfer", {
      outputRootPath: current.receiveDir,
      producerJobId: batchId
    }) || null;
    trackUploadProgress(request, current, "to-windows");
    remoteUpload.array("files", maxTransferFiles)(request, response, (error) => {
      if (error) {
        current.activeTransfer = null;
        jsonError(response, 400, error.message);
        return;
      }
      const createdAt = new Date().toISOString();
      for (const file of request.files || []) {
        current.receivedFiles.push({
          id: randomBytes(10).toString("hex"),
          name: safeFilename(file.originalname),
          diskName: file.filename,
          path: file.path,
          size: file.size,
          direction: "to-windows",
          sourceDevice: request.transferDevice.name,
          createdAt
        });
      }
      current.activeTransfer = null;
      if ((request.files || []).length && assistantTicket) {
        assistantTicket.complete({
          producerEventId: `file-transfer:${batchId}`,
          files: (request.files || []).map((file) => file.path)
        });
      }
      response.status(201).json({ session: remoteSessionSnapshot(current) });
    });
  });

  remoteApp.get("/api/files/:fileId/download", requireRemoteAuth, async (request, response) => {
    const current = request.transferSession;
    const file = current.sharedFiles.find((item) => item.id === request.params.fileId);
    if (!file) {
      jsonError(response, 404, "This shared file is no longer available.");
      return;
    }
    try {
      await fs.stat(file.path);
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      response.on("finish", () => {
        file.downloadedAt = new Date().toISOString();
      });
      response.sendFile(file.path, (error) => {
        if (!error || response.destroyed) return;
        if (!response.headersSent) jsonError(response, 404, "The shared file is missing from Windows.");
        else response.destroy();
      });
    } catch {
      jsonError(response, 404, "The shared file is missing from Windows.");
    }
  });

  remoteApp.use((_request, response) => {
    jsonError(response, 404, "Transfer endpoint not found.");
  });

  async function close() {
    session = null;
    if (!listener) {
      return;
    }
    const server = listener;
    listener = null;
    listenerPort = 0;
    await new Promise((resolve) => server.close(resolve));
  }

  return {
    localRouter,
    close,
    snapshot: () => localSessionSnapshot(activeSession())
  };
}
