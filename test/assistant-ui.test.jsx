import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Assistant from "../src/Assistant.jsx";
import { LiveVoiceClient } from "../src/liveVoice.js";

const now = new Date().toISOString();
const NativeAudio = global.Audio;
const NativeMediaDevices = navigator.mediaDevices;
const state = {
  itemTotal: 1,
  status: {
    state: "ready",
    capabilities: { inbox: "ready", models: "ready", chat: "ready", automation: "ready" },
    counts: { items: 1, activeJobs: 0, activity: 1 },
    privacy: { localOnly: true, cloudInference: false }
  },
  items: [{ id: "item-1", displayName: "notes.txt", state: "indexed", source: "manual", contentType: "text/plain", sizeBytes: 120, fingerprint: "abc", revision: 1, metadataRevision: 0, tags: [], summary: "A local note", origins: [], createdAt: now, updatedAt: now }],
  roots: [],
  activity: [{ id: "activity-1", status: "completed", action: "item.imported", summary: "notes.txt added", createdAt: now }],
  retention: { conversationDays: 90, activityDays: 90, undoDays: 7 },
  models: {
    status: { runtime: "ready", generation: "not-installed", embeddings: "not-installed", activeModels: {} },
    catalog: [{ id: "qwen", capability: "generation", displayName: "Qwen Local", manifestRevision: "1", sizeBytes: 1_000_000_000, installState: "not-installed", active: false, memory: { recommendedRamBytes: 8_589_934_592 }, license: { id: "apache-2.0" } }]
  },
  integrations: [{ toolId: "images", enabled: false, outputRootPath: null, generation: 0, pendingCount: 0, failedCount: 0, updatedAt: now }],
  voiceProfiles: [],
  conversations: [],
  conversationDetails: {}
};
let chatAbortObserved = false;
let chatReply = null;
let liveVoiceMessages = [];
let liveVoiceSockets = [];

