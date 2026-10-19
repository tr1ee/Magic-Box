import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AudioLines,
  ArrowLeft,
  Bot,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Database,
  FileSearch,
  FileText,
  FolderOpen,
  Globe2,
  Home,
  Inbox,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  Mic,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  WandSparkles,
  X
} from "lucide-react";
import { LiveVoiceClient } from "./liveVoice.js";
import { StreamingTextCommitter } from "../shared/speech-planner.mjs";
import { renderSpokenText } from "../shared/spoken-text-renderer.mjs";
import { speakSystemText } from "./lib/systemSpeech.js";
import TextReader from "./components/assistant/TextReader.jsx";
import "./assistant-workspace.css";

const ASSISTANT_PAGES = [
  { id: "ask", label: "对话", icon: MessageSquareText },
  { id: "reader", label: "文本朗读", icon: Volume2 },
  { id: "voice", label: "声音设置", icon: Settings2 },
  { id: "conversations", label: "历史记录", icon: Clock3 },
  { id: "home", label: "运行概览", icon: Home, secondary: true },
  { id: "inbox", label: "知识库", icon: Inbox, secondary: true },
  { id: "automations", label: "自动化", icon: WandSparkles, secondary: true },
  { id: "activity", label: "活动记录", icon: Activity, secondary: true },
  { id: "models", label: "本地模型", icon: BrainCircuit, secondary: true },
  { id: "integrations", label: "工具集成", icon: Settings2, secondary: true },
  { id: "privacy", label: "隐私与数据", icon: LockKeyhole, secondary: true }
];

const ASSISTANT_VOICE_SETTINGS_KEY = "magicBox.assistantVoice.v4";
const PREVIOUS_ASSISTANT_VOICE_SETTINGS_KEY = "magicBox.assistantVoice.v3";
const LEGACY_ASSISTANT_VOICE_SETTINGS_KEY = "magicBox.assistantVoice.v2";
const FIRST_ASSISTANT_VOICE_SETTINGS_KEY = "magicBox.assistantVoice.v1";
const DEFAULT_ASSISTANT_VOICE_SETTINGS = {
  mode: "system",
  profileId: "",
  requestedMode: "system",
  requestedProfileId: "",
  systemVoiceURI: "",
  speed: 1,
  pitch: 0,
  styleStrength: 0.7,
  voicePipelineVersion: 4,
  speechRendering: "naturalized-full",
  resourceProfile: "balanced-local"
};

function readAssistantVoiceSettings() {
  try {
    const current = JSON.parse(window.localStorage.getItem(ASSISTANT_VOICE_SETTINGS_KEY) || "null");
    const previous = current ? null : JSON.parse(window.localStorage.getItem(PREVIOUS_ASSISTANT_VOICE_SETTINGS_KEY) || "null");
    const legacy = current || previous ? null : JSON.parse(window.localStorage.getItem(LEGACY_ASSISTANT_VOICE_SETTINGS_KEY) || "null");
    const first = current || previous || legacy ? null : JSON.parse(window.localStorage.getItem(FIRST_ASSISTANT_VOICE_SETTINGS_KEY) || "null");
    const stored = current || previous || legacy || first;
    const migrated = stored && typeof stored === "object" ? {
      ...stored,
      mode: stored.mode === "trained" ? "streaming" : stored.mode,
      requestedMode: stored.requestedMode || (stored.mode === "trained" ? "streaming" : stored.mode),
      requestedProfileId: stored.requestedProfileId ?? stored.profileId ?? ""
    } : {};
    if (!current && stored) migrated.voicePipelineVersion = Number(stored.voicePipelineVersion) || 0;
    return { ...DEFAULT_ASSISTANT_VOICE_SETTINGS, ...migrated };
  } catch {
    return { ...DEFAULT_ASSISTANT_VOICE_SETTINGS };
  }
}

function saveAssistantVoiceSettings(settings) {
  const next = { ...settings, voicePipelineVersion: 4, speechRendering: "naturalized-full", resourceProfile: "balanced-local" };
  delete next.language;
  delete next.similarityStrength;
  delete next.configured;
  window.localStorage.setItem(ASSISTANT_VOICE_SETTINGS_KEY, JSON.stringify(next));
  window.localStorage.removeItem(PREVIOUS_ASSISTANT_VOICE_SETTINGS_KEY);
  window.localStorage.removeItem(LEGACY_ASSISTANT_VOICE_SETTINGS_KEY);
  window.localStorage.removeItem(FIRST_ASSISTANT_VOICE_SETTINGS_KEY);
  return assistantApi("/api/assistant/preferences/voice", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next)
  });
}

function normalizedAssistantVoiceSettings(value) {
  const stored = value && typeof value === "object" ? value : {};
  const requestedMode = stored.requestedMode || stored.mode || DEFAULT_ASSISTANT_VOICE_SETTINGS.mode;
  const requestedProfileId = stored.requestedProfileId ?? stored.profileId ?? "";
  return {
    ...DEFAULT_ASSISTANT_VOICE_SETTINGS,
    ...stored,
    mode: requestedMode === "trained" ? "streaming" : requestedMode,
    profileId: requestedProfileId,
    requestedMode,
    requestedProfileId,
    voicePipelineVersion: stored.configured ? Math.max(4, Number(stored.voicePipelineVersion) || 0) : (Number(stored.voicePipelineVersion) || 4),
    speechRendering: "naturalized-full",
    resourceProfile: "balanced-local"
  };
}

function waitForVoiceDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }, { once: true });
  });
}

async function generateTrainedVoice(text, settings, { signal, onJob } = {}) {
  const job = await assistantApi("/api/voice-clone/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profileId: settings.profileId,
      text,
      language: settings.language || "auto",
      settings: {
        speed: settings.speed,
        pitch: settings.pitch,
        styleStrength: settings.styleStrength,
        similarityStrength: settings.similarityStrength,
        conversationMode: Boolean(settings.conversationMode),
        outputFormat: "wav"
      }
    }),
    signal
  });
  onJob?.(job);
  let current = job;
  while (!["completed", "failed", "cancelled"].includes(current.status)) {
    await waitForVoiceDelay(settings.conversationMode ? 160 : 800, signal);
    current = await assistantApi(`/api/voice-clone/jobs/${encodeURIComponent(job.id)}`, { signal });
    onJob?.(current);
  }
  if (current.status !== "completed" || !current.result?.output?.audioUrl) {
    throw new Error(current.error || "The trained voice could not generate this reply.");
  }
  return current.result.output;
}

async function warmTrainedVoice(profileId, { signal } = {}) {
  if (!profileId) return null;
  return assistantApi(`/api/voice-clone/profiles/${encodeURIComponent(profileId)}/warm`, {
    method: "POST",
    signal
  });
}

function splitConversationSpeech(text) {
  const normalized = String(text || "").replace(/\[S\d+\]/giu, "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?\u3002\uff01\uff1f]+[.!?\u3002\uff01\uff1f]+|[^.!?\u3002\uff01\uff1f]+$/g) || [normalized];
  const chunks = [];
  let pending = "";
  for (const sentence of sentences) {
    const next = `${pending}${pending ? " " : ""}${sentence.trim()}`.trim();
    if (pending && next.length > 220) {
      chunks.push(pending);
      pending = sentence.trim();
    } else {
      pending = next;
    }
  }
  if (pending) chunks.push(pending);
  return chunks;
}

const TOOL_LABELS = {
  images: "Image Downloader",
  videos: "Video Downloader",
  "file-transfer": "File Transfer",
  "format-factory": "Format Factory"
};

function pageFromHash() {
  const match = window.location.hash.match(/^#\/assistant\/([^/?#]+)/);
  return ASSISTANT_PAGES.some((page) => page.id === match?.[1]) ? match[1] : "ask";
}

function canonicalAssistantHash() {
  return `#/assistant/${pageFromHash()}`;
}

async function assistantApi(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `Request failed (${response.status})`);
    error.code = payload.code || "assistant_request_failed";
    error.retryable = Boolean(payload.retryable);
    error.details = payload.details;
    throw error;
  }
  return payload;
}

async function loadAssistantVoicePreferences(options = {}) {
  try {
    return await assistantApi("/api/assistant/preferences/voice", options);
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return { ...readAssistantVoiceSettings(), configured: true };
  }
}

