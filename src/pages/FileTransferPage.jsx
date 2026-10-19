import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader2,
  Radio,
  ShieldCheck,
  Smartphone,
  Upload,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import { api } from "../lib/api.js";
import { formatBytes } from "../lib/format.js";
import { AppButton, classNames } from "../components/AppButton.jsx";
import PreviewModal from "../components/PreviewModal.jsx";

function uploadTransferFiles(files, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    for (const file of files) {
      body.append("files", file);
    }
    const request = new XMLHttpRequest();
    request.open("POST", "/api/file-transfer/sessions/current/files");
    request.responseType = "json";
    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    request.onloadend = () => signal?.removeEventListener("abort", abort);
    request.onabort = () => reject(new DOMException("Upload cancelled.", "AbortError"));
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(request.response || {});
        return;
      }
      reject(new Error(request.response?.error || "Could not prepare the selected files."));
    };
    request.onerror = () => reject(new Error("The local transfer service could not be reached."));
    request.send(body);
  });
}

const FILE_TRANSFER_MODES = [
  {
    id: "lan",
    icon: Wifi,
    title: "Same Wi-Fi",
    kicker: "Fastest setup",
    description: "Connect Windows and your Apple device to the same router, then scan the room QR code."
  },
  {
    id: "offline",
    icon: WifiOff,
    title: "Nearby, no internet",
    kicker: "Windows hotspot",
    description: "Create a private Wi-Fi link from Windows. Internet access is not required for the file data."
  },
  {
    id: "remote",
    icon: Cloud,
    title: "Long distance",
    kicker: "Relay service needed",
    description: "Encrypted remote rooms need a signed-in relay service. This transport is planned, not active yet.",
    disabled: true
  }
];

function queuedFileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