function installLiveVoiceMock() {
  class MockWebSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0;
      liveVoiceSockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(value) {
      if (typeof value !== "string") return;
      const message = JSON.parse(value);
      liveVoiceMessages.push(message);
      if (message.type === "session.start") queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "session.ready", inputFormat: {}, outputFormat: {}, tts: { status: "ready" }, asr: { status: "ready" } }) }));
      if (message.type === "tts.reply.start") queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "tts.reply.ready", turnId: message.turnId, replyId: message.replyId, generation: 1 }) }));
      if (message.type === "tts.segment") queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "tts.segment.completed", turnId: message.turnId, replyId: message.replyId, segmentId: message.segmentId, sequence: message.sequence, generation: 1 }) }));
      if (message.type === "tts.reply.commit") queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "tts.reply.completed", turnId: message.turnId, replyId: message.replyId, generation: 1 }) }));
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class MockAudioNode {
    constructor() { this.gain = { value: 1 }; this.port = { postMessage: vi.fn((message) => { if (message?.type === "complete") queueMicrotask(() => this.port.onmessage?.({ data: { type: "completed", generation: message.generation, underruns: 0 } })); }), onmessage: null }; }
    connect() { return this; }
    disconnect() {}
  }
  class MockAudioContext {
    constructor() { this.state = "running"; this.destination = new MockAudioNode(); this.audioWorklet = { addModule: vi.fn(async () => {}) }; }
    createGain() { return new MockAudioNode(); }
    createMediaStreamSource() { return new MockAudioNode(); }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  global.WebSocket = MockWebSocket;
  global.AudioContext = MockAudioContext;
  global.AudioWorkletNode = MockAudioNode;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function installFetchMock() {
  global.fetch = vi.fn(async (input, options = {}) => {
    const url = new URL(String(input), "http://magic-box.local");
    if (url.pathname === "/api/assistant/status") return json(state.status);
    if (url.pathname === "/api/assistant/items") return json({ items: state.items, total: state.itemTotal });
    if (url.pathname === "/api/assistant/workspace-roots") return json({ roots: state.roots });
    if (url.pathname === "/api/assistant/activity") return json({ records: state.activity, total: state.activity.length });
    if (url.pathname === "/api/assistant/privacy-retention") return json(state.retention);
    if (url.pathname === "/api/assistant/models") return json(state.models);
    if (url.pathname === "/api/assistant/conversations") return json({ conversations: state.conversations, total: state.conversations.length });
    if (url.pathname.startsWith("/api/assistant/conversations/") && options.method === "DELETE") {
      const id = url.pathname.split("/").at(-1);
      state.conversations = state.conversations.filter((entry) => entry.id !== id);
      delete state.conversationDetails[id];
      return json({ removed: true });
    }
    if (url.pathname.startsWith("/api/assistant/conversations/")) return json(state.conversationDetails[url.pathname.split("/").at(-1)] || { code: "conversation_not_found" }, state.conversationDetails[url.pathname.split("/").at(-1)] ? 200 : 404);
    if (url.pathname === "/api/assistant/chat" && options.method === "POST") {
      if (chatReply) {
        state.conversations = [{ id: chatReply.id, title: chatReply.title }];
        state.conversationDetails[chatReply.id] = chatReply;
        return json({ conversationId: chatReply.id });
      }
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          chatAbortObserved = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
      });
    }
    if (url.pathname === "/api/assistant/chat-stream" && options.method === "POST" && chatReply) {
      state.conversations = [{ id: chatReply.id, title: chatReply.title }];
      state.conversationDetails[chatReply.id] = chatReply;
      const answer = [...chatReply.messages].reverse().find((message) => message.role === "assistant")?.content || "";
      const events = [
        { type: "answer.delta", delta: answer },
        { type: "answer.completed", response: { conversationId: chatReply.id } }
      ];
      return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (url.pathname === "/api/assistant/recipes") return json({ recipes: [] });
    if (url.pathname === "/api/assistant/preferences/network") return json({ enabled: options.method === "PUT" ? JSON.parse(options.body).enabled : false });
    if (url.pathname === "/api/assistant/integrations" && options.method !== "PUT") return json({ integrations: state.integrations });
    if (url.pathname === "/api/assistant/integrations/images" && options.method === "PUT") {
      state.integrations = [{ ...state.integrations[0], enabled: true, outputRootPath: "C:\\MagicBox\\Images", generation: 1 }];
      return json(state.integrations[0]);
    }
    if (url.pathname === "/api/voice-clone/profiles") return json(state.voiceProfiles);
    if (url.pathname === "/api/assistant/live-voice/health") return json({ available: true, tts: { status: "ready", checksumVerified: true }, asr: { status: "ready", checksumVerified: true, activeModel: "large-v3-turbo" } });
    if (/^\/api\/voice-clone\/profiles\/[^/]+\/conversation-model\/warm$/.test(url.pathname) && options.method === "POST") {
      return json({ profileId: url.pathname.split("/")[4], warmed: true, warmLatencyMs: 120 });
    }
    if (/^\/api\/voice-clone\/profiles\/[^/]+\/warm$/.test(url.pathname) && options.method === "POST") {
      return json({ profileId: url.pathname.split("/")[4], engine: "gpt-sovits-local", warmed: true });
    }
    if (url.pathname === "/api/voice-clone/tts" && options.method === "POST") {
      return json({ id: "voice-job-1", status: "completed", progress: 100, result: { output: { id: "voice-output-1", audioUrl: "/api/voice-clone/outputs/voice-output-1/audio" } } }, 202);
    }
    return json({ code: "not_mocked", message: url.pathname }, 500);
  });
}