async function assistantStreamApi(path, options = {}, onEvent) {
  const response = await fetch(path, options);
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || payload.error || `Request failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : (lines.pop() || "");
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "error") {
        const error = new Error(event.message || "The local conversation failed.");
        error.code = event.code;
        error.retryable = Boolean(event.retryable);
        throw error;
      }
      onEvent?.(event);
      if (event.type === "answer.completed") completed = event.response;
    }
    if (done) break;
  }
  if (!completed) throw new Error("The local conversation stream ended before the answer completed.");
  return completed;
}

function Button({ children, className = "", tone = "secondary", ...props }) {
  return <button className={`assistant-button assistant-button-${tone} ${className}`.trim()} type="button" {...props}>{children}</button>;
}

function Badge({ children, tone = "neutral" }) {
  return <span className={`assistant-badge assistant-badge-${tone}`}>{children}</span>;
}

function EmptyState({ icon: Icon = Sparkles, title, children, action }) {
  return (
    <div className="assistant-empty">
      <span className="assistant-empty-icon"><Icon size={28} /></span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

function ErrorNotice({ error, onDismiss, onRetry }) {
  if (!error) return null;
  return (
    <div className="assistant-notice assistant-notice-error" role="alert">
      <CircleAlert size={20} />
      <div><strong>{error.code?.replaceAll("_", " ") || "Assistant error"}</strong><span>{error.message}</span></div>
      {onRetry && <Button tone="ghost" onClick={onRetry}><RefreshCcw size={16} /> Retry</Button>}
      <button aria-label="Dismiss error" className="assistant-icon-button" onClick={onDismiss} type="button"><X size={18} /></button>
    </div>
  );
}

function ConfirmationDialog({ confirmation, onClose }) {
  const dialogRef = useRef(null);
  const confirmRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    confirmRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...dialogRef.current.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus?.(); };
  }, [onClose]);
  async function confirm() {
    onClose();
    await confirmation.onConfirm();
  }
  return <div className="assistant-dialog-backdrop"><section aria-describedby="assistant-confirm-description" aria-labelledby="assistant-confirm-title" aria-modal="true" className="assistant-dialog" ref={dialogRef} role="dialog"><div className="assistant-dialog-icon"><ShieldCheck size={24} /></div><div><span>Review required</span><h2 id="assistant-confirm-title">{confirmation.title}</h2><p id="assistant-confirm-description">{confirmation.description}</p>{confirmation.details && <pre>{confirmation.details}</pre>}</div><div className="assistant-dialog-actions"><Button onClick={onClose}>Cancel</Button><Button ref={confirmRef} tone={confirmation.danger ? "danger" : "primary"} onClick={confirm}>{confirmation.confirmLabel || "Confirm"}</Button></div></section></div>;
}

function JobProgress({ job, onCancel }) {
  if (!job) return null;
  const terminal = ["completed", "failed", "cancelled"].includes(job.status);
  const percent = Number.isFinite(job.progress) ? Math.round(job.progress) : null;
  return (
    <div className={`assistant-job assistant-job-${job.status}`} aria-live="polite">
      <div className="assistant-job-copy">
        {terminal ? <Check size={18} /> : <Loader2 className="spin" size={18} />}
        <div><strong>{job.message}</strong><span>{job.stage} · {job.counts?.completed || 0}/{job.counts?.requested || 0}</span></div>
        {percent !== null && <b>{percent}%</b>}
      </div>
      <div className={percent === null ? "assistant-progress is-indeterminate" : "assistant-progress"}>
        <i style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
      {!terminal && job.cancellable && <Button tone="ghost" onClick={() => onCancel(job.id)}><Square size={14} /> Cancel safely</Button>}
    </div>
  );
}

function relativeTime(value) {
  if (!value) return "";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function HomePage({ status, activity, onNavigate }) {
  const capabilityCards = [
    ["Inbox", status?.capabilities?.inbox, "Add files or approve workspace folders.", "inbox", Inbox],
    ["Local models", status?.capabilities?.models, "Install private generation and embedding models.", "models", BrainCircuit],
    ["Ask", status?.capabilities?.chat, "Answer questions with copied local citations.", "ask", MessageSquareText],
    ["Automations", status?.capabilities?.automation, "Preview, approve, run, and undo safe actions.", "automations", WandSparkles]
  ];
  return (
    <div className="assistant-page assistant-home-page">
      <section className="assistant-hero-card">
        <div>
          <Badge tone="safe"><ShieldCheck size={14} /> Private by design</Badge>
          <h1>Your local workspace, with an assistant inside.</h1>
          <p>Collect completed work, search approved documents, ask grounded questions, and automate carefully—without sending prompts or files to cloud AI.</p>
          <div className="assistant-hero-actions">
            <Button tone="primary" onClick={() => onNavigate("inbox")}><Plus size={17} /> Add local material</Button>
            <Button onClick={() => onNavigate("ask")}><MessageSquareText size={17} /> Ask the workspace</Button>
          </div>
        </div>
        <div className="assistant-hero-orbit" aria-hidden="true"><Bot size={52} /><i /><i /><i /></div>
      </section>
      <section className="assistant-metric-row" aria-label="Assistant summary">
        <article><Inbox size={20} /><span>Inbox</span><strong>{status?.counts?.items || 0}</strong><small>local items</small></article>
        <article><Clock3 size={20} /><span>Active work</span><strong>{status?.counts?.activeJobs || 0}</strong><small>background jobs</small></article>
        <article><Activity size={20} /><span>Activity</span><strong>{status?.counts?.activity || 0}</strong><small>auditable records</small></article>
      </section>
      <section className="assistant-section">
        <div className="assistant-section-heading"><div><span>Workspace capabilities</span><h2>Everything stays under your control</h2></div></div>
        <div className="assistant-capability-grid">
          {capabilityCards.map(([title, state, copy, page, Icon]) => (
            <button className="assistant-capability-card" key={title} onClick={() => onNavigate(page)} type="button">
              <span className="assistant-capability-icon"><Icon size={22} /></span>
              <div><strong>{title}</strong><p>{copy}</p></div>
              <Badge tone={state === "ready" ? "ready" : state === "metadata-only" ? "busy" : "neutral"}>{state || "unavailable"}</Badge>
              <ChevronRight size={18} />
            </button>
          ))}
        </div>
      </section>
      <section className="assistant-section">
        <div className="assistant-section-heading"><div><span>Recent activity</span><h2>What happened locally</h2></div><Button tone="ghost" onClick={() => onNavigate("activity")}>View all <ChevronRight size={16} /></Button></div>
        {activity.length ? <div className="assistant-activity-list compact">{activity.slice(0, 5).map((record) => <ActivityRow key={record.id} record={record} />)}</div> : <EmptyState icon={Activity} title="No activity yet">Import a document or approve a workspace folder to begin.</EmptyState>}
      </section>
    </div>
  );
}

function ItemState({ state }) {
  const tone = state === "indexed" ? "ready" : state === "failed" || state === "missing" ? "error" : state === "pending" ? "busy" : "neutral";
  return <Badge tone={tone}>{state}</Badge>;
}

function InboxPage({ items, total, onLoadMore, roots, selectedItems, setSelectedItems, onImport, onAddRoot, onRemoveItem, onRemoveRoot, onReindex, busy, search, setSearch }) {
  const inputRef = useRef(null);
  const filtered = items.filter((item) => !search || `${item.displayName} ${item.summary || ""} ${item.tags.join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="assistant-page">
      <header className="assistant-page-header"><div><span>Approved local material</span><h1>Inbox</h1><p>Managed imports and referenced workspace files remain visibly distinct.</p></div><div><Button onClick={onAddRoot}><FolderOpen size={17} /> Add workspace folder</Button><Button tone="primary" onClick={() => inputRef.current?.click()}><Upload size={17} /> Import files</Button><input hidden multiple onChange={(event) => onImport(event.target.files)} ref={inputRef} type="file" /></div></header>
      <div className="assistant-search"><Search size={18} /><input aria-label="Search Inbox" onChange={(event) => setSearch(event.target.value)} placeholder="Search names, summaries, and tags" value={search} /></div>
      {roots.length > 0 && <section className="assistant-root-strip"><strong>Workspace access</strong>{roots.map((root) => <span key={root.id}><FolderOpen size={15} /><b title={root.path}>{root.path}</b><button aria-label={`Remove ${root.path}`} onClick={() => onRemoveRoot(root.id)} type="button"><X size={14} /></button></span>)}</section>}
      {filtered.length ? (
        <div className="assistant-item-grid">
          {filtered.map((item) => {
            const selected = selectedItems.includes(item.id);
            return (
              <article className={`assistant-item-card ${selected ? "is-selected" : ""}`} key={item.id}>
                <button aria-label={`${selected ? "Deselect" : "Select"} ${item.displayName}`} className="assistant-select" onClick={() => setSelectedItems((current) => selected ? current.filter((id) => id !== item.id) : [...current, item.id])} type="button">{selected && <Check size={14} />}</button>
                <span className="assistant-file-icon"><FileText size={24} /></span>
                <div className="assistant-item-title"><strong title={item.displayName}>{item.displayName}</strong><ItemState state={item.state} /></div>
                <p>{item.summary || (item.state === "unsupported" ? "Saved in Inbox; content extraction is not supported for this format." : "Metadata is available while content indexing completes.")}</p>
                <div className="assistant-item-meta"><span>{item.source}</span><span>{Math.max(1, Math.round(item.sizeBytes / 1024))} KiB</span><span>rev {item.revision}</span></div>
                <div className="assistant-card-actions"><Button tone="ghost" disabled={busy || item.state === "pending"} onClick={() => onReindex(item.id)}><RefreshCcw size={15} /> Re-index</Button><Button tone="danger-ghost" disabled={busy} onClick={() => onRemoveItem(item.id)}><Trash2 size={15} /> Remove</Button></div>
              </article>
            );
          })}
        </div>
      ) : <EmptyState icon={Inbox} title="Your private Inbox is empty">Import TXT, Markdown, PDF, DOCX, or another regular file, or approve a local workspace folder.</EmptyState>}
      {items.length < total && <Button disabled={busy} onClick={onLoadMore}>Load more Inbox items</Button>}
    </div>
  );
}

function SourceCard({ source, onOpenCopied, onOpenCurrent }) {
  if (source.sourceType === "web" || source.url) {
    return (
      <article className="assistant-source-card assistant-web-source-card">
        <div><Globe2 size={18} /><strong>{source.displayName}</strong><Badge tone="ready">online</Badge></div>
        <p>{source.excerpt}</p>
        <div><a className="assistant-button assistant-button-ghost" href={source.url} rel="noreferrer" target="_blank">Open web source</a></div>
      </article>
    );
  }
  return (
    <article className="assistant-source-card">
      <div><FileSearch size={18} /><strong>{source.displayName}</strong><Badge tone={source.liveStatus === "current" || !source.liveStatus ? "ready" : "busy"}>{source.liveStatus || "copied"}</Badge></div>
      <p>{source.excerpt}</p>
      <div><Button tone="ghost" onClick={() => onOpenCopied({ ...source, panelKind: "Copied source" })}>View copied excerpt</Button><Button tone="ghost" disabled={source.liveStatus && source.liveStatus !== "current"} onClick={() => onOpenCurrent(source)}>View current excerpt</Button></div>
    </article>
  );
}

function ConversationsPage({ conversations, total, busy, onOpen, onDelete, onLoadMore }) {
  const [query, setQuery] = useState("");
  const filtered = conversations.filter((entry) => !query || entry.title.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="assistant-page assistant-conversations-page">
      <header className="assistant-page-header"><div><span>Conversation management</span><h1>Conversations</h1><p>Review saved chats and remove the ones you no longer need. Long-term identity memory is managed separately.</p></div><Badge tone="safe">{total} saved</Badge></header>
      <div className="assistant-search"><Search size={18} /><input aria-label="Search conversations" onChange={(event) => setQuery(event.target.value)} placeholder="Search conversation titles" value={query} /></div>
      {filtered.length ? <div className="assistant-managed-conversation-list">{filtered.map((entry) => <article key={entry.id}><span className="assistant-file-icon"><MessageSquareText size={21} /></span><div><strong>{entry.title}</strong><small>Updated {relativeTime(entry.updatedAt)}</small></div><Button disabled={busy} onClick={() => onOpen(entry.id)} tone="ghost">Open</Button><Button aria-label={`Delete ${entry.title}`} disabled={busy} onClick={() => onDelete(entry)} tone="danger-ghost"><Trash2 size={15} /> Delete</Button></article>)}</div> : <EmptyState icon={MessageSquareText} title={query ? "No matching conversations" : "No saved conversations"}>{query ? "Try another title." : "New chats will appear here."}</EmptyState>}
      {conversations.length < total && <Button disabled={busy} onClick={onLoadMore}>Load more conversations</Button>}
    </div>
  );
}

function SourceExcerptDialog({ source, setSourcePanel }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSourcePanel(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialogRef.current.querySelectorAll('button:not([disabled]),a[href]')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [setSourcePanel]);
  return <div className="assistant-source-drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Source excerpt"><header><div><span>{source.panelKind || "Current source"}</span><strong>{source.displayName}</strong></div><button ref={closeRef} aria-label="Close source" onClick={() => setSourcePanel(null)} type="button"><X /></button></header><pre>{source.excerpt}</pre></div>;
}

function speechRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function desktopSpeechHost() {
  try {
    const host = window.chrome?.webview?.hostObjects?.magicBoxHost;
    return typeof host?.StartSpeechRecognition === "function" ? host : null;
  } catch {
    return null;
  }
}

function speechErrorMessage(code) {
  if (code === "not-allowed" || code === "service-not-allowed") return "Microphone access was not allowed. Enable it in Windows privacy settings and try again.";
  if (code === "audio-capture") return "No working microphone was found.";
  if (code === "language-not-supported") return "On-device speech recognition is not available for this language.";
  if (code === "no-speech") return "I didn't hear any speech. Try again a little closer to the microphone.";
  return "Voice input stopped unexpectedly. Please try again.";
}

function renderAssistantInline(text, keyPrefix) {
  const parts = String(text || "").split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/gu);
  return parts.filter(Boolean).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/u.exec(part);
    if (link) return <a href={link[2]} key={key} rel="noreferrer" target="_blank">{link[1]}</a>;
    return part;
  });
}

function AssistantMessageContent({ content }) {
  const lines = String(content || "").replace(/\r\n?/gu, "\n").split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (/^```/u.test(line.trim())) {
      const language = line.trim().slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/u.test(lines[index].trim())) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push(<pre key={`code-${blocks.length}`}><code data-language={language || undefined}>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line.trim());
    if (heading) {
      const Tag = `h${Math.min(4, heading[1].length + 2)}`;
      blocks.push(<Tag key={`heading-${blocks.length}`}>{renderAssistantInline(heading[2], `heading-${blocks.length}`)}</Tag>);
      index += 1;
      continue;
    }
    if (/^[-*]\s+/u.test(line.trim())) {
      const items = [];
      while (index < lines.length && /^[-*]\s+/u.test(lines[index].trim())) items.push(lines[index++].trim().replace(/^[-*]\s+/u, ""));
      blocks.push(<ul key={`list-${blocks.length}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderAssistantInline(item, `list-${blocks.length}-${itemIndex}`)}</li>)}</ul>);
      continue;
    }
    if (/^\d+[.)]\s+/u.test(line.trim())) {
      const items = [];
      while (index < lines.length && /^\d+[.)]\s+/u.test(lines[index].trim())) items.push(lines[index++].trim().replace(/^\d+[.)]\s+/u, ""));
      blocks.push(<ol key={`steps-${blocks.length}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderAssistantInline(item, `steps-${blocks.length}-${itemIndex}`)}</li>)}</ol>);
      continue;
    }
    if (/^>\s?/u.test(line.trim())) {
      const quotes = [];
      while (index < lines.length && /^>\s?/u.test(lines[index].trim())) quotes.push(lines[index++].trim().replace(/^>\s?/u, ""));
      blocks.push(<blockquote key={`quote-${blocks.length}`}>{renderAssistantInline(quotes.join(" "), `quote-${blocks.length}`)}</blockquote>);
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(?:```|#{1,3}\s+|[-*]\s+|\d+[.)]\s+|>\s?)/u.test(lines[index].trim())) paragraph.push(lines[index++].trim());
    blocks.push(<p key={`paragraph-${blocks.length}`}>{renderAssistantInline(paragraph.join(" "), `paragraph-${blocks.length}`)}</p>);
  }
  return <div className="assistant-answer-content">{blocks}</div>;
}