const transferPreviewImages = new Set(["apng", "avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const transferPreviewVideos = new Set(["m4v", "mov", "mp4", "webm"]);

function transferPreviewType(filename) {
  const extension = String(filename || "").split(".").pop()?.toLowerCase() || "";
  if (transferPreviewImages.has(extension)) return "image";
  if (transferPreviewVideos.has(extension)) return "video";
  return "file";
}

function FileTransferPage({ downloadPath, onError, onNotice, onOpenPath }) {
  const [mode, setMode] = useState("lan");
  const [session, setSession] = useState(null);
  const [queuedFiles, setQueuedFiles] = useState([]);
  const [isStarting, setIsStarting] = useState(false);
  const [isRefreshingNetwork, setIsRefreshingNetwork] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [receivedPreview, setReceivedPreview] = useState(null);
  const fileInputRef = useRef(null);
  const sessionVersion = useRef(0);
  const refreshInFlight = useRef(false);
  const uploadController = useRef(null);
  const startInFlight = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; uploadController.current?.abort(); };
  }, []);

  const refreshSession = useCallback(async (surfaceErrors = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    const version = sessionVersion.current;
    try {
      const result = await api("/api/file-transfer/sessions/current");
      if (mounted.current && version === sessionVersion.current) setSession(result.session || null);
    } catch (nextError) {
      if (surfaceErrors) {
        onError(nextError.message);
      }
    } finally {
      refreshInFlight.current = false;
    }
  }, [onError]);

  useEffect(() => {
    refreshSession(true);
  }, [refreshSession]);

  useEffect(() => {
    if (!session?.id) {
      return undefined;
    }
    const timer = window.setInterval(() => refreshSession(false), 1500);
    return () => window.clearInterval(timer);
  }, [refreshSession, session?.id]);

  const queuedBytes = queuedFiles.reduce((total, file) => total + file.size, 0);

  function addQueuedFiles(fileList) {
    if (uploadController.current) return;
    const incoming = Array.from(fileList || []);
    if (!incoming.length) {
      return;
    }
    setQueuedFiles((current) => {
      const seen = new Set(current.map(queuedFileKey));
      return [...current, ...incoming.filter((file) => {
        const key = queuedFileKey(file);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })];
    });
  }

  async function copyText(value, label = "Link") {
    try {
      await navigator.clipboard.writeText(value);
      onNotice(`${label} copied.`);
    } catch {
      const input = document.createElement("textarea");
      input.value = value;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
      onNotice(`${label} copied.`);
    }
  }

  async function startRoom() {
    if (startInFlight.current) return;
    startInFlight.current = true;
    sessionVersion.current++;
    setIsStarting(true);
    onError("");
    try {
      const result = await api("/api/file-transfer/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, downloadPath })
      });
      sessionVersion.current++;
      setSession(result.session);
      onNotice(mode === "offline" ? "Offline transfer room started." : "Local transfer room started.");
    } catch (nextError) {
      onError(nextError.message);
    } finally {
      startInFlight.current = false;
      setIsStarting(false);
    }
  }

  async function stopRoom() {
    try {
      await api("/api/file-transfer/sessions/current", { method: "DELETE" });
      sessionVersion.current++;
      uploadController.current?.abort();
      setSession(null);
      setQueuedFiles([]);
      onNotice("File Transfer room closed.");
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function updateNetwork(address) {
    if (isRefreshingNetwork || isUploading) return;
    const version = ++sessionVersion.current;
    setIsRefreshingNetwork(true);
    onError("");
    try {
      const result = await api("/api/file-transfer/sessions/current/network", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(address ? { address } : {})
      });
      if (!mounted.current || version !== sessionVersion.current) return;
      sessionVersion.current++;
      setSession(result.session);
      onNotice(address ? "二维码已切换，请用手机重新扫描。" : "网络地址已刷新，请扫描当前二维码。");
    } catch (nextError) {
      if (mounted.current && version === sessionVersion.current) onError(nextError.message);
    } finally {
      if (mounted.current) setIsRefreshingNetwork(false);
    }
  }

  async function openHotspotSettings() {
    try {
      await api("/api/file-transfer/hotspot-settings", { method: "POST" });
      onNotice("Windows Mobile Hotspot settings opened.");
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  async function shareQueuedFiles() {
    if (!queuedFiles.length || !session || uploadController.current) {
      return;
    }
    setIsUploading(true);
    const controller = new AbortController();
    uploadController.current = controller;
    const version = ++sessionVersion.current;
    setUploadPercent(0);
    onError("");
    try {
      const result = await uploadTransferFiles(queuedFiles, setUploadPercent, controller.signal);
      if (version !== sessionVersion.current) return;
      sessionVersion.current++;
      setSession(result.session);
      onNotice(`${queuedFiles.length} file${queuedFiles.length === 1 ? "" : "s"} ready for your Apple devices.`);
      setQueuedFiles([]);
      setUploadPercent(100);
    } catch (nextError) {
      if (nextError.name !== "AbortError") onError(nextError.message);
    } finally {
      uploadController.current = null;
      setIsUploading(false);
    }
  }

  async function removeSharedFile(fileId) {
    try {
      await api(`/api/file-transfer/sessions/current/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
      await refreshSession(true);
    } catch (nextError) {
      onError(nextError.message);
    }
  }

  function checkReceivedFile(file) {
    const mediaType = transferPreviewType(file.name);
    if (mediaType === "file") {
      onOpenPath(file.path || session?.receiveDir);
      return;
    }
    setReceivedPreview({
      key: file.id,
      mediaType,
      title: file.name,
      pageLabel: `${formatBytes(file.size)} · ${file.sourceDevice || "Apple device"}`,
      sourcePage: file.path || session?.receiveDir || "",
      previewUrl: `/api/file-transfer/sessions/current/received/${encodeURIComponent(file.id)}/preview`,
      bytes: file.size,
      isLoading: false,
      error: ""
    });
  }

  return (
    <section className="file-transfer-page">
      <div className="transfer-intro-row">
        <div>
          <span className="transfer-eyebrow">PRIVATE DEVICE BRIDGE</span>
          <h3>Choose how close the other device is.</h3>
          <p>iPhone, iPad, and Mac use a browser page, so there is nothing to install on the Apple side.</p>
        </div>
        <span className="transfer-security"><ShieldCheck size={18} /> Pairing code protected</span>
      </div>

      <div className="transfer-mode-grid" aria-label="Transfer mode">
        {FILE_TRANSFER_MODES.map((item) => {
          const Icon = item.icon;
          const selected = mode === item.id;
          return (
            <button
              key={item.id}
              className={classNames("transfer-mode-card", selected && "selected", item.disabled && "disabled")}
              type="button"
              aria-pressed={selected}
              disabled={item.disabled || Boolean(session)}
              onClick={() => setMode(item.id)}
            >
              <span className="transfer-mode-icon"><Icon size={24} /></span>
              <span className="transfer-mode-copy">
                <small>{item.kicker}</small>
                <strong>{item.title}</strong>
                <span>{item.description}</span>
              </span>
              {item.disabled ? <span className="transfer-coming">Next phase</span> : selected ? <Check size={20} /> : <ChevronRight size={20} />}
            </button>
          );
        })}
      </div>

      {!session ? (
        <section className="transfer-start-card">
          <div className="transfer-start-copy">
            <span className="transfer-start-icon">{mode === "offline" ? <WifiOff size={28} /> : <Radio size={28} />}</span>
            <div>
              <h3>{mode === "offline" ? "Create an offline nearby room" : "Create a same-network room"}</h3>
              <p>
                {mode === "offline"
                  ? "Turn on Windows Mobile Hotspot, connect the Apple device to it, then start the room. Wi-Fi carries the files without using a cloud service."
                  : "Both devices must be on the same private Wi-Fi. Windows may ask you to allow Magic Box on private networks the first time."}
              </p>
            </div>
          </div>
          <div className="transfer-start-actions">
            {mode === "offline" ? (
              <AppButton tone="secondary" onClick={openHotspotSettings}>
                <Wifi size={19} /> Hotspot settings
              </AppButton>
            ) : null}
            <AppButton tone="accent" onClick={startRoom} disabled={isStarting}>
              {isStarting ? <Loader2 className="spin" size={20} /> : <ShieldCheck size={20} />}
              Start transfer room
            </AppButton>
          </div>
        </section>
      ) : (
        <>
          <section className="transfer-room-grid">
            <div className="transfer-qr-card">
              <div className="transfer-card-head">
                <div>
                  <span className="transfer-live"><i /> Room live</span>
                  <h3>Scan with your Apple device</h3>
                </div>
                <AppButton tone="secondary" onClick={stopRoom}>Stop room</AppButton>
              </div>
              {session.networkAvailable ? (
                <div className="transfer-qr-layout">
                  <div className="transfer-qr-frame"><img src={session.qrDataUrl} alt="QR code for this transfer room" /></div>
                  <div className="transfer-pairing-copy">
                    <span>Pairing code</span>
                    <strong className="transfer-pairing-code" aria-label={`Pairing code ${session.pairingCode}`}>
                      {session.pairingCode.split("").map((digit, index) => <i key={`${digit}-${index}`}>{digit}</i>)}
                    </strong>
                    <p>1. Open Camera on iPhone or iPad.<br />2. Scan the QR code.<br />3. Enter this six-digit code.</p>
                    <AppButton tone="secondary" onClick={() => copyText(session.primaryUrl, "Transfer link")}>
                      <Copy size={18} /> Copy link
                    </AppButton>
                  </div>
                </div>
              ) : (
                <div className="transfer-network-warning">
                  <WifiOff size={28} />
                  <div><strong>No usable local network found.</strong><span>连接 Wi-Fi 或打开热点后，点击“刷新网络”。169.254 临时地址不会用于二维码。</span></div>
                </div>
              )}
              <div className="transfer-network-controls">
                {session.networkAddresses?.length ? (
                  <label>连接地址（二维码）
                    <select aria-label="连接地址（二维码）" value={session.selectedAddress} disabled={isRefreshingNetwork || isUploading} onChange={(event) => updateNetwork(event.target.value)}>
                      {session.networkAddresses.map(item => <option key={item.address} value={item.address}>{item.interfaceName} · {item.address}</option>)}
                    </select>
                  </label>
                ) : null}
                <AppButton tone="secondary" disabled={isRefreshingNetwork || isUploading} onClick={() => updateNetwork()}>
                  {isRefreshingNetwork ? <Loader2 className="spin" size={18} /> : <Wifi size={18} />}刷新网络
                </AppButton>
                {session.primaryUrl ? <p className="transfer-current-address">{session.primaryUrl}</p> : null}
              </div>
              <details className="transfer-connection-help">
                <summary>手机扫码打不开？</summary>
                <ol>
                  <li>确认手机连接同一 Wi-Fi，使用系统相机扫码并在 Safari 或 Chrome 打开。</li>
                  <li>有多个网卡时，选择与手机 Wi-Fi 同一网段的地址；切换后重新扫码。换 Wi-Fi 后可点击“刷新网络”。</li>
                  <li>Windows 防火墙若询问权限，允许 Magic Box 的 Node.js 服务在私人网络通信。请勿关闭整个防火墙。</li>
                  <li>访客 Wi-Fi、路由器的设备隔离或 VPN 可能阻断连接；可改用电脑热点，并让手机连接该热点。</li>
                </ol>
                <p>地址和二维码能在电脑上生成，并不代表路由器或防火墙已经允许手机连接。</p>
              </details>
              <footer className="transfer-room-footer">
                <span><Smartphone size={17} /> {session.connectedDevices.length} connected device{session.connectedDevices.length === 1 ? "" : "s"}</span>
                <span>Room expires in 12 hours</span>
              </footer>
            </div>

            <div className="transfer-files-card">
              <div className="transfer-card-head">
                <div><span className="transfer-card-kicker">WINDOWS → APPLE</span><h3>Share from this PC</h3></div>
                <span>{session.sharedFiles.length} ready</span>
              </div>
              <div
                className="transfer-drop-zone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  addQueuedFiles(event.dataTransfer.files);
                }}
              >
                <Upload size={28} />
                <strong>Drop files here</strong>
                <span>or choose files from Windows</span>
                <AppButton tone="secondary" disabled={isUploading} onClick={() => fileInputRef.current?.click()}>Choose files</AppButton>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  disabled={isUploading}
                  hidden
                  onChange={(event) => {
                    addQueuedFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
              </div>
              {queuedFiles.length ? (
                <div className="transfer-queue">
                  <div><strong>{queuedFiles.length} selected</strong><span>{formatBytes(queuedBytes)}</span></div>
                  <button type="button" disabled={isUploading} onClick={() => setQueuedFiles([])}>Clear</button>
                </div>
              ) : null}
              {isUploading ? (
                <div className="transfer-upload-progress" role="status">
                  <div><strong>Preparing files</strong><span>{uploadPercent}%</span></div>
                  <span className="transfer-progress-track"><i style={{ width: `${uploadPercent}%` }} /></span>
                </div>
              ) : null}
              <AppButton className="transfer-share-button" tone="accent" disabled={!queuedFiles.length || isUploading || isRefreshingNetwork} onClick={shareQueuedFiles}>
                {isUploading ? <Loader2 className="spin" size={20} /> : <Upload size={20} />}
                Share selected with devices
              </AppButton>
              <div className="transfer-file-list">
                {session.sharedFiles.map((file) => (
                  <div className="transfer-file-row" key={file.id}>
                    <span className="transfer-file-icon"><FileText size={19} /></span>
                    <div><strong>{file.name}</strong><span>{formatBytes(file.size)}{file.downloadedAt ? " · downloaded" : ""}</span></div>
                    <button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeSharedFile(file.id)}><X size={16} /></button>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="transfer-received-card">
            <div className="transfer-card-head">
              <div><span className="transfer-card-kicker">APPLE → WINDOWS</span><h3>Received on this PC</h3></div>
              <AppButton tone="secondary" onClick={() => onOpenPath(session.receiveDir)}>
                <FolderOpen size={18} /> Open folder
              </AppButton>
            </div>
            {session.activeTransfer?.direction === "to-windows" ? (
              <div className="transfer-incoming-banner">
                <Loader2 className="spin" size={19} />
                <div><strong>{session.activeTransfer.name}</strong><span>{session.activeTransfer.percent || 0}% received</span></div>
              </div>
            ) : null}
            {session.receivedFiles.length ? (
              <div className="transfer-received-grid">
                {session.receivedFiles.map((file) => (
                  <article className="transfer-received-item" key={file.id}>
                    <button className="transfer-received-open" type="button" onClick={() => checkReceivedFile(file)}>
                      <span><Download size={19} /></span>
                      <div><strong>{file.name}</strong><small>{formatBytes(file.size)} · {file.sourceDevice || "Apple device"}</small></div>
                      <ChevronRight size={18} />
                    </button>
                    <div className="transfer-received-actions">
                      <button type="button" onClick={() => onOpenPath(file.path || session.receiveDir)}>
                        <ExternalLink size={15} /> Open in Windows
                      </button>
                      <a
                        href={`/api/file-transfer/sessions/current/received/${encodeURIComponent(file.id)}/download`}
                        download={file.name}
                      >
                        <Download size={15} /> Save a copy
                      </a>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="transfer-empty-received">
                <Smartphone size={34} />
                <div><strong>Waiting for files from an Apple device</strong><span>After pairing, choose “Send to Windows” in the mobile transfer page.</span></div>
              </div>
            )}
          </section>
        </>
      )}
      <PreviewModal preview={receivedPreview} onClose={() => setReceivedPreview(null)} />
    </section>
  );
}


export default FileTransferPage;
