import { useEffect, useRef, useState } from "react";
import { Play, Square, Settings2, Volume2 } from "lucide-react";
import { LiveVoiceClient } from "../../liveVoice.js";
import { speakSystemText } from "../../lib/systemSpeech.js";
import { renderSpokenText } from "../../../shared/spoken-text-renderer.mjs";
import { readingPassages } from "../../../shared/reading-plan.mjs";

export default function TextReader({ loadSettings, onSettings, initialText = "", onTextChange }) {
  const [text, setText] = useState(initialText);
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(null);
  const operation = useRef(null);
  const busy = state === "preparing" || state === "speaking";
  function stop() {
    const current = operation.current;
    operation.current = null;
    current?.controller.abort();
    void current?.client?.close();
    setState("idle");
  }
  useEffect(() => () => {
    const current = operation.current;
    operation.current = null;
    current?.controller.abort();
    void current?.client?.close();
  }, []);
  async function start() {
    if (operation.current || !text.trim()) return;
    const current = { controller: new AbortController(), client: null };
    operation.current = current;
    setError("");
    setProgress(null);
    setState("preparing");
    try {
      const settings = await loadSettings({ signal: current.controller.signal });
      if (current.controller.signal.aborted) return;
      const spoken = renderSpokenText(text);
      if (!spoken) throw new Error("没有可朗读的正文，请检查输入内容。");
      if (["streaming", "trained"].includes(settings.requestedMode || settings.mode)) {
        const profileId = settings.requestedProfileId || settings.profileId;
        if (!profileId) throw new Error("请先在声音设置中选择并准备一个音色。");
        if (settings.degradedReason) throw new Error(`所选音色暂不可用：${settings.degradedReason}。请在声音设置中检查。`);
        current.client = new LiveVoiceClient({
          onError: (failure) => {
            if (operation.current !== current) return;
            setError(failure.message);
            stop();
          },
          onPlayback: (event) => {
            if (operation.current !== current) return;
            if (event.speaking) setState("speaking");
            if (Number.isFinite(event.playheadMs)) setProgress({ seconds: Math.floor(event.playheadMs / 1000) });
          }
        });
        const passages = readingPassages(text);
        const turn = await current.client.startTts({ ...settings, mode: "streaming", profileId });
        if (current.controller.signal.aborted) return;
        // One player/turn across the article. The server bounds inference and
        // prefetch; starting a new turn per passage would flush queued audio.
        const playback = current.client.waitForPlayback(turn, Math.max(180000, spoken.length * 1000));
        for (const passage of passages) current.client.appendSegment(passage);
        current.client.commitReply();
        await playback;
      } else {
        setState("speaking");
        await speakSystemText(text, settings, { signal: current.controller.signal, onProgress: setProgress });
      }
      if (operation.current === current) setState("done");
    } catch (failure) {
      if (operation.current === current && failure.name !== "AbortError") {
        setError(failure.message);
        setState("idle");
      }
    } finally {
      void current.client?.close();
      if (operation.current === current) operation.current = null;
    }
  }
  return <div className="assistant-page assistant-reader">
    <header className="assistant-page-header"><div><h1>文本朗读</h1><p>粘贴文章、笔记或一段文字，用你选择的声音朗读。</p></div><button className="assistant-button assistant-button-secondary" onClick={onSettings}><Settings2 size={17} /> 声音设置</button></header>
    <label className="assistant-reader-label" htmlFor="assistant-reader-text">朗读内容</label>
    <textarea id="assistant-reader-text" placeholder="在这里粘贴要朗读的文字…" maxLength={24000} value={text} disabled={busy} onChange={(event) => { setText(event.target.value); onTextChange?.(event.target.value); setState("idle"); }} />
    <div className="assistant-reader-toolbar"><span>{text.length.toLocaleString()} / 24,000 字符</span><button className="assistant-button assistant-button-primary" disabled={!busy && !text.trim()} onClick={busy ? stop : start}>{busy ? <><Square size={16} /> 停止朗读</> : <><Play size={16} /> 开始朗读</>}</button></div>
    <div className="assistant-reader-status" role="status"><Volume2 size={18} /><span>{state === "preparing" ? "正在准备所选音色…" : state === "speaking" ? `正在朗读${progress?.seconds != null ? ` · 已播放 ${progress.seconds} 秒` : progress ? ` · 第 ${progress.index + 1} / ${progress.total} 段` : ""}` : state === "done" ? "朗读完成" : "自动整理 Markdown 和链接，保留正文；连续朗读。"}</span></div>
    {error && <div className="assistant-voice-error" role="alert">{error}</div>}
  </div>;
}