function AskPage({ capabilities, modelStatus, conversations, conversationTotal, onLoadMoreConversations, conversation, onNewConversation, onSelectConversation, onSend, onCancel, onOpenCurrentSource, asking, selectedItems, sourcePanel, setSourcePanel }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [preparingVoice, setPreparingVoice] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [bargeInAvailable, setBargeInAvailable] = useState(false);
  const [liveConversation, setLiveConversation] = useState(false);
  const [streamingReply, setStreamingReply] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [voiceReplies, setVoiceReplies] = useState(true);
  const voiceRepliesRef = useRef(true);
  const voiceTurnSpeechStoppedRef = useRef(false);
  const [voiceSettings, setVoiceSettings] = useState(readAssistantVoiceSettings);
  const [voicePreferencesHydrated, setVoicePreferencesHydrated] = useState(false);
  const recognitionRef = useRef(null);
  const nativeQuestionPrefixRef = useRef("");
  const replyAudioRef = useRef(null);
  const replyAudioStopRef = useRef(null);
  const replyVoiceControllerRef = useRef(null);
  const replyVoiceJobRef = useRef(null);
  const voiceQuestionRef = useRef(false);
  const voiceReplyBaselineRef = useRef(null);
  const speechRunRef = useRef(0);
  const liveConversationRef = useRef(false);
  const askingRef = useRef(asking);
  const questionRef = useRef("");
  const finalTranscriptRef = useRef("");
  const beginListeningRef = useRef(null);
  const streamedVoiceRef = useRef(false);
  const streamSpeechBufferRef = useRef("");
  const streamSpeechPlannerRef = useRef(new StreamingTextCommitter());
  const streamSpeechIdleTimerRef = useRef(null);
  const streamSpeechTailRef = useRef(Promise.resolve());
  const streamSpeechGenerationRef = useRef(0);
  const streamTtsSessionRef = useRef(null);
  const streamingReplyPendingRef = useRef("");
  const streamingReplyFlushTimerRef = useRef(null);
  const liveVoiceRef = useRef(null);
  const submitVoiceTurnRef = useRef(null);
  const systemSpeechControllerRef = useRef(null);
  const voiceTurnSequenceRef = useRef(0);
  const canAsk = capabilities?.chat === "ready" && modelStatus?.generation === "ready";

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      loadAssistantVoicePreferences({ signal: controller.signal }),
      assistantApi("/api/voice-clone/profiles", { signal: controller.signal }),
      assistantApi("/api/assistant/live-voice/health", { signal: controller.signal })
    ]).then(([persisted, profiles, health]) => {
      const availableProfiles = Array.isArray(profiles) ? profiles : [];
      let next = normalizedAssistantVoiceSettings(persisted);
      if (!persisted.configured) {
        const prepared = availableProfiles.find((profile) => profile?.conversationModel?.ready);
        if (prepared) next = { ...next, mode: "streaming", profileId: prepared.id };
      }
      if (persisted.degradedReason) setVoiceError(`Streaming voice is currently degraded: ${persisted.degradedReason}. Your selected voice preference was kept.`);
      setVoiceSettings(next);
      window.localStorage.setItem(ASSISTANT_VOICE_SETTINGS_KEY, JSON.stringify({ ...next, configured: undefined }));
      setVoicePreferencesHydrated(true);
    }).catch((error) => {
      if (error.name !== "AbortError") setVoiceError(`Voice preferences could not be loaded: ${error.message}`);
    }).finally(() => setVoicePreferencesHydrated(true));
    return () => controller.abort();
  }, []);

  useEffect(() => { liveConversationRef.current = liveConversation; }, [liveConversation]);
  useEffect(() => { askingRef.current = asking; }, [asking]);
  useEffect(() => { questionRef.current = question; }, [question]);

  useEffect(() => {
    if (!voicePreferencesHydrated || voiceSettings.mode !== "streaming" || !voiceSettings.profileId) return undefined;
    const controller = new AbortController();
    assistantApi(`/api/voice-clone/profiles/${encodeURIComponent(voiceSettings.profileId)}/conversation-model/warm`, { method: "POST", signal: controller.signal }).catch((error) => {
      if (error.name !== "AbortError") setVoiceError(`The streaming voice could not be warmed yet: ${error.message}`);
    });
    return () => controller.abort();
  }, [voicePreferencesHydrated, voiceSettings.mode, voiceSettings.profileId]);

  useEffect(() => {
    if (voiceSettings.mode !== "streaming") return undefined;
    setBargeInAvailable(false);
    const client = new LiveVoiceClient({
      onEvent: (event) => {
        if (event.type === "session.preparing") setPreparingVoice(true);
        if (event.type === "session.ready") {
          setPreparingVoice(false);
          setBargeInAvailable(event.features?.bargeIn === true);
          streamSpeechPlannerRef.current.setAdaptive(event.features?.adaptiveCommit === true);
          streamSpeechPlannerRef.current.setTextLeadController(event.features?.textLeadController === true);
        }
        if (event.type === "transcript.partial") setQuestion(event.text || "");
        if (event.type === "input.ended") {
          setListening(false);
          setTranscribing(true);
        }
        if (event.type === "transcript.final") {
          const transcript = String(event.text || "").trim();
          recognitionRef.current = null;
          setListening(false);
          setTranscribing(false);
          setQuestion(transcript);
          if (!transcript) setVoiceError("I didn't hear clear speech. Check the microphone level and try again.");
          else if (liveConversationRef.current) void submitVoiceTurnRef.current?.(transcript);
        }
        if (event.type === "turn.cancelled") setSpeaking(false);
        if (event.type === "warning") setVoiceError(event.message || "The local voice model reported a warning.");
      },
      onError: (error) => {
        setSpeaking(false);
        setListening(false);
        setTranscribing(false);
        setPreparingVoice(false);
        setBargeInAvailable(false);
        setVoiceError(`${error.message} Written chat is still available.`);
      },
      onPlayback: (event) => {
        if (event.type === "playback.diagnostic" || event.type === "diagnostic") {
          streamSpeechPlannerRef.current.setAudioAheadMs(event.bufferedMs || 0);
          streamSpeechPlannerRef.current.setTokenGapMs(event.tokenGapMs || 0);
        }
        if (event.speaking === true) setSpeaking(true);
        if (event.speaking === false) setSpeaking(false);
      }
    });
    liveVoiceRef.current = client;
    return () => {
      if (liveVoiceRef.current === client) liveVoiceRef.current = null;
      setBargeInAvailable(false);
      void client.close();
    };
  }, [voiceSettings.mode]);

  const stopSpeaking = useCallback(() => {
    speechRunRef.current += 1;
    streamSpeechGenerationRef.current += 1;
    streamTtsSessionRef.current = null;
    streamSpeechPlannerRef.current.reset();
    if (streamSpeechIdleTimerRef.current) window.clearTimeout(streamSpeechIdleTimerRef.current);
    streamSpeechIdleTimerRef.current = null;
    replyVoiceControllerRef.current?.abort();
    replyVoiceControllerRef.current = null;
    if (replyVoiceJobRef.current) {
      assistantApi(`/api/voice-clone/jobs/${encodeURIComponent(replyVoiceJobRef.current)}/cancel`, { method: "POST" }).catch(() => {});
      replyVoiceJobRef.current = null;
    }
    replyAudioRef.current?.pause();
    replyAudioRef.current = null;
    replyAudioStopRef.current?.();
    replyAudioStopRef.current = null;
    systemSpeechControllerRef.current?.abort();
    systemSpeechControllerRef.current = null;
    window.speechSynthesis?.cancel();
    liveVoiceRef.current?.cancel("stop-speaking");
    setSpeaking(false);
  }, []);

  const speak = useCallback(async (text) => {
    if (!text?.trim()) return;
    const runId = speechRunRef.current + 1;
    speechRunRef.current = runId;
    if (voiceSettings.mode === "streaming" && voiceSettings.profileId) {
      setSpeaking(true);
      setVoiceError("");
      try {
        const spokenText = renderSpokenText(text, { mode: "spoken", final: true });
        let lastError;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const activeTurn = await liveVoiceRef.current?.startTts(voiceSettings);
            if (!activeTurn || speechRunRef.current !== runId) return;
            liveVoiceRef.current?.appendText(spokenText);
            const playback = liveVoiceRef.current?.waitForPlayback(activeTurn);
            liveVoiceRef.current?.commitText();
            await playback;
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (error.name === "AbortError") throw error;
            liveVoiceRef.current?.cancel("retry-streaming-chunk");
          }
        }
        if (lastError) throw lastError;
      } catch (error) {
        if (error.name === "AbortError") return;
        setSpeaking(false);
        setVoiceError(`${error.message} Written chat is still available.`);
      }
      return;
    }
    if (voiceSettings.mode === "trained" && voiceSettings.profileId) {
      replyVoiceControllerRef.current?.abort();
      replyAudioRef.current?.pause();
      const controller = new AbortController();
      replyVoiceControllerRef.current = controller;
      setSpeaking(true);
      setVoiceError("");
      try {
        for (const chunk of splitConversationSpeech(text)) {
          if (controller.signal.aborted || speechRunRef.current !== runId) return;
          const output = await generateTrainedVoice(chunk, { ...voiceSettings, conversationMode: true }, {
            signal: controller.signal,
            onJob: (job) => { replyVoiceJobRef.current = job.id; }
          });
          if (controller.signal.aborted || speechRunRef.current !== runId) return;
          replyVoiceJobRef.current = null;
          await new Promise((resolve, reject) => {
            const audio = new Audio(output.audioUrl);
            replyAudioRef.current = audio;
            let settled = false;
            const finish = (callback) => {
              if (settled) return;
              settled = true;
              replyAudioStopRef.current = null;
              callback();
            };
            replyAudioStopRef.current = () => { audio.pause(); finish(resolve); };
            audio.onended = () => finish(resolve);
            audio.onerror = () => finish(() => reject(new Error("The trained reply was generated, but its local audio could not be played.")));
            Promise.resolve(audio.play()).catch(reject);
          });
          replyAudioRef.current = null;
        }
      } catch (error) {
        if (error.name === "AbortError") return;
        setVoiceError(error.message);
      } finally {
        if (speechRunRef.current === runId) {
          replyVoiceControllerRef.current = null;
          replyVoiceJobRef.current = null;
          replyAudioRef.current = null;
          setSpeaking(false);
        }
      }
      return;
    }
    systemSpeechControllerRef.current?.abort();
    const controller = new AbortController();
    systemSpeechControllerRef.current = controller;
    setSpeaking(true);
    setVoiceError("");
    try {
      await speakSystemText(text, voiceSettings, { signal: controller.signal });
    } catch (error) {
      if (error.name !== "AbortError") setVoiceError(error.message);
    } finally {
      if (speechRunRef.current === runId) setSpeaking(false);
      if (systemSpeechControllerRef.current === controller) systemSpeechControllerRef.current = null;
    }
  }, [voiceSettings]);

  useEffect(() => {
    if (asking || !voiceQuestionRef.current) return;
    const latestReply = [...(conversation?.messages || [])].reverse().find((message) => message.role === "assistant");
    if (!latestReply || latestReply.id === voiceReplyBaselineRef.current) return;
    if (streamedVoiceRef.current) {
      streamedVoiceRef.current = false;
      voiceQuestionRef.current = false;
      return;
    }
    if (voiceQuestionRef.current && voiceReplies && latestReply) {
      void speak(latestReply.content).finally(() => {
        if (liveConversationRef.current) window.setTimeout(() => beginListeningRef.current?.(), 180);
      });
    } else if (liveConversationRef.current) {
      window.setTimeout(() => beginListeningRef.current?.(), 180);
    }
    voiceQuestionRef.current = false;
  }, [asking, conversation, speak, voiceReplies]);

  const queueStreamSpeech = useCallback((delta = "", { flush = false, idle = false } = {}) => {
    const planner = streamSpeechPlannerRef.current;
    let chunks = delta ? planner.append(delta) : [];
    if (idle) chunks = [...chunks, ...planner.flushIdle()];
    if (flush) chunks = [...chunks, ...planner.finish()];
    if (streamSpeechIdleTimerRef.current) window.clearTimeout(streamSpeechIdleTimerRef.current);
    streamSpeechIdleTimerRef.current = null;
    if (delta && !flush) {
      streamSpeechIdleTimerRef.current = window.setTimeout(() => {
        streamSpeechIdleTimerRef.current = null;
        void queueStreamSpeech("", { idle: true });
      }, 700);
    }
    const generation = streamSpeechGenerationRef.current;
    for (const chunk of chunks) {
      streamedVoiceRef.current = true;
      if (voiceSettings.mode === "streaming" && voiceSettings.profileId) {
        streamSpeechTailRef.current = streamSpeechTailRef.current.catch(() => {}).then(async () => {
          if (generation !== streamSpeechGenerationRef.current) return;
          let session = streamTtsSessionRef.current;
          if (!session || session.generation !== generation) {
            setSpeaking(true);
            setVoiceError("");
            const turnId = await liveVoiceRef.current?.startTts(voiceSettings);
            if (!turnId || generation !== streamSpeechGenerationRef.current) {
              liveVoiceRef.current?.cancel("stale-streamed-reply");
              return;
            }
            session = { generation, turnId, playback: liveVoiceRef.current.waitForPlayback(turnId) };
            streamTtsSessionRef.current = session;
          }
          liveVoiceRef.current?.appendSegment(chunk.text, { boundary: chunk.boundary });
        }).catch((error) => {
          if (generation !== streamSpeechGenerationRef.current || error.name === "AbortError") return;
          streamTtsSessionRef.current = null;
          setSpeaking(false);
          setVoiceError(`${error.message} Written chat is still available.`);
        });
      } else {
        streamSpeechTailRef.current = streamSpeechTailRef.current.catch(() => {}).then(() => generation === streamSpeechGenerationRef.current ? speak(chunk.text) : undefined);
      }
    }
    if (flush && voiceSettings.mode === "streaming" && voiceSettings.profileId) {
      streamSpeechTailRef.current = streamSpeechTailRef.current.catch(() => {}).then(async () => {
        const session = streamTtsSessionRef.current;
        if (!session || session.generation !== generation || generation !== streamSpeechGenerationRef.current) return;
        liveVoiceRef.current?.commitReply();
        try {
          await session.playback;
        } finally {
          if (streamTtsSessionRef.current === session) streamTtsSessionRef.current = null;
        }
      }).catch((error) => {
        if (generation !== streamSpeechGenerationRef.current || error.name === "AbortError") return;
        streamTtsSessionRef.current = null;
        setSpeaking(false);
        setVoiceError(`${error.message} Written chat is still available.`);
      });
    }
    return streamSpeechTailRef.current;
  }, [speak, voiceSettings]);

  const flushStreamingReply = useCallback(() => {
    if (streamingReplyFlushTimerRef.current) window.clearTimeout(streamingReplyFlushTimerRef.current);
    streamingReplyFlushTimerRef.current = null;
    const pending = streamingReplyPendingRef.current;
    if (!pending) return;
    streamingReplyPendingRef.current = "";
    setStreamingReply((current) => `${current}${pending}`);
  }, []);

  const queueStreamingReplyDelta = useCallback((delta = "") => {
    streamingReplyPendingRef.current += String(delta || "");
    if (streamingReplyFlushTimerRef.current) return;
    streamingReplyFlushTimerRef.current = window.setTimeout(() => flushStreamingReply(), 50);
  }, [flushStreamingReply]);

  const submitVoiceTurn = useCallback(async (transcript) => {
    const sent = String(transcript || "").trim();
    if (!sent || askingRef.current) return;
    const voiceTurn = ++voiceTurnSequenceRef.current;
    voiceTurnSpeechStoppedRef.current = false;
    voiceQuestionRef.current = true;
    voiceReplyBaselineRef.current = [...(conversation?.messages || [])].reverse().find((message) => message.role === "assistant")?.id || null;
    finalTranscriptRef.current = "";
    streamedVoiceRef.current = false;
    streamSpeechBufferRef.current = "";
    streamSpeechPlannerRef.current.reset();
    if (streamSpeechIdleTimerRef.current) window.clearTimeout(streamSpeechIdleTimerRef.current);
    streamSpeechIdleTimerRef.current = null;
    streamSpeechTailRef.current = Promise.resolve();
    streamTtsSessionRef.current = null;
    streamSpeechGenerationRef.current += 1;
    flushStreamingReply();
    setStreamingReply("");
    setQuestion("");
    try {
      await onSend(sent, {
        stream: true,
        onlineSearch: "auto",
        resourceProfile: "voice",
        onResourceState: (state) => setPreparingVoice(state === "preparing"),
        onDelta: (delta) => {
          if (voiceTurn !== voiceTurnSequenceRef.current) return;
          queueStreamingReplyDelta(delta);
          if (voiceRepliesRef.current && !voiceTurnSpeechStoppedRef.current) queueStreamSpeech(delta);
        },
        onReset: () => {
          stopSpeaking();
          streamedVoiceRef.current = false;
          streamSpeechBufferRef.current = "";
          streamSpeechPlannerRef.current.reset();
          if (streamSpeechIdleTimerRef.current) window.clearTimeout(streamSpeechIdleTimerRef.current);
          streamSpeechIdleTimerRef.current = null;
          streamSpeechTailRef.current = Promise.resolve();
          streamTtsSessionRef.current = null;
          streamingReplyPendingRef.current = "";
          setStreamingReply("");
        }
      });
      if (voiceTurn !== voiceTurnSequenceRef.current) return;
      await queueStreamSpeech("", { flush: true });
      flushStreamingReply();
      setStreamingReply("");
      if (liveConversationRef.current) window.setTimeout(() => beginListeningRef.current?.(), 180);
    } catch {
      setStreamingReply("");
      setQuestion(sent);
    } finally {
      setPreparingVoice(false);
    }
  }, [conversation, flushStreamingReply, onSend, queueStreamSpeech, queueStreamingReplyDelta, stopSpeaking, voiceReplies, voiceSettings]);
  submitVoiceTurnRef.current = submitVoiceTurn;

  useEffect(() => {
    const webview = window.chrome?.webview;
    if (!webview?.addEventListener) return undefined;
    const onMessage = (event) => {
      if (typeof event.data !== "string" || !event.data.startsWith("magic-box:speech:")) return;
      const payload = event.data.slice("magic-box:speech:".length);
      if (payload === "started") {
        setListening(true);
        return;
      }
      if (payload === "stopped") {
        setListening(false);
        recognitionRef.current = null;
        return;
      }
      if (payload.startsWith("result:")) {
        const transcript = payload.slice("result:".length).trim();
        const prefix = nativeQuestionPrefixRef.current;
        const completeTranscript = [prefix, transcript].filter(Boolean).join(prefix && transcript ? " " : "");
        setQuestion(completeTranscript);
        setListening(false);
        recognitionRef.current = null;
        if (liveConversationRef.current) void submitVoiceTurn(completeTranscript);
        return;
      }
      if (payload.startsWith("error:")) {
        const separator = payload.indexOf(":", "error:".length);
        const message = separator >= 0 ? payload.slice(separator + 1) : "Offline voice input stopped unexpectedly. Please try again.";
        setVoiceError(message);
        setListening(false);
        recognitionRef.current = null;
      }
    };
    webview.addEventListener("message", onMessage);
    return () => webview.removeEventListener?.("message", onMessage);
  }, [submitVoiceTurn]);

  useEffect(() => () => {
    liveConversationRef.current = false;
    voiceTurnSequenceRef.current += 1;
    if (streamingReplyFlushTimerRef.current) window.clearTimeout(streamingReplyFlushTimerRef.current);
    recognitionRef.current?.abort?.();
    stopSpeaking();
  }, [stopSpeaking]);

  async function toggleListening() {
    if (listening) {
      if (voiceSettings.mode === "streaming") {
        liveVoiceRef.current?.stopInput();
      } else {
        recognitionRef.current?.stop?.();
      }
      return;
    }
    if (askingRef.current && liveConversationRef.current) onCancel();
    setVoiceError("");
    setTranscribing(false);
    const keepReplyForBargeIn = voiceSettings.mode === "streaming"
      && bargeInAvailable
      && liveVoiceRef.current?.canBargeIn?.() === true;
    if (!keepReplyForBargeIn) stopSpeaking();
    if (voiceSettings.mode === "streaming") {
      if (!voiceSettings.profileId) {
        setVoiceError("Choose a prepared local voice in Voice settings first.");
        return;
      }
      try {
        setPreparingVoice(true);
        await liveVoiceRef.current?.startInput(voiceSettings);
        recognitionRef.current = { stop: () => liveVoiceRef.current?.stopInput(), abort: () => liveVoiceRef.current?.cancel("microphone-abort") };
        setListening(true);
      } catch (error) {
        recognitionRef.current = null;
        setListening(false);
        setTranscribing(false);
        setVoiceError(`${error.message} No microphone audio left this device.`);
      } finally {
        setPreparingVoice(false);
      }
      return;
    }
    const nativeHost = desktopSpeechHost();
    if (nativeHost) {
      nativeQuestionPrefixRef.current = question.trim();
      recognitionRef.current = {
        native: true,
        stop: () => nativeHost.StopSpeechRecognition(),
        abort: () => nativeHost.StopSpeechRecognition()
      };
      setListening(true);
      try {
        await nativeHost.StartSpeechRecognition(navigator.language || "en-US");
      } catch {
        recognitionRef.current = null;
        setListening(false);
        setVoiceError("Windows offline voice input could not start. Check the microphone and try again.");
      }
      return;
    }
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setVoiceError("On-device voice input is not supported by this runtime. You can still type your question.");
      return;
    }

    const language = navigator.language || "en-US";
    if (typeof Recognition.available === "function") {
      try {
        let availability = await Recognition.available({ langs: [language], processLocally: true });
        if (availability === "downloadable" && typeof Recognition.install === "function") {
          const installed = await Recognition.install({ langs: [language] });
          availability = installed ? "available" : "unavailable";
        }
        if (availability !== "available") {
          setVoiceError(availability === "downloading"
            ? "The on-device speech language pack is still downloading. Try again in a moment."
            : "On-device speech recognition is unavailable for this language. No audio was sent to a cloud service.");
          return;
        }
      } catch {
        setVoiceError("The on-device speech language pack could not be prepared. No audio was sent to a cloud service.");
        return;
      }
    }

    const recognition = new Recognition();
    if (!("processLocally" in recognition)) {
      setVoiceError("This runtime cannot guarantee on-device recognition, so voice input was not started.");
      return;
    }
    recognition.processLocally = true;
    recognition.lang = language;
    recognition.continuous = false;
    recognition.interimResults = true;
    const originalQuestion = question.trim();
    recognition.onstart = () => setListening(true);
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript || "").join(" ").trim();
      setQuestion([originalQuestion, transcript].filter(Boolean).join(originalQuestion && transcript ? " " : ""));
      if (liveConversationRef.current && Array.from(event.results).every((result) => result.isFinal !== false)) {
        finalTranscriptRef.current = [originalQuestion, transcript].filter(Boolean).join(originalQuestion && transcript ? " " : "");
        recognition.stop();
      }
    };
    recognition.onerror = (event) => {
      if (event.error !== "aborted") setVoiceError(speechErrorMessage(event.error));
      setListening(false);
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
      const transcript = finalTranscriptRef.current;
      if (liveConversationRef.current && transcript) void submitVoiceTurn(transcript);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setVoiceError("The microphone is already busy. Wait a moment and try again.");
      setListening(false);
    }
  }
  beginListeningRef.current = () => {
    if (!liveConversationRef.current || askingRef.current || recognitionRef.current) return;
    void toggleListening();
  };

  function startLiveConversation() {
    liveConversationRef.current = true;
    setLiveConversation(true);
    setVoiceReplies(true);
    voiceRepliesRef.current = true;
    finalTranscriptRef.current = "";
    window.setTimeout(() => beginListeningRef.current?.(), 0);
  }

  function stopLiveConversation() {
    voiceTurnSequenceRef.current += 1;
    voiceQuestionRef.current = false;
    if (askingRef.current) onCancel();
    liveConversationRef.current = false;
    setLiveConversation(false);
    finalTranscriptRef.current = "";
    recognitionRef.current?.abort?.();
    recognitionRef.current = null;
    setListening(false);
    setTranscribing(false);
    setPreparingVoice(false);
    stopSpeaking();
  }
  function startNewConversation() {
    stopLiveConversation();
    setQuestion("");
    setStreamingReply("");
    setVoiceError("");
    onNewConversation();
  }
  function stopCurrentReply() {
    voiceTurnSpeechStoppedRef.current = true;
    voiceQuestionRef.current = false;
    stopSpeaking();
  }
  async function submit(event) {
    event.preventDefault();
    if (!question.trim() || asking) return;
    const sent = question;
    recognitionRef.current?.stop?.();
    recognitionRef.current = null;
    const automaticSpeechAvailable = (voiceSettings.mode === "streaming" && Boolean(voiceSettings.profileId)) || (voiceSettings.mode === "trained" && Boolean(voiceSettings.profileId)) || ("speechSynthesis" in window);
    if (voiceReplies && automaticSpeechAvailable) {
      await submitVoiceTurn(sent);
      return;
    }
    voiceQuestionRef.current = false;
    setQuestion("");
    await onSend(sent, { onlineSearch: "auto" }).catch(() => setQuestion(sent));
  }
  return (
    <div className={`assistant-page assistant-ask-layout ${historyOpen ? "has-history" : ""}`}>
      {historyOpen && <aside className="assistant-conversation-list" aria-label="最近对话"><div><strong>最近对话</strong><Button aria-label="关闭历史" onClick={() => setHistoryOpen(false)} tone="ghost"><X size={16} /></Button></div>{!conversations.length && <p>还没有历史对话</p>}{conversations.map((entry) => <button disabled={asking} className={conversation?.id === entry.id ? "is-active" : ""} key={entry.id} onClick={() => { stopLiveConversation(); onSelectConversation(entry.id); setHistoryOpen(false); }} type="button"><MessageSquareText size={16} /><span>{entry.title}</span><ChevronRight size={15} /></button>)}{conversations.length < conversationTotal && <Button tone="ghost" onClick={onLoadMoreConversations}>加载更多</Button>}</aside>}
      <section className="assistant-chat-panel">
        <header><h1>{conversation?.title || "新对话"}</h1><div className="assistant-live-controls"><Button aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)} tone="ghost"><Clock3 size={16} /> 历史</Button><Button disabled={asking} onClick={startNewConversation}><Plus size={16} /> 新建对话</Button></div></header>
        <div className="assistant-messages">
          {conversation?.messages?.length ? conversation.messages.map((message) => (
            <article className={`assistant-message assistant-message-${message.role}`} key={message.id}>
              <span>{message.role === "assistant" ? <Bot size={18} /> : "You"}</span>
              <div>{message.role === "assistant" ? <AssistantMessageContent content={message.content} /> : <p>{message.content}</p>}{message.role === "assistant" && <div className="assistant-message-meta"><Badge tone={message.grounding === "workspace" ? "ready" : "neutral"}>{message.grounding}</Badge>{message.model && <span>{message.model}</span>}<button aria-label={speaking ? "Stop reading reply" : "Read reply aloud"} className="assistant-speak-button" onClick={() => speaking ? stopCurrentReply() : speak(message.content)} type="button">{speaking ? <VolumeX size={15} /> : <Volume2 size={15} />}{speaking ? "Stop" : "Listen"}</button></div>}{message.sources?.map((source) => <SourceCard key={source.chunkId} onOpenCopied={setSourcePanel} onOpenCurrent={onOpenCurrentSource} source={source} />)}</div>
            </article>
          )) : <EmptyState icon={MessageSquareText} title="今天想聊些什么？" action={<div className="assistant-starters"><Button disabled={!canAsk} onClick={() => setQuestion("帮我梳理思路：")}>帮我梳理思路</Button><Button disabled={!canAsk} onClick={() => setQuestion("请用简单的话解释这个概念：")}>解释一个概念</Button></div>}>输入问题，或开启语音对话。</EmptyState>}
          {asking && <article className="assistant-message assistant-message-assistant"><span><Loader2 className="spin" size={18} /></span><div>{streamingReply ? <AssistantMessageContent content={streamingReply} /> : <p>Understanding your question and checking the best available sources…</p>}</div></article>}
        </div>
        {!canAsk && <div className="assistant-notice"><CircleAlert size={18} /><div><strong>A local model must be installed and active.</strong><span>Inbox and keyword search remain usable without it.</span></div></div>}
        <form className="assistant-composer" onSubmit={submit}>
          <div className={`assistant-voice-input ${listening ? "is-listening" : ""}`}>
            <textarea aria-label="消息" disabled={!canAsk} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (canAsk && question.trim() && !asking) event.currentTarget.form.requestSubmit(); } }} placeholder="输入消息…" rows={3} value={question} />
            <button aria-label={listening ? "Stop voice input" : speaking && liveConversation && bargeInAvailable ? "Interrupt and speak" : "Start voice input"} className="assistant-mic-button" disabled={!canAsk || preparingVoice || transcribing || (asking && !liveConversation)} onClick={toggleListening} type="button"><Mic size={19} /></button>
          </div>
          {liveConversation && <div className="assistant-live-status" role="status"><span className="assistant-live-dot" /><strong>{preparingVoice ? "Preparing local voice conversation" : listening ? "Listening" : transcribing ? "Transcribing" : speaking ? "Speaking" : asking ? "Thinking" : "Ready"}</strong><span>{preparingVoice ? "Loading the CPU conversation worker and local voice models." : listening ? "Speak naturally, then pause. Your turn sends automatically." : transcribing ? "Converting your speech locally." : speaking ? (bargeInAvailable ? "Use the microphone to interrupt." : "Stop the reply before starting microphone input.") : asking ? "Preparing the next spoken turn." : "Your voice session stays open."}</span></div>}
          {!liveConversation && listening && <div className="assistant-voice-status" role="status"><i /><span>Listening on this device… Click the microphone when you’re done.</span></div>}
          {voiceError && <div className="assistant-voice-error" role="alert"><CircleAlert size={15} /><span>{voiceError}</span><button aria-label="Dismiss voice error" onClick={() => setVoiceError("")} type="button"><X size={14} /></button></div>}
          <div className="assistant-compose-actions"><Button aria-pressed={liveConversation} disabled={!canAsk || !voicePreferencesHydrated} onClick={liveConversation ? stopLiveConversation : startLiveConversation} tone="ghost">{liveConversation ? <><Square size={16} /> 结束语音对话</> : <><Mic size={17} /> 开始语音对话</>}</Button><label className="assistant-voice-toggle"><input checked={voiceReplies} disabled={liveConversation} onChange={(event) => { voiceRepliesRef.current = event.target.checked; setVoiceReplies(event.target.checked); if (!event.target.checked) stopCurrentReply(); }} type="checkbox" />自动朗读回复</label>{speaking && <Button aria-label="停止朗读" onClick={stopCurrentReply} tone="ghost"><VolumeX size={16} /></Button>}{asking && <Button onClick={() => { stopLiveConversation(); onCancel(); }}><Square size={15} /> 取消</Button>}<Button disabled={!canAsk || !question.trim() || asking} tone="primary" type="submit"><Send size={17} /> 发送</Button></div>
          {selectedItems.length > 0 && <small>已选择 {selectedItems.length} 份知识库资料</small>}
        </form>
        <footer className="assistant-chat-footer"><a href="#/assistant/voice">声音设置</a><span>·</span><span title="模型推理与语音在本地处理；需要时会检索公开网页。">本地处理</span></footer>
      </section>
      {sourcePanel && <SourceExcerptDialog setSourcePanel={setSourcePanel} source={sourcePanel} />}
    </div>
  );
}

