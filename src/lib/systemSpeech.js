import { splitSpeechSegments, coalesceSpeechSegments } from "../../shared/speech-planner.mjs";

export function speechLanguage(text, fallback = "en-US") {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja-JP";
  if (/\p{Script=Hangul}/u.test(text)) return "ko-KR";
  if (/\p{Script=Han}/u.test(text)) return "zh-CN";
  if (/[a-z]/iu.test(text)) return "en-US";
  return fallback;
}

// One utterance at a time keeps long articles reliable in WebView2. Abort must
// settle the promise: speechSynthesis.cancel() does not always emit onend.
export async function speakSystemText(text, settings, { signal, onProgress } = {}) {
  const synthesis = window.speechSynthesis;
  if (!synthesis || typeof SpeechSynthesisUtterance === "undefined") throw new Error("此设备无法朗读，请在声音设置中选择可用的本地音色。");
  const segments = coalesceSpeechSegments(splitSpeechSegments(text));
  if (!segments.length) throw new Error("没有可朗读的文字，请输入正文。");
  for (let index = 0; index < segments.length; index += 1) {
    if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
    const content = segments[index].text;
    await new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(content);
      const voices = (synthesis.getVoices?.() || []).filter((voice) => voice.localService !== false);
      const explicit = voices.find((voice) => voice.voiceURI === settings.systemVoiceURI);
      const language = speechLanguage(content, navigator.language);
      const voice = explicit || voices.find((entry) => entry.lang.toLowerCase() === language.toLowerCase()) || voices.find((entry) => entry.lang.split("-")[0] === language.split("-")[0]);
      utterance.lang = voice?.lang || language;
      if (voice) utterance.voice = voice;
      utterance.rate = Math.max(0.7, Math.min(1.3, Number(settings.speed) || 1));
      utterance.pitch = Math.max(0, Math.min(2, 1 + (Number(settings.pitch) || 0) * 0.35));
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        utterance.onend = null;
        utterance.onerror = null;
        error ? reject(error) : resolve();
      };
      const abort = () => { finish(new DOMException("Stopped", "AbortError")); synthesis.cancel(); };
      signal?.addEventListener("abort", abort, { once: true });
      utterance.onend = () => finish();
      utterance.onerror = (event) => finish(new Error(`系统朗读中断：${event.error || "音色不可用"}。请检查声音设置。`));
      onProgress?.({ index, total: segments.length, text: content });
      try { synthesis.speak(utterance); } catch (error) { finish(error); }
    });
  }
}