describe("Private Assistant workspace", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "#/assistant/home");
    window.magicBox = { chooseDownloadFolder: vi.fn(async () => "C:\\MagicBox\\Images") };
    state.integrations = [{ toolId: "images", enabled: false, outputRootPath: null, generation: 0, pendingCount: 0, failedCount: 0, updatedAt: now }];
    state.itemTotal = 1;
    state.models.status = { runtime: "ready", generation: "not-installed", embeddings: "not-installed", activeModels: {} };
    state.conversations = [];
    state.conversationDetails = {};
    state.voiceProfiles = [];
    chatAbortObserved = false;
    chatReply = null;
    window.localStorage.removeItem("magicBox.assistantVoice.v1");
    window.localStorage.removeItem("magicBox.assistantVoice.v2");
    window.localStorage.removeItem("magicBox.assistantVoice.v3");
    window.localStorage.removeItem("magicBox.assistantVoice.v4");
    global.Audio = class {
      constructor(src) { this.src = src; this.onended = null; this.onerror = null; }
      play() { queueMicrotask(() => this.onended?.()); return Promise.resolve(); }
      pause() {}
    };
    liveVoiceMessages = [];
    liveVoiceSockets = [];
    installLiveVoiceMock();
    installFetchMock();
  });

  afterEach(() => {
    cleanup();
    delete window.magicBox;
    delete window.chrome;
    delete window.SpeechRecognition;
    delete window.speechSynthesis;
    delete global.SpeechSynthesisUtterance;
    global.Audio = NativeAudio;
    delete global.WebSocket;
    delete global.AudioContext;
    delete global.AudioWorkletNode;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: NativeMediaDevices });
  });

  it("loads a private local-only home and navigates every primary workspace", async () => {
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: /Your local workspace/i })).toBeVisible();
    expect(screen.getByRole("button", { name: "更多工具" })).toHaveAttribute("aria-expanded", "true");

    await user.click(screen.getByRole("button", { name: "知识库" }));
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeVisible();
    expect(screen.getByText("notes.txt")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "对话" }));
    expect(await screen.findByRole("heading", { name: "新对话" })).toBeVisible();
    expect(screen.getByPlaceholderText(/输入消息/)).toBeDisabled();
    expect(screen.getByText(/local model must be installed/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "本地模型" }));
    expect(await screen.findByRole("heading", { name: "Models" })).toBeVisible();
    expect(screen.getByText("Qwen Local")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "隐私与数据" }));
    expect(await screen.findByRole("heading", { name: "Privacy" })).toBeVisible();
    expect(screen.getByText("Source files stay untouched.")).toBeVisible();
  });

  it("opens directly into chat with secondary tools and history collapsed", async () => {
    window.history.replaceState(null, "", "#/assistant");
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "新对话" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "本地模型" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("最近对话")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "更多工具" }));
    expect(screen.getByRole("button", { name: "本地模型" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "文本朗读" }));
    expect(screen.getByLabelText("朗读内容")).toBeEnabled();
    await user.type(screen.getByLabelText("朗读内容"), "切换页面后保留这段文字。");
    await user.click(screen.getByRole("button", { name: "对话" }));
    await user.click(screen.getByRole("button", { name: "文本朗读" }));
    expect(screen.getByLabelText("朗读内容")).toHaveValue("切换页面后保留这段文字。");
  });

  it("does not start a cancelled TTS operation after connection preparation finishes", async () => {
    const client = new LiveVoiceClient();
    let release;
    client.connect = () => new Promise((resolve) => { release = resolve; });
    const start = client.startTts({});
    const assertion = expect(start).rejects.toMatchObject({ name: "AbortError" });
    client.cancel("stop");
    release();
    await assertion;
    expect(client.activeTurnId).toBe("");
    await client.close();
  });

  it("stops microphone tracks granted after the user cancels", async () => {
    const client = new LiveVoiceClient();
    client.connect = async () => {};
    let grant;
    const track = { stop: vi.fn(), readyState: "live" };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => new Promise((resolve) => { grant = resolve; }) } });
    const start = client.startInput({});
    const assertion = expect(start).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => expect(grant).toBeTypeOf("function"));
    client.cancel("stop");
    grant({ getTracks: () => [track], getAudioTracks: () => [track] });
    await assertion;
    expect(track.stop).toHaveBeenCalledOnce();
    await client.close();
  });

  it("settles playback and releases the session on an unexpected socket disconnect", async () => {
    const onError = vi.fn();
    const client = new LiveVoiceClient({ onError });
    const turn = await client.startTts({ profileId: "voice-1" });
    const assertion = expect(client.waitForPlayback(turn)).rejects.toThrow(/connection closed/);
    liveVoiceSockets.at(-1).close();
    await assertion;
    expect(onError).toHaveBeenCalledOnce();
    expect(client.activeTurnId).toBe("");
    await client.close();
  });

  it("manages and deletes one saved conversation without clearing the others", async () => {
    state.conversations = [
      { id: "conversation-keep", title: "Keep this chat", updatedAt: now },
      { id: "conversation-delete", title: "Delete this chat", updatedAt: now }
    ];
    state.conversationDetails = {
      "conversation-keep": { id: "conversation-keep", title: "Keep this chat", messages: [] },
      "conversation-delete": { id: "conversation-delete", title: "Delete this chat", messages: [] }
    };
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "历史记录" }));
    expect(await screen.findByRole("heading", { name: "Conversations" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Delete Delete this chat" }));
    await user.click(await screen.findByRole("button", { name: "Delete conversation" }));
    await waitFor(() => expect(screen.queryByText("Delete this chat")).not.toBeInTheDocument());
    expect(screen.getByText("Keep this chat")).toBeVisible();
  });

  it("uses automatic model-routed web search from Ask", async () => {
    state.models.status = { runtime: "ready", generation: "ready", embeddings: "ready", activeModels: { generation: "qwen" } };
    chatReply = { id: "conversation-web-auto", title: "Current news", messages: [{ id: "web-user", role: "user", content: "Search the web for today's AI news" }, { id: "web-answer", role: "assistant", content: "Here are the current results.", grounding: "web", sources: [] }] };
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "对话" }));
    expect(screen.queryByText("Selective web verification")).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/输入消息/), "Search the web for today's AI news");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/assistant/chat", expect.objectContaining({ body: expect.stringContaining('"onlineSearch":"auto"') })));
  });

  it("starts a new chat from an open conversation and renders structured Assistant answers", async () => {
    state.models.status = { runtime: "ready", generation: "ready", embeddings: "ready", activeModels: { generation: "qwen" } };
    state.conversations = [{ id: "conversation-old", title: "Old planning chat", updatedAt: now }];
    state.conversationDetails = {
      "conversation-old": {
        id: "conversation-old",
        title: "Old planning chat",
        messages: [{ id: "old-answer", role: "assistant", content: "### Recommended approach\n\n- First useful point\n- Second useful point\n\nUse `npm test` to verify it.", grounding: "model-only", sources: [] }]
      }
    };
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "对话" }));
    await user.click(screen.getByRole("button", { name: "历史" }));
    await user.click(await screen.findByRole("button", { name: "Old planning chat" }));
    expect(await screen.findByRole("heading", { name: "Recommended approach" })).toBeVisible();
    expect(screen.getByRole("list")).toHaveTextContent("First useful point");
    expect(screen.getByText("npm test")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "新建对话" }));
    expect(await screen.findByRole("heading", { name: "新对话" })).toBeVisible();
    expect(screen.queryByText("First useful point")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/输入消息/)).toHaveValue("");
  });

  it("keeps tool handoff disabled until a folder grant is explicitly chosen", async () => {
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: /Your local workspace/i });
    await user.click(screen.getByRole("button", { name: "工具集成" }));
    expect(await screen.findByText("Completed outputs are not sent to Assistant.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Choose folder & enable/i }));
    await waitFor(() => expect(window.magicBox.chooseDownloadFolder).toHaveBeenCalledOnce());
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/assistant/integrations/images", expect.objectContaining({ method: "PUT" })));
  });

  it("normalizes an invalid Assistant route and preserves Back/Forward hash navigation", async () => {
    window.history.replaceState(null, "", "#/assistant/not-a-page");
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "新对话" })).toBeVisible();
    expect(window.location.hash).toBe("#/assistant/ask");
    await user.click(screen.getByRole("button", { name: "更多工具" }));
    await user.click(screen.getByRole("button", { name: "知识库" }));
    expect(window.location.hash).toBe("#/assistant/inbox");
    window.location.hash = "#/assistant/privacy";
    expect(await screen.findByRole("heading", { name: "Privacy" })).toBeVisible();
  });

  it("uses a keyboard-contained review dialog instead of a native confirmation", async () => {
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: /Your local workspace/i });
    await user.click(screen.getByRole("button", { name: "本地模型" }));
    await user.click(await screen.findByRole("button", { name: /Review & install/i }));
    const dialog = screen.getByRole("dialog", { name: /Install Qwen Local/i });
    expect(dialog).toBeVisible();
    expect(screen.getByRole("button", { name: /Accept license & install/i })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("requests the next Inbox page without duplicating the first page", async () => {
    state.itemTotal = 101;
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: /Your local workspace/i });
    await user.click(screen.getByRole("button", { name: "知识库" }));
    await user.click(await screen.findByRole("button", { name: "Load more Inbox items" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/assistant/items?offset=1&limit=100", expect.anything()));
    expect(screen.getAllByText("notes.txt")).toHaveLength(1);
  });

  it("cancels an active local Ask request through its AbortSignal", async () => {
    state.models.status = { runtime: "ready", generation: "ready", embeddings: "ready", activeModels: { generation: "qwen-local" } };
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: /Your local workspace/i });
    await user.click(screen.getByRole("button", { name: "对话" }));
    const composer = await screen.findByPlaceholderText(/输入消息/);
    await user.type(composer, "Keep this question after cancellation");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(chatAbortObserved).toBe(true));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel request" })).not.toBeInTheDocument());
    expect(composer).toHaveValue("Keep this question after cancellation");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps voice input on-device and reads the resulting local answer aloud", async () => {
    state.models.status = { runtime: "ready", generation: "ready", embeddings: "ready", activeModels: { generation: "qwen-local" } };
    chatReply = {
      id: "conversation-voice",
      title: "Voice answer",
      messages: [
        { id: "message-user", role: "user", content: "Summarize my notes" },
        { id: "message-assistant", role: "assistant", content: "Your notes contain a concise project summary.", grounding: "workspace", sources: [] }
      ]
    };

    let recognition;
    class LocalSpeechRecognition {
      static available = vi.fn(async () => "available");
      constructor() {
        recognition = this;
        this.processLocally = false;
      }
      start() {
        this.onstart?.();
        this.onresult?.({ results: [{ 0: { transcript: "Summarize my notes" } }] });
      }
      stop() {
        this.onend?.();
      }
      abort() {}
    }
    class MockUtterance {
      constructor(text) { this.text = text; }
    }
    window.SpeechRecognition = LocalSpeechRecognition;
    window.speechSynthesis = { cancel: vi.fn(), speak: vi.fn() };
    global.SpeechSynthesisUtterance = MockUtterance;

    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: /Your local workspace/i });
    await user.click(screen.getByRole("button", { name: "对话" }));
    await user.click(await screen.findByRole("button", { name: "Start voice input" }));

    expect(LocalSpeechRecognition.available).toHaveBeenCalledWith(expect.objectContaining({ processLocally: true }));
    expect(recognition.processLocally).toBe(true);
    expect(screen.getByPlaceholderText(/输入消息/)).toHaveValue("Summarize my notes");

    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("Your notes contain a concise project summary.");
    await waitFor(() => expect(window.speechSynthesis.speak).toHaveBeenCalledOnce());
    expect(window.speechSynthesis.speak.mock.calls[0][0].text).toBe("Your notes contain a concise project summary.");
  });

  it("runs automatic turn-taking in a live voice conversation", async () => {
    state.models.status = { runtime: "ready", generation: "ready", embeddings: "ready", activeModels: { generation: "qwen-local" } };
    chatReply = {
      id: "conversation-live-voice",
      title: "Live voice answer",
      messages: [
        { id: "message-live-user", role: "user", content: "What is in my notes?" },
        { id: "message-live-assistant", role: "assistant", content: "Your notes contain a project summary.", grounding: "workspace", sources: [] }
      ]
    };

    let starts = 0;
    class LiveSpeechRecognition {
      static available = vi.fn(async () => "available");
      constructor() { this.processLocally = false; }
      start() {
        starts += 1;
        this.onstart?.();
        if (starts === 1) this.onresult?.({ results: [{ 0: { transcript: "What is in my notes?" }, isFinal: true }] });
      }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    class MockUtterance {
      constructor(text) { this.text = text; }
    }
    window.SpeechRecognition = LiveSpeechRecognition;
    window.speechSynthesis = {
      cancel: vi.fn(),
      speak: vi.fn((utterance) => {
        utterance.onstart?.();
        window.setTimeout(() => utterance.onend?.(), 0);
      })
    };
    global.SpeechSynthesisUtterance = MockUtterance;

    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: /Your local workspace/i });
    await user.click(screen.getByRole("button", { name: "对话" }));
    await user.click(await screen.findByRole("button", { name: "开始语音对话" }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/assistant/chat-stream", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining("What is in my notes?")
    })));
    expect(await screen.findByText("Your notes contain a project summary.")).toBeVisible();
    await waitFor(() => expect(window.speechSynthesis.speak).toHaveBeenCalledOnce());
    await waitFor(() => expect(starts).toBe(2));
    expect(screen.getByRole("button", { name: "结束语音对话" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Listening")).toBeVisible();
  });

  it("keeps streaming microphone dictation in the composer until the user submits it", async () => {
    window.localStorage.setItem("magicBox.assistantVoice.v2", JSON.stringify({ mode: "streaming", profileId: "voice-profile-1", speed: 1, pitch: 0, styleStrength: 0.7 }));
    state.voiceProfiles = [{ id: "voice-profile-1", name: "爱弥斯", conversationModel: { ready: true } }];
    state.models.status = { runtime: "ready", generation: "ready", embeddings: "ready", activeModels: { generation: "qwen-local" } };
    chatReply = { id: "conversation-stream-dictation", title: "Dictated question", messages: [{ id: "dictated-user", role: "user", content: "这是我刚才说的话" }, { id: "dictated-answer", role: "assistant", content: "我听到了。", grounding: "model-only", sources: [] }] };
    const track = { readyState: "live", stop: vi.fn(), addEventListener: vi.fn() };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] })) } });

    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: /Your local workspace/i });
    await user.click(screen.getByRole("button", { name: "对话" }));
    await user.click(await screen.findByRole("button", { name: "Start voice input" }));
    await waitFor(() => expect(liveVoiceMessages.some((message) => message.type === "input.start")).toBe(true));
    const input = liveVoiceMessages.find((message) => message.type === "input.start");
    const socket = liveVoiceSockets.at(-1);
    socket.onmessage?.({ data: JSON.stringify({ type: "input.ended", turnId: input.turnId }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "transcript.final", turnId: input.turnId, text: "这是我刚才说的话" }) });

    expect(await screen.findByPlaceholderText(/输入消息/)).toHaveValue("这是我刚才说的话");
    expect(global.fetch.mock.calls.some(([request]) => request === "/api/assistant/chat-stream")).toBe(false);
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/assistant/chat-stream", expect.objectContaining({ body: expect.stringContaining("这是我刚才说的话") })));
  });

  it("prefers the packaged desktop offline speech bridge", async () => {
    state.models.status = { runtime: "ready", generation: "ready", embeddings: "ready", activeModels: { generation: "qwen-local" } };
    const messageHandlers = new Set();
    const host = {
      StartSpeechRecognition: vi.fn(async () => {}),
      StopSpeechRecognition: vi.fn(async () => {})
    };
    window.chrome = {
      webview: {
        hostObjects: { magicBoxHost: host },
        addEventListener: (_type, handler) => messageHandlers.add(handler),
        removeEventListener: (_type, handler) => messageHandlers.delete(handler)
      }
    };

    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: /Your local workspace/i });
    await user.click(screen.getByRole("button", { name: "对话" }));
    await user.click(await screen.findByRole("button", { name: "Start voice input" }));
    expect(host.StartSpeechRecognition).toHaveBeenCalledOnce();

    messageHandlers.forEach((handler) => handler({ data: "magic-box:speech:result:Summarize the approved files" }));
    expect(await screen.findByPlaceholderText(/输入消息/)).toHaveValue("Summarize the approved files");
    expect(screen.getByRole("button", { name: "Start voice input" })).toBeEnabled();
  });

  it("saves a prepared streaming speaker profile as the Assistant voice", async () => {
    state.voiceProfiles = [{
      id: "voice-profile-1",
      name: "My Local Voice",
      language: "en",
      status: "ready",
      modelVersion: "gpt-sovits-local-v1",
      voiceModel: { engine: "gpt-sovits-local", modelVersion: "gpt-sovits-local-v1" },
      conversationModel: { engine: "cosyvoice3-stream-local", modelVersion: "fun-cosyvoice3-0.5b-2512", state: "ready", ready: true }
    }];
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: /Your local workspace/i });
    await user.click(screen.getByRole("button", { name: "声音设置" }));
    expect(await screen.findByRole("heading", { name: "声音设置" })).toBeVisible();
    await user.click(screen.getByText("克隆音色"));
    expect(await screen.findByRole("option", { name: /My Local Voice/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存并应用" }));
    expect(JSON.parse(window.localStorage.getItem("magicBox.assistantVoice.v4"))).toMatchObject({ mode: "streaming", profileId: "voice-profile-1", voicePipelineVersion: 4 });
  });

  it("migrates a saved trained profile into the single streaming clone voice", async () => {
    window.localStorage.setItem("magicBox.assistantVoice.v1", JSON.stringify({ mode: "trained", profileId: "voice-profile-1", language: "auto", speed: 1, pitch: 0, styleStrength: 0.7, similarityStrength: 0.8 }));
    state.conversations = [{ id: "conversation-trained-voice", title: "Trained voice reply" }];
    state.conversationDetails = {
      "conversation-trained-voice": {
        id: "conversation-trained-voice",
        title: "Trained voice reply",
        messages: [{ id: "message-trained", role: "assistant", content: "This reply uses your trained voice.", grounding: "local-model", sources: [] }]
      }
    };
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: /Your local workspace/i });
    await user.click(screen.getByRole("button", { name: "对话" }));
    await user.click(screen.getByRole("button", { name: "历史" }));
    await user.click(await screen.findByRole("button", { name: "Trained voice reply" }));
    await user.click(await screen.findByRole("button", { name: "Read reply aloud" }));
    await waitFor(() => expect(liveVoiceMessages.some((message) => message.type === "tts.reply.start")).toBe(true));
    expect(liveVoiceMessages.find((message) => message.type === "session.start")).toMatchObject({ profileId: "voice-profile-1" });
    expect(liveVoiceMessages.find((message) => message.type === "tts.segment")?.text).toContain("trained voice");
    expect(global.fetch.mock.calls.some(([input]) => input === "/api/voice-clone/tts")).toBe(false);
  });

  it("automatically streams and speaks a typed reply when voice replies are enabled", async () => {
    window.localStorage.setItem("magicBox.assistantVoice.v1", JSON.stringify({ mode: "trained", profileId: "voice-profile-1", language: "auto", speed: 1, pitch: 0, styleStrength: 0.7, similarityStrength: 0.8 }));
    state.models.status = { runtime: "ready", generation: "ready", embeddings: "ready", activeModels: { generation: "qwen-local" } };
    chatReply = {
      id: "conversation-auto-voice",
      title: "Automatic voice reply",
      messages: [
        { id: "message-auto-user", role: "user", content: "Tell me something useful" },
        { id: "message-auto-assistant", role: "assistant", content: "Here is sentence one. Sentence two remains queued. Sentence three must finish.", grounding: "model-only", sources: [] }
      ]
    };
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: /Your local workspace/i });
    await user.click(screen.getByRole("button", { name: "对话" }));
    const composer = await screen.findByPlaceholderText(/输入消息/);
    await user.type(composer, "Tell me something useful");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/assistant/chat-stream", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(liveVoiceMessages.filter((message) => message.type === "tts.reply.commit")).toHaveLength(1));
    expect(liveVoiceMessages.filter((message) => message.type === "tts.reply.start")).toHaveLength(1);
    expect(liveVoiceMessages.filter((message) => message.type === "tts.segment").map((message) => message.text)).toEqual(["Here is sentence one.", "Sentence two remains queued. Sentence three must finish."]);
    expect(global.fetch.mock.calls.some(([input]) => input === "/api/voice-clone/tts")).toBe(false);
  });

  it("contains source-excerpt focus, closes on Escape, and restores its trigger", async () => {
    state.conversations = [{ id: "conversation-1", title: "Local answer" }];
    state.conversationDetails = {
      "conversation-1": {
        id: "conversation-1",
        title: "Local answer",
        messages: [{ id: "message-1", role: "assistant", content: "Grounded answer", grounding: "workspace", sources: [{ chunkId: "chunk-1", itemId: "item-1", itemRevision: 1, displayName: "notes.txt", excerpt: "A copied local excerpt", liveStatus: "current" }] }]
      }
    };
    const user = userEvent.setup();
    render(<Assistant onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: /Your local workspace/i });
    await user.click(screen.getByRole("button", { name: "对话" }));
    await user.click(screen.getByRole("button", { name: "历史" }));
    await user.click(await screen.findByRole("button", { name: "Local answer" }));
    const trigger = await screen.findByRole("button", { name: "View copied excerpt" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Source excerpt" });
    expect(dialog).toBeVisible();
    expect(screen.getByRole("button", { name: "Close source" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close source" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Source excerpt" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