function ModelsPage({ models, status, onInstall, onActivate, onRemove, busy }) {
  return (
    <div className="assistant-page">
      <header className="assistant-page-header"><div><span>Managed local AI</span><h1>Models</h1><p>The chat model writes answers. The optional retrieval model only helps find meaning inside your indexed local files.</p></div><Badge tone="safe"><ShieldCheck size={14} /> No cloud fallback</Badge></header>
      <div className="assistant-model-status"><article><span>Chat & generation</span><strong>{status?.generation || "not-installed"}</strong><small>{status?.activeModels?.generation || "Required for answers"}</small></article><article><span>Knowledge retrieval (optional)</span><strong>{status?.embeddings || "not-installed"}</strong><small>{status?.activeModels?.embeddings || "Exact keyword search remains available"}</small></article></div>
      <div className="assistant-model-grid">
        {models.map((model) => (
          <article className="assistant-model-card" key={model.id}>
            <div className="assistant-model-art"><BrainCircuit size={30} /></div>
            <div className="assistant-model-heading"><div><span>{model.capability === "generation" ? "chat & generation" : "semantic file search · optional"}</span><h2>{model.displayName}</h2></div><Badge tone={model.active ? "ready" : model.installState === "ready" ? "busy" : "neutral"}>{model.active ? "active" : model.installState}</Badge></div>
            <p>{model.capability === "generation" ? (model.id === "qwen3.5-9b-q4-k-m" ? "Writes multilingual replies and handles reasoning, accelerated locally on the GPU." : "A smaller low-memory fallback for local answers and live conversation.") : "Does not generate answers or speech. It maps file passages and questions by meaning, so related content can be found even when the wording differs."}</p>
            <dl><div><dt>Download</dt><dd>{(model.sizeBytes / 1024 ** 3).toFixed(model.sizeBytes > 1024 ** 3 ? 1 : 2)} GiB</dd></div><div><dt>Recommended RAM</dt><dd>{Math.round(model.memory.recommendedRamBytes / 1024 ** 3)} GiB</dd></div><div><dt>License</dt><dd>{model.license.id}</dd></div></dl>
            <div className="assistant-card-actions">
              {model.installState !== "ready" ? <Button disabled={busy} tone="primary" onClick={() => onInstall(model)}><Database size={16} /> Review & install</Button> : model.active ? <Button disabled={busy} onClick={() => onActivate(model.capability, null)}><Pause size={16} /> Deactivate</Button> : <Button disabled={busy} tone="primary" onClick={() => onActivate(model.capability, model.id)}><Play size={16} /> Activate</Button>}
              {model.installState === "ready" && !model.active && <Button disabled={busy} tone="danger-ghost" onClick={() => onRemove(model.id)}><Trash2 size={16} /> Remove</Button>}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function ActivityRow({ record, onUndo }) {
  return (
    <article className="assistant-activity-row">
      <span className={`assistant-timeline-dot is-${record.status}`} />
      <div><div><strong>{record.summary}</strong><Badge tone={record.status === "completed" ? "ready" : record.status === "failed" ? "error" : "busy"}>{record.status}</Badge></div><p>{record.action} · {relativeTime(record.createdAt)}</p>{record.counts && <small>{record.counts.completed || 0} completed · {record.counts.failed || 0} failed · {record.counts.skipped || 0} skipped</small>}</div>
      {record.undo?.eligible && <Button tone="ghost" onClick={() => onUndo?.(record.id)}><RotateCcw size={15} /> Undo</Button>}
    </article>
  );
}

function ActivityPage({ records, total, onLoadMore, onUndo }) {
  const [filter, setFilter] = useState("all");
  const visible = filter === "all" ? records : records.filter((record) => record.status === filter);
  return <div className="assistant-page"><header className="assistant-page-header"><div><span>Local audit trail</span><h1>Activity</h1><p>See what the Assistant did, what failed, and which safe actions are still undoable.</p></div><select aria-label="Filter Activity" onChange={(event) => setFilter(event.target.value)} value={filter}><option value="all">All statuses</option><option value="completed">Completed</option><option value="partial">Partial</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></header>{visible.length ? <div className="assistant-activity-list">{visible.map((record) => <ActivityRow key={record.id} onUndo={onUndo} record={record} />)}</div> : <EmptyState icon={Activity} title="No matching Activity">Changes and background work will appear here.</EmptyState>}{records.length < total && <Button onClick={onLoadMore}>Load more Activity</Button>}</div>;
}

function AutomationsPage({ recipes, items, roots, selectedItems, onCreate, onEnable, onDisable, onPreview, onApproveExecute, plan, busy }) {
  const [name, setName] = useState("Organize selected items");
  const [actionType, setActionType] = useState("tag");
  const [tag, setTag] = useState("reviewed");
  const [destinationRootId, setDestinationRootId] = useState(roots[0]?.id || "");
  useEffect(() => { if (!destinationRootId && roots[0]?.id) setDestinationRootId(roots[0].id); }, [destinationRootId, roots]);
  function draft() {
    const action = actionType === "tag" ? { type: "tag", add: [tag], remove: [] }
      : actionType === "summary" ? { type: "summary" }
        : actionType === "rename" ? { type: "rename", template: "{name} - organized.{extension}" }
          : { type: actionType, destinationRootId };
    return { name, mode: "suggest", trigger: { type: "manual" }, conditions: [], actions: [action] };
  }
  return (
    <div className="assistant-page">
      <header className="assistant-page-header"><div><span>Constrained local workflows</span><h1>Automations</h1><p>Nothing consequential runs without a preview. Move and rename always require per-run approval.</p></div><Badge tone="safe"><ShieldCheck size={14} /> No delete or overwrite</Badge></header>
      <div className="assistant-automation-layout">
        <section className="assistant-panel"><div className="assistant-section-heading"><div><span>Recipe builder</span><h2>Create a safe recipe</h2></div></div><label>Recipe name<input onChange={(event) => setName(event.target.value)} value={name} /></label><label>Action<select onChange={(event) => setActionType(event.target.value)} value={actionType}><option value="tag">Add a tag</option><option value="summary">Create local summary</option><option value="copy">Copy to approved folder</option><option value="move">Move within same volume</option><option value="rename">Rename deterministically</option></select></label>{actionType === "tag" && <label>Tag<input onChange={(event) => setTag(event.target.value)} value={tag} /></label>}{["copy", "move"].includes(actionType) && <label>Destination root<select onChange={(event) => setDestinationRootId(event.target.value)} value={destinationRootId}><option value="">Choose approved root</option>{roots.map((root) => <option key={root.id} value={root.id}>{root.path}</option>)}</select></label>}<Button disabled={busy || !name.trim()} tone="primary" onClick={() => onCreate(draft())}><Plus size={16} /> Save disabled recipe</Button></section>
        <section className="assistant-panel"><div className="assistant-section-heading"><div><span>Saved recipes</span><h2>{recipes.length} recipe(s)</h2></div></div>{recipes.length ? recipes.map((recipe) => <article className="assistant-recipe-card" key={recipe.id}><div><strong>{recipe.name}</strong><Badge tone={recipe.enabled ? "ready" : "neutral"}>{recipe.enabled ? "enabled" : "disabled"}</Badge></div><p>{recipe.actions.map((action) => action.type).join(" → ")} · revision {recipe.revision}</p><div>{recipe.enabled ? <Button tone="ghost" onClick={() => onDisable(recipe.id)}><Pause size={15} /> Disable</Button> : <Button tone="ghost" onClick={() => onEnable(recipe)}><Play size={15} /> Enable</Button>}<Button disabled={!recipe.enabled || !selectedItems.length || busy} tone="primary" onClick={() => onPreview(recipe.id)}><FileSearch size={15} /> Preview {selectedItems.length || "selected"}</Button></div></article>) : <EmptyState icon={WandSparkles} title="No recipes yet">Create one here. It starts disabled and inert.</EmptyState>}</section>
      </div>
      {plan && <section className="assistant-plan"><div className="assistant-section-heading"><div><span>Immutable preview</span><h2>{plan.operations.length} planned operation(s)</h2></div><Badge tone="busy">expires {relativeTime(plan.expiresAt)}</Badge></div>{plan.operations.map((operation, index) => <article key={`${operation.itemId}-${index}`}><span>{index + 1}</span><div><strong>{operation.action.type}</strong><p>{operation.before.path}</p>{operation.after.path !== operation.before.path && <p>→ {operation.after.path}</p>}</div></article>)}<Button disabled={busy || !plan.recipeId} tone="primary" onClick={() => onApproveExecute(plan)}><ShieldCheck size={17} /> Approve exact plan & execute</Button></section>}
    </div>
  );
}

function IntegrationsPage({ integrations, onToggle, busy }) {
  return <div className="assistant-page"><header className="assistant-page-header"><div><span>Existing Magic Box tools</span><h1>Integrations</h1><p>Each handoff is disabled by default and limited to completed outputs inside one approved folder.</p></div></header><div className="assistant-integration-grid">{integrations.map((integration) => <article className="assistant-integration-card" key={integration.toolId}><span className="assistant-file-icon"><Copy size={23} /></span><div><h2>{TOOL_LABELS[integration.toolId]}</h2><p>{integration.enabled ? integration.outputRootPath : "Completed outputs are not sent to Assistant."}</p></div><Badge tone={integration.enabled ? "ready" : "neutral"}>{integration.enabled ? "enabled" : "off"}</Badge><dl><div><dt>Pending</dt><dd>{integration.pendingCount}</dd></div><div><dt>Failed</dt><dd>{integration.failedCount}</dd></div><div><dt>Grant</dt><dd>v{integration.generation}</dd></div></dl><Button disabled={busy} tone={integration.enabled ? "danger-ghost" : "primary"} onClick={() => onToggle(integration)}>{integration.enabled ? <><X size={16} /> Disable</> : <><FolderOpen size={16} /> Choose folder & enable</>}</Button></article>)}</div></div>;
}

function VoiceSettingsPage() {
  const [settings, setSettings] = useState(readAssistantVoiceSettings);
  const [profiles, setProfiles] = useState([]);
  const [systemVoices, setSystemVoices] = useState([]);
  const [previewText, setPreviewText] = useState("Hello. I’m your private assistant, running locally on this device.");
  const [previewing, setPreviewing] = useState(false);
  const [previewJob, setPreviewJob] = useState(null);
  const [previewOutput, setPreviewOutput] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [warmState, setWarmState] = useState("idle");
  const [warmAttempt, setWarmAttempt] = useState(0);
  const [streamHealth, setStreamHealth] = useState(null);
  const [firstAudioLatency, setFirstAudioLatency] = useState(null);
  const previewControllerRef = useRef(null);
  const previewAudioRef = useRef(null);
  const previewJobRef = useRef(null);
  const previewLiveVoiceRef = useRef(null);
  const previewStartedAtRef = useRef(0);

  const readyProfiles = profiles;
  const selectedProfile = profiles.find((profile) => profile.id === settings.profileId) || null;
  const referenceCandidates = (selectedProfile?.conversationModel?.referenceDiagnostics || []).map((diagnostic) => {
    for (const sample of selectedProfile?.samples || []) {
      const segment = (sample.segments || []).find((item) => item.id === diagnostic.segmentId);
      if (segment) return { diagnostic, segment };
    }
    return { diagnostic, segment: null };
  });

  const stopPreview = useCallback(() => {
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
    if (previewJobRef.current) {
      assistantApi(`/api/voice-clone/jobs/${encodeURIComponent(previewJobRef.current)}/cancel`, { method: "POST" }).catch(() => {});
      previewJobRef.current = null;
    }
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;
    window.speechSynthesis?.cancel();
    previewLiveVoiceRef.current?.cancel("preview-stop");
    setPreviewing(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      assistantApi("/api/voice-clone/profiles", { signal: controller.signal }),
      assistantApi("/api/assistant/live-voice/health", { signal: controller.signal }),
      loadAssistantVoicePreferences({ signal: controller.signal })
    ])
      .then(([items, health, persisted]) => {
        const availableProfiles = Array.isArray(items) ? items : [];
        let next = normalizedAssistantVoiceSettings(persisted);
        if (!persisted.configured) {
          const prepared = availableProfiles.find((profile) => profile?.conversationModel?.ready);
          if (prepared) next = { ...next, mode: "streaming", profileId: prepared.id };
        }
        if (persisted.degradedReason) setVoiceError(`Streaming voice is currently degraded: ${persisted.degradedReason}. The selected preference remains saved.`);
        setProfiles(availableProfiles);
        setStreamHealth(health);
        setSettings(next);
      })
      .catch((error) => { if (error.name !== "AbortError") setVoiceError(error.message); })
      .finally(() => setLoading(false));
    const loadSystemVoices = () => setSystemVoices(window.speechSynthesis?.getVoices?.() || []);
    loadSystemVoices();
    window.speechSynthesis?.addEventListener?.("voiceschanged", loadSystemVoices);
    return () => {
      controller.abort();
      window.speechSynthesis?.removeEventListener?.("voiceschanged", loadSystemVoices);
      previewControllerRef.current?.abort();
      previewAudioRef.current?.pause();
      window.speechSynthesis?.cancel();
      void previewLiveVoiceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (settings.mode === "streaming" && !settings.profileId && readyProfiles[0]) {
      setSettings((current) => ({ ...current, profileId: readyProfiles[0].id }));
    }
  }, [readyProfiles, settings.mode, settings.profileId]);

  useEffect(() => {
    if (settings.mode !== "streaming" || !settings.profileId || !selectedProfile?.conversationModel?.ready) {
      setWarmState("idle");
      return undefined;
    }
    const controller = new AbortController();
    setWarmState("warming");
    assistantApi(`/api/voice-clone/profiles/${encodeURIComponent(settings.profileId)}/conversation-model/warm`, { method: "POST", signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setWarmState("warm");
        setFirstAudioLatency(result?.firstAudioLatencyMs || null);
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          setWarmState("failed");
          setVoiceError(`The streaming voice could not be warmed yet: ${error.message}`);
        }
      });
    return () => controller.abort();
  }, [settings.mode, settings.profileId, selectedProfile?.conversationModel?.ready, warmAttempt]);

  function update(field, value) {
    setSaved(false);
    setSettings((current) => ({ ...current, [field]: value }));
  }

  async function save() {
    setVoiceError("");
    try {
      const savedSettings = await saveAssistantVoiceSettings(settings);
      if (savedSettings && typeof savedSettings === "object") setSettings((current) => ({ ...current, ...savedSettings }));
      setSaved(true);
    } catch (error) {
      setVoiceError(`Voice preference could not be saved: ${error.message}`);
    }
  }

  async function reloadVoiceState({ verify = false } = {}) {
    const [items, health] = await Promise.all([
      assistantApi("/api/voice-clone/profiles"),
      assistantApi(`/api/assistant/live-voice/health${verify ? "?verify=1" : ""}`)
    ]);
    setProfiles(Array.isArray(items) ? items : []);
    setStreamHealth(health);
  }

  async function waitForVoiceJob(job) {
    let current = job;
    setPreviewJob(current);
    while (!["completed", "failed", "cancelled"].includes(current.status)) {
      await waitForVoiceDelay(500);
      current = await assistantApi(`/api/voice-clone/jobs/${encodeURIComponent(job.id)}`);
      setPreviewJob(current);
    }
    if (current.status !== "completed") throw new Error(current.error || "The voice operation did not complete.");
    return current;
  }

  async function installStreamingModels() {
    setVoiceError("");
    setPreviewing(true);
    try {
      const job = await assistantApi("/api/voice-clone/models/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine: "cosyvoice3-stream-local", licenseAccepted: true })
      });
      await waitForVoiceJob(job);
      await reloadVoiceState({ verify: true });
    } catch (error) {
      setVoiceError(error.message);
    } finally {
      setPreviewing(false);
    }
  }

  async function prepareConversationVoice(primaryReferenceSegmentId = "") {
    if (!settings.profileId) return;
    setVoiceError("");
    setPreviewing(true);
    try {
      const job = await assistantApi(`/api/voice-clone/profiles/${encodeURIComponent(settings.profileId)}/conversation-model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(primaryReferenceSegmentId ? { primaryReferenceSegmentId } : {})
      });
      await waitForVoiceJob(job);
      await reloadVoiceState();
    } catch (error) {
      setVoiceError(error.message);
    } finally {
      setPreviewing(false);
    }
  }

  async function unloadStreamingModels() {
    await assistantApi("/api/assistant/live-voice/unload", { method: "POST" });
    setWarmState("idle");
    setFirstAudioLatency(null);
  }

  async function preview() {
    if (!previewText.trim()) return;
    if (previewing) {
      stopPreview();
      return;
    }
    setVoiceError("");
    setPreviewOutput(null);
    if (settings.mode === "system") {
      if (!("speechSynthesis" in window)) {
        setVoiceError("System speech playback is unavailable on this device.");
        return;
      }
      const utterance = new SpeechSynthesisUtterance(previewText.trim());
      const voice = systemVoices.find((item) => item.voiceURI === settings.systemVoiceURI);
      if (voice) utterance.voice = voice;
      utterance.rate = settings.speed;
      utterance.pitch = Math.max(0, Math.min(2, 1 + (settings.pitch * 0.35)));
      utterance.onstart = () => setPreviewing(true);
      utterance.onend = () => setPreviewing(false);
      utterance.onerror = () => { setPreviewing(false); setVoiceError("The system voice preview could not be played."); };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      return;
    }
    if (!settings.profileId) {
      setVoiceError("Choose a voice profile first.");
      return;
    }
    if (settings.mode === "streaming" && !selectedProfile?.conversationModel?.ready) {
      setVoiceError("Prepare this profile's conversation voice before previewing it.");
      return;
    }
    setPreviewing(true);
    previewStartedAtRef.current = performance.now();
    try {
      const client = previewLiveVoiceRef.current || new LiveVoiceClient({
        onPlayback: (event) => {
          if (event.speaking && previewStartedAtRef.current) {
            setFirstAudioLatency(Math.round(performance.now() - previewStartedAtRef.current));
            previewStartedAtRef.current = 0;
          }
          if (event.completed) setPreviewing(false);
        },
        onError: (error) => { setVoiceError(error.message); setPreviewing(false); }
      });
      previewLiveVoiceRef.current = client;
      await client.startTts(settings);
      client.appendText(previewText.trim());
      client.commitText();
    } catch (error) {
      setVoiceError(error.message);
      setPreviewing(false);
    }
  }

  return (
    <div className="assistant-page assistant-voice-page">
      <header className="assistant-page-header"><div><h1>声音设置</h1><p>选择声音、调整语速并试听，对话和文本朗读共用这套设置。</p></div><Badge tone="safe"><ShieldCheck size={14} /> Local audio only</Badge></header>
      {voiceError && <div className="assistant-notice assistant-notice-error" role="alert"><CircleAlert size={18} /><div><strong>Voice unavailable</strong><span>{voiceError}</span></div><button aria-label="Dismiss voice error" className="assistant-icon-button" onClick={() => setVoiceError("")} type="button"><X size={17} /></button></div>}
      <details className="assistant-advanced"><summary>音色偏好详情</summary><div className="assistant-notice"><AudioLines size={18} /><div><strong>Preference state</strong><span>Requested: {settings.requestedMode || settings.mode} · Effective: {settings.effectiveMode || "not reported"}{settings.effectiveProfileId ? ` · ${settings.effectiveProfileId}` : ""}</span></div></div></details>
      <div className="assistant-voice-settings-layout">
        <section className="assistant-panel assistant-voice-source-panel">
          <div className="assistant-section-heading"><div><h2>选择声音</h2></div></div>
          <label className={`assistant-voice-option ${settings.mode === "system" ? "is-selected" : ""}`}><input checked={settings.mode === "system"} name="voice-mode" onChange={() => update("mode", "system")} type="radio" /><span><Volume2 size={20} /></span><div><strong>系统音色</strong><small>使用设备已安装的声音，启动更快。</small></div></label>
          <label className={`assistant-voice-option ${settings.mode === "streaming" ? "is-selected" : ""}`}><input checked={settings.mode === "streaming"} disabled={streamHealth?.pipeline?.v4Eligible === false} name="voice-mode" onChange={() => update("mode", "streaming")} type="radio" /><span><AudioLines size={20} /></span><div><strong>克隆音色</strong><small>{streamHealth?.pipeline?.v4Eligible === false ? "Run and pass the combined v4 benchmark on this machine first." : "使用准备好的本地音色进行自然朗读与对话。"}</small></div></label>
          {settings.mode === "system" ? <label>System voice<select onChange={(event) => update("systemVoiceURI", event.target.value)} value={settings.systemVoiceURI}><option value="">Device default</option>{systemVoices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}</select></label> : <label>Speaker profile<select disabled={loading || !readyProfiles.length} onChange={(event) => update("profileId", event.target.value)} value={settings.profileId}><option value="">Choose a profile</option>{readyProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>}
          {settings.mode === "streaming" && !loading && !readyProfiles.length && <div className="assistant-notice"><CircleAlert size={17} /><div><strong>No speaker profile exists yet.</strong><span>Add and review a clean recording in Voice Studio, then return here.</span></div></div>}
          {selectedProfile && settings.mode === "streaming" && <div className="assistant-voice-profile-summary"><span className="assistant-file-icon"><AudioLines size={22} /></span><div><strong>{selectedProfile.name}</strong><small>{selectedProfile.conversationModel?.ready ? "本地克隆音色" : "音色尚未准备"}</small></div><Badge tone={!selectedProfile.conversationModel?.ready || warmState === "failed" ? "error" : warmState === "warm" ? "ready" : "busy"}>{!selectedProfile.conversationModel?.ready ? "needs preparation" : warmState === "warm" ? "warm" : warmState === "failed" ? "warm-up failed" : "warming"}</Badge></div>}
          {settings.mode === "streaming" && selectedProfile && !selectedProfile.conversationModel?.ready && <Button disabled={!streamHealth?.available || previewing} onClick={() => prepareConversationVoice()} tone="primary"><WandSparkles size={16} /> Prepare conversation voice</Button>}
          {settings.mode === "streaming" && warmState === "failed" && <Button onClick={() => { setVoiceError(""); setWarmAttempt(value => value + 1); }}>重新准备声音</Button>}
          {settings.mode === "streaming" && referenceCandidates.length > 0 && <details className="assistant-advanced"><summary>参考音频与音色重建</summary><div className="assistant-reference-list"><div className="assistant-section-heading"><div><span>Speaker references</span><h2>Compare clean clips</h2></div></div>{referenceCandidates.map(({ diagnostic, segment }) => <article className="assistant-recipe-card" key={diagnostic.segmentId}><div><strong>{segment?.transcript || "Reviewed reference clip"}</strong>{diagnostic.primary && <Badge tone="ready">Primary</Badge>}</div><p>Speech {Math.round(diagnostic.speechConfidence * 100)}% · transcript {Math.round(diagnostic.transcriptConfidence * 100)}% · SNR {diagnostic.signalToNoiseDb.toFixed(1)} dB{diagnostic.exclusion ? ` · ${diagnostic.exclusion}` : ""}</p>{segment?.audioUrl && <audio controls preload="none" src={segment.audioUrl} />}{!diagnostic.primary && <Button disabled={previewing} onClick={() => prepareConversationVoice(diagnostic.segmentId)}><AudioLines size={15} /> Make primary & rebuild</Button>}</article>)}</div></details>}
        </section>
        <section className="assistant-panel assistant-voice-tuning-panel">
          <div className="assistant-section-heading"><div><h2>朗读方式</h2></div></div>
          <label><span>语速 <b>{settings.speed.toFixed(2)}×</b></span><input max="1.3" min="0.7" onChange={(event) => update("speed", Number(event.target.value))} step="0.05" type="range" value={settings.speed} /></label>
          {settings.mode === "system" && <label><span>音调 <b>{settings.pitch > 0 ? "+" : ""}{settings.pitch.toFixed(1)}</b></span><input max="1.5" min="-1.5" onChange={(event) => update("pitch", Number(event.target.value))} step="0.5" type="range" value={settings.pitch} /></label>}
          {settings.mode === "streaming" && streamHealth?.tts?.engine !== "qwen3-tts-stream-local" && <label><span>表现力 <b>{Math.round(settings.styleStrength * 100)}%</b></span><input max="1" min="0" onChange={(event) => update("styleStrength", Number(event.target.value))} step="0.05" type="range" value={settings.styleStrength} /></label>}
          {settings.mode === "streaming" && <div className="assistant-notice"><AudioLines size={18} /><div><strong>Automatic multilingual voice</strong><span>Chinese, English, Japanese, Korean, German, Spanish, French, Italian, and Russian. Other languages use the same speaker best-effort.</span></div></div>}
        </section>
      </div>
      {settings.mode === "streaming" && <details className="assistant-advanced"><summary>模型诊断与维护</summary><section className="assistant-panel"><div className="assistant-section-heading"><div><span>Local runtime</span><h2>Streaming model health</h2></div><Badge tone={streamHealth?.available ? "ready" : streamHealth?.tts?.status === "unhealthy" || streamHealth?.asr?.status === "unhealthy" ? "error" : "neutral"}>{streamHealth?.available ? "ready" : "setup required"}</Badge></div><div className="assistant-model-status"><article><span>{streamHealth?.tts?.engine === "qwen3-tts-stream-local" ? "Qwen3-TTS 1.7B" : "Fun-CosyVoice 3"}</span><strong>{streamHealth?.tts?.status || "checking"}</strong><small>{streamHealth?.tts?.checksumVerified ? "Checksum verified" : streamHealth?.tts?.error || "Not installed"}</small></article><article><span>{streamHealth?.asr?.activeModel === "small-cpu-int8" ? "Whisper · CPU" : "Whisper turbo"}</span><strong>{streamHealth?.asr?.status || "checking"}</strong><small>{streamHealth?.asr?.activeModel || "Automatic multilingual ASR"}</small></article><article><span>Speaker prompt</span><strong>{selectedProfile?.conversationModel?.ready ? "ready" : "not prepared"}</strong><small>{warmState === "warm" ? "Resident and warm" : "Loads in background"}</small></article><article><span>First audio</span><strong>{firstAudioLatency ? `${firstAudioLatency} ms` : "not measured"}</strong><small>本次试听的实际启动时间</small></article></div><div className="assistant-card-actions">{!streamHealth?.available && <Button disabled={previewing} onClick={installStreamingModels} tone="primary"><RefreshCcw size={16} /> {streamHealth?.tts?.status === "unhealthy" || streamHealth?.asr?.status === "unhealthy" ? "Repair voice models" : "Accept licenses & install"}</Button>}<Button onClick={() => reloadVoiceState({ verify: true })}><ShieldCheck size={16} /> Verify checksums</Button><Button onClick={unloadStreamingModels} tone="danger-ghost"><Square size={15} /> Unload voice models</Button></div></section></details>}
      <section className="assistant-panel assistant-voice-preview-panel">
        <div className="assistant-section-heading"><div><h2>试听声音</h2></div>{previewJob && previewing && <Badge tone="busy">{previewJob.progress ? `${Math.round(previewJob.progress)}%` : previewJob.status}</Badge>}</div>
        <textarea aria-label="Voice preview text" maxLength={600} onChange={(event) => setPreviewText(event.target.value)} rows={3} value={previewText} />
        <div className="assistant-card-actions"><Button disabled={!previewText.trim() || (settings.mode === "streaming" && (!settings.profileId || !selectedProfile?.conversationModel?.ready))} onClick={preview} tone="primary">{previewing ? <><Square size={15} /> 停止试听</> : <><Play size={16} /> 试听</>}</Button><Button onClick={save}>{saved ? <><Check size={16} /> Saved</> : <><ShieldCheck size={16} /> 保存并应用</>}</Button></div>
      </section>
    </div>
  );
}

function PrivacyPage({ retention, onSaveRetention, onClear, busy }) {
  const [values, setValues] = useState(retention || { conversationDays: 90, activityDays: 90, undoDays: 7 });
  const [scope, setScope] = useState("activity");
  useEffect(() => setValues(retention || { conversationDays: 90, activityDays: 90, undoDays: 7 }), [retention]);
  return <div className="assistant-page"><header className="assistant-page-header"><div><span>Local data controls</span><h1>Privacy</h1><p>Retention removes Assistant records—not referenced source files. Managed Inbox copies are deleted only with workspace-index clear.</p></div><Badge tone="safe"><ShieldCheck size={14} /> Stored on this device</Badge></header><div className="assistant-privacy-grid"><section className="assistant-panel"><div className="assistant-section-heading"><div><span>Retention</span><h2>How long to keep records</h2></div></div><label>Conversations (days)<input min="1" onChange={(event) => setValues((current) => ({ ...current, conversationDays: Number(event.target.value) }))} type="number" value={values.conversationDays ?? ""} /></label><label>Activity (days)<input min="1" onChange={(event) => setValues((current) => ({ ...current, activityDays: Number(event.target.value) }))} type="number" value={values.activityDays ?? ""} /></label><label>Undo window<select onChange={(event) => setValues((current) => ({ ...current, undoDays: Number(event.target.value) }))} value={values.undoDays}><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option></select></label><Button disabled={busy} tone="primary" onClick={() => onSaveRetention(values)}>Save retention</Button></section><section className="assistant-panel assistant-danger-panel"><div className="assistant-section-heading"><div><span>Selective clear</span><h2>Clear Assistant data</h2></div></div><label>Data scope<select onChange={(event) => setScope(event.target.value)} value={scope}><option value="activity">Activity</option><option value="conversations">Conversations</option><option value="workspace-index">Inbox and workspace index</option><option value="recipes">Recipes and undo</option><option value="integrations">Integration grants and deliveries</option><option value="model-records">Model records</option><option value="all">All Assistant records</option></select></label><div className="assistant-notice"><ShieldCheck size={18} /><div><strong>Source files stay untouched.</strong><span>Installed model packages require their dedicated Remove action.</span></div></div><Button disabled={busy} tone="danger" onClick={() => onClear(scope)}><Trash2 size={16} /> Review & clear</Button></section></div></div>;
}

export default function Assistant({ onBack }) {
  const [page, setPage] = useState(pageFromHash);
  const [toolsOpen, setToolsOpen] = useState(() => ASSISTANT_PAGES.some((entry) => entry.id === pageFromHash() && entry.secondary));
  const [status, setStatus] = useState(null);
  const [items, setItems] = useState([]);
  const [itemTotal, setItemTotal] = useState(0);
  const [roots, setRoots] = useState([]);
  const [activity, setActivity] = useState([]);
  const [activityTotal, setActivityTotal] = useState(0);
  const [retention, setRetention] = useState(null);
  const [modelData, setModelData] = useState({ catalog: [], status: null });
  const [conversations, setConversations] = useState([]);
  const [conversationTotal, setConversationTotal] = useState(0);
  const [conversation, setConversation] = useState(null);
  const [recipes, setRecipes] = useState([]);
  const [integrations, setIntegrations] = useState([]);
  const [selectedItems, setSelectedItems] = useState([]);
  const [trackedJob, setTrackedJob] = useState(null);
  const [plan, setPlan] = useState(null);
  const [search, setSearch] = useState("");
  const [sourcePanel, setSourcePanel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const refreshController = useRef(null);
  const askController = useRef(null);
  const refreshSequence = useRef(0);
  const readerDraftRef = useRef("");

  useEffect(() => {
    const voice = readAssistantVoiceSettings();
    if (voice.mode !== "streaming" || !voice.profileId) return undefined;
    const controller = new AbortController();
    assistantApi(`/api/voice-clone/profiles/${encodeURIComponent(voice.profileId)}/conversation-model/warm`, { method: "POST", signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, []);

  const refresh = useCallback(async () => {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    const sequence = ++refreshSequence.current;
    const results = await Promise.all([
      assistantApi("/api/assistant/status", { signal: controller.signal }),
      assistantApi("/api/assistant/items?offset=0&limit=100", { signal: controller.signal }),
      assistantApi("/api/assistant/workspace-roots", { signal: controller.signal }),
      assistantApi("/api/assistant/activity?offset=0&limit=100", { signal: controller.signal }),
      assistantApi("/api/assistant/privacy-retention", { signal: controller.signal }),
      assistantApi("/api/assistant/models", { signal: controller.signal }),
      assistantApi("/api/assistant/conversations?offset=0&limit=50", { signal: controller.signal }),
      assistantApi("/api/assistant/recipes", { signal: controller.signal }),
      assistantApi("/api/assistant/integrations", { signal: controller.signal })
    ]);
    if (controller.signal.aborted || sequence !== refreshSequence.current) return;
    setStatus(results[0]); setItems(results[1].items); setItemTotal(results[1].total || 0); setRoots(results[2].roots); setActivity(results[3].records); setActivityTotal(results[3].total || 0); setRetention(results[4]); setModelData(results[5]); setConversations(results[6].conversations); setConversationTotal(results[6].total || 0); setRecipes(results[7].recipes); setIntegrations(results[8].integrations);
  }, []);

  useEffect(() => {
    if (window.location.hash !== canonicalAssistantHash()) window.history.replaceState(null, "", canonicalAssistantHash());
    const listener = () => { const canonical = canonicalAssistantHash(); if (window.location.hash !== canonical) window.history.replaceState(null, "", canonical); setPage(pageFromHash()); };
    window.addEventListener("hashchange", listener);
    refresh().catch(setError);
    return () => { window.removeEventListener("hashchange", listener); refreshController.current?.abort(); askController.current?.abort(); };
  }, [refresh]);

  useEffect(() => {
    if (!trackedJob || ["completed", "failed", "cancelled"].includes(trackedJob.status)) return undefined;
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        const next = await assistantApi(`/api/assistant/jobs/${trackedJob.id}`);
        if (cancelled) return;
        setTrackedJob(next);
        if (["completed", "failed", "cancelled"].includes(next.status)) { await refresh(); return; }
      } catch (nextError) { if (!cancelled) setError(nextError); }
      if (!cancelled) timer = window.setTimeout(poll, 500);
    };
    timer = window.setTimeout(poll, 500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [trackedJob?.id, trackedJob?.status, refresh]);

  const navigate = useCallback((nextPage) => { window.location.hash = `#/assistant/${nextPage}`; setPage(nextPage); }, []);
  const requestConfirmation = useCallback((next) => setConfirmation(next), []);

  async function action(callback, success) {
    setBusy(true); setError(null); setNotice("");
    try { const result = await callback(); if (success) setNotice(success); await refresh(); return result; }
    catch (nextError) { setError(nextError); throw nextError; }
    finally { setBusy(false); }
  }

  async function chooseFolder(currentPath = "") {
    if (window.magicBox?.chooseDownloadFolder) return window.magicBox.chooseDownloadFolder(currentPath);
    return (await assistantApi("/api/system/choose-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPath }) })).folder;
  }

  async function importFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const form = new FormData(); files.forEach((file) => form.append("files", file));
    const result = await action(() => assistantApi("/api/assistant/items/import", { method: "POST", body: form }), `${files.length} file(s) added to the private Inbox.`);
    setTrackedJob(result.job);
  }

  async function selectConversation(id) {
    try { setConversation(await assistantApi(`/api/assistant/conversations/${id}?offset=0&limit=20`)); }
    catch (nextError) { setError(nextError); }
  }

  async function loadMoreItems() {
    const next = await assistantApi(`/api/assistant/items?offset=${items.length}&limit=100`);
    setItems((current) => [...current, ...next.items.filter((item) => !current.some((entry) => entry.id === item.id))]);
    setItemTotal(next.total || 0);
  }

  async function loadMoreActivity() {
    const next = await assistantApi(`/api/assistant/activity?offset=${activity.length}&limit=100`);
    setActivity((current) => [...current, ...next.records.filter((record) => !current.some((entry) => entry.id === record.id))]);
    setActivityTotal(next.total || 0);
  }

  async function loadMoreConversations() {
    const next = await assistantApi(`/api/assistant/conversations?offset=${conversations.length}&limit=50`);
    setConversations((current) => [...current, ...next.conversations.filter((entry) => !current.some((value) => value.id === entry.id))]);
    setConversationTotal(next.total || 0);
  }

  async function openCurrentSource(source) {
    try {
      const current = await assistantApi(`/api/assistant/items/${source.itemId}/revisions/${source.itemRevision}/chunks/${source.chunkId}`);
      setSourcePanel({ ...current, panelKind: "Current indexed source" });
    } catch (nextError) { setError(nextError); }
  }

  async function sendQuestion(message, { stream = false, onlineSearch = "auto", resourceProfile = "default", onDelta = null, onReset = null, onResourceState = null } = {}) {
    askController.current?.abort();
    const controller = new AbortController();
    askController.current = controller;
    setAsking(true); setError(null);
    try {
      const request = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: crypto.randomUUID(), conversationId: conversation?.id, message, onlineSearch, resourceProfile, ...(selectedItems.length ? { scope: { itemIds: selectedItems } } : {}) }), signal: controller.signal };
      const response = stream
        ? await assistantStreamApi("/api/assistant/chat-stream", request, (event) => {
          if (event.type === "answer.delta") onDelta?.(event.delta);
          if (event.type === "answer.reset") onReset?.();
          if (event.type === "resource.state") onResourceState?.(event.state);
        })
        : await assistantApi("/api/assistant/chat", request);
      await refresh(); await selectConversation(response.conversationId);
    } catch (nextError) {
      if (nextError.name !== "AbortError") setError(nextError);
      throw nextError;
    } finally {
      if (askController.current === controller) {
        askController.current = null;
        setAsking(false);
      }
    }
  }

  function cancelQuestion() {
    askController.current?.abort();
  }

  const startNewChat = useCallback(() => {
    setConversation(null);
    setSourcePanel(null);
  }, []);

  async function installModel(model) {
    requestConfirmation({ title: `Install ${model.displayName}?`, description: "The reviewed model package will be downloaded and will run only on this device.", details: `Download: ${(model.sizeBytes / 1024 ** 3).toFixed(2)} GiB\nLicense: ${model.license.id}`, confirmLabel: "Accept license & install", onConfirm: async () => { const job = await action(() => assistantApi("/api/assistant/models/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capability: model.capability, modelId: model.id, manifestRevision: model.manifestRevision, licenseAcceptance: { licenseId: model.license.id, accepted: true } }) }), "Model installation started."); setTrackedJob(job); } });
  }

  async function approveExecute(nextPlan) {
    requestConfirmation({ title: `Approve ${nextPlan.operations.length} planned operation(s)?`, description: "Magic Box will verify the preview again and will not overwrite or delete unrelated files.", confirmLabel: "Approve exact plan", onConfirm: async () => { const approval = await action(() => assistantApi(`/api/assistant/automations/plans/${nextPlan.id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planHash: nextPlan.planHash, confirmation: true }) })); const job = await action(() => assistantApi("/api/assistant/automations/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: nextPlan.id, approvalId: approval.approvalId }) }), "Approved automation started."); setTrackedJob(job); setPlan(null); } });
  }

  const pageContent = useMemo(() => {
    if (page === "home") return <HomePage activity={activity} onNavigate={navigate} status={status} />;
    if (page === "inbox") return <InboxPage busy={busy} items={items} total={itemTotal} onLoadMore={() => action(loadMoreItems)} onAddRoot={() => action(async () => { const folder = await chooseFolder(); if (!folder) return; const result = await assistantApi("/api/assistant/workspace-roots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: folder }) }); if (result.scanJobId) setTrackedJob(await assistantApi(`/api/assistant/jobs/${result.scanJobId}`)); }, "Workspace folder approved.")} onImport={importFiles} onReindex={(id) => action(async () => { const job = await assistantApi(`/api/assistant/items/${id}/index`, { method: "POST" }); setTrackedJob(job); }, "Re-index started.")} onRemoveItem={(id) => requestConfirmation({ title: "Remove this item from Assistant?", description: "The original referenced source file will not be deleted. A managed Inbox copy will be removed.", confirmLabel: "Remove item", danger: true, onConfirm: () => action(() => assistantApi(`/api/assistant/items/${id}`, { method: "DELETE" }), "Item removed from Assistant.") })} onRemoveRoot={(id) => requestConfirmation({ title: "Revoke this workspace folder?", description: "Assistant access and its index entries will be removed. Source files remain untouched.", confirmLabel: "Revoke access", danger: true, onConfirm: () => action(() => assistantApi(`/api/assistant/workspace-roots/${id}`, { method: "DELETE" }), "Workspace access revoked.") })} roots={roots} search={search} selectedItems={selectedItems} setSearch={setSearch} setSelectedItems={setSelectedItems} />;
    if (page === "ask") return <AskPage asking={asking} capabilities={status?.capabilities} modelStatus={modelData.status} conversation={conversation} conversations={conversations} conversationTotal={conversationTotal} onLoadMoreConversations={() => action(loadMoreConversations)} onNewConversation={startNewChat} onSelectConversation={selectConversation} onSend={sendQuestion} onCancel={cancelQuestion} onOpenCurrentSource={openCurrentSource} selectedItems={selectedItems} setSourcePanel={setSourcePanel} sourcePanel={sourcePanel} />;
    if (page === "conversations") return <ConversationsPage busy={busy} conversations={conversations} total={conversationTotal} onLoadMore={() => action(loadMoreConversations)} onOpen={async (id) => { await selectConversation(id); navigate("ask"); }} onDelete={(entry) => requestConfirmation({ title: `Delete “${entry.title}”?`, description: "This conversation and its messages will be permanently removed. Other conversations and long-term identity memory remain available.", confirmLabel: "Delete conversation", danger: true, onConfirm: () => action(async () => { await assistantApi(`/api/assistant/conversations/${entry.id}`, { method: "DELETE" }); if (conversation?.id === entry.id) setConversation(null); }, "Conversation deleted.") })} />;
    if (page === "models") return <ModelsPage busy={busy} models={modelData.catalog} onActivate={(capability, modelId) => action(() => assistantApi("/api/assistant/models/active", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capability, modelId }) }), modelId ? "Local model activated." : "Local model deactivated.")} onInstall={installModel} onRemove={(id) => requestConfirmation({ title: "Remove this local model package?", description: "The local weights and their acceptance record will be removed. Other Assistant data remains.", confirmLabel: "Remove model", danger: true, onConfirm: () => action(() => assistantApi(`/api/assistant/models/${id}`, { method: "DELETE" }), "Model removed.") })} status={modelData.status} />;
    if (page === "activity") return <ActivityPage onUndo={(id) => requestConfirmation({ title: "Undo this exact automation result?", description: "Current files and metadata will be verified before any reversal is applied.", confirmLabel: "Verify & undo", onConfirm: () => action(async () => { const job = await assistantApi(`/api/assistant/activity/${id}/undo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: true }) }); setTrackedJob(job); }, "Undo started.") })} records={activity} total={activityTotal} onLoadMore={() => action(loadMoreActivity)} />;
    if (page === "automations") return <AutomationsPage busy={busy} items={items} onApproveExecute={approveExecute} onCreate={(draft) => action(() => assistantApi("/api/assistant/recipes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft }) }), "Recipe saved disabled.")} onDisable={(id) => action(() => assistantApi(`/api/assistant/recipes/${id}/disable`, { method: "POST" }), "Recipe disabled.")} onEnable={(recipe) => action(() => assistantApi(`/api/assistant/recipes/${recipe.id}/enable`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: recipe.revision, confirmation: true }) }), "Recipe enabled.")} onPreview={(recipeId) => action(async () => setPlan(await assistantApi("/api/assistant/automations/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipeId, itemIds: selectedItems }) })), "Plan preview created.")} plan={plan} recipes={recipes} roots={roots} selectedItems={selectedItems} />;
    if (page === "integrations") return <IntegrationsPage busy={busy} integrations={integrations} onToggle={(integration) => action(async () => { if (integration.enabled) return assistantApi(`/api/assistant/integrations/${integration.toolId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false, confirmation: true }) }); const folder = await chooseFolder(integration.outputRootPath || ""); if (!folder) return; return assistantApi(`/api/assistant/integrations/${integration.toolId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, outputRootPath: folder, confirmation: true }) }); }, integration.enabled ? "Integration disabled." : "Integration enabled for completed outputs.")} />;
    if (page === "reader") return <TextReader initialText={readerDraftRef.current} onTextChange={(text) => { readerDraftRef.current = text; }} loadSettings={loadAssistantVoicePreferences} onSettings={() => navigate("voice")} />;
    if (page === "voice") return <VoiceSettingsPage />;
    if (page === "privacy") return <PrivacyPage busy={busy} onClear={(scope) => requestConfirmation({ title: `Clear ${scope}?`, description: "Referenced source files will not be deleted. Managed Inbox copies are deleted when the workspace index is cleared.", confirmLabel: "Clear selected data", danger: true, onConfirm: () => action(() => assistantApi("/api/assistant/privacy-clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scopes: [scope], confirmation: true, discardEligibleUndo: scope === "activity" || scope === "all" }) }), "Selected Assistant data cleared.") })} onSaveRetention={(values) => action(() => assistantApi("/api/assistant/privacy-retention", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) }), "Retention updated.")} retention={retention} />;
    return null;
  }, [page, activity, activityTotal, navigate, status, busy, items, itemTotal, roots, search, selectedItems, asking, conversation, conversations, conversationTotal, sourcePanel, modelData, recipes, plan, integrations, retention, requestConfirmation, startNewChat]);

  return (
    <section className="assistant-shell assistant-focused" aria-label="Private Assistant">
      <header className="assistant-topbar"><button className="assistant-back" onClick={() => { window.history.replaceState(null, "", window.location.pathname); onBack(); }} type="button"><ArrowLeft size={18} /><span>Toolbox</span></button><div className="assistant-brand"><span><Bot size={20} /></span><div><strong>Private Assistant</strong><small>Local workspace hub</small></div></div><div className="assistant-topbar-status"><i /><span>{status?.state === "ready" ? "本地运行中" : "正在启动"}</span></div></header>
      <div className="assistant-body">
        <nav className="assistant-nav" aria-label="Assistant sections">{ASSISTANT_PAGES.filter((entry) => !entry.secondary).map((entry) => { const Icon = entry.icon; return <button title={entry.label} aria-current={page === entry.id ? "page" : undefined} className={page === entry.id ? "is-active" : ""} key={entry.id} onClick={() => navigate(entry.id)} type="button"><Icon size={18} /><span>{entry.label}</span></button>; })}<button aria-expanded={toolsOpen} className="assistant-more-toggle" onClick={() => setToolsOpen(!toolsOpen)} type="button"><ChevronRight size={18} /><span>更多工具</span></button>{toolsOpen && ASSISTANT_PAGES.filter((entry) => entry.secondary).map((entry) => { const Icon = entry.icon; return <button title={entry.label} aria-current={page === entry.id ? "page" : undefined} className={page === entry.id ? "is-active" : ""} key={entry.id} onClick={() => navigate(entry.id)} type="button"><Icon size={17} /><span>{entry.label}</span></button>; })}</nav>
        <main className="assistant-content" id="assistant-content" tabIndex="-1"><ErrorNotice error={error} onDismiss={() => setError(null)} onRetry={() => refresh().catch(setError)} />{notice && <div className="assistant-notice assistant-notice-success" role="status"><Check size={18} /><div><strong>Done</strong><span>{notice}</span></div><button aria-label="Dismiss notice" onClick={() => setNotice("")} type="button"><X size={16} /></button></div>}<JobProgress job={trackedJob} onCancel={(id) => action(async () => setTrackedJob(await assistantApi(`/api/assistant/jobs/${id}/cancel`, { method: "POST" })))} />{pageContent}</main>
      </div>
      {confirmation && <ConfirmationDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />}
    </section>
  );
}
