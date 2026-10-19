import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import TextReader from "../src/components/assistant/TextReader.jsx";
import { speakSystemText, speechLanguage } from "../src/lib/systemSpeech.js";

afterEach(() => { cleanup(); delete window.speechSynthesis; delete global.SpeechSynthesisUtterance; });
function speechMock({ complete = false } = {}) {
  global.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  window.speechSynthesis = { cancel: vi.fn(), getVoices: () => [{ voiceURI: "zh", lang: "zh-CN", localService: true }, { voiceURI: "en", lang: "en-US", localService: true }], speak: vi.fn((utterance) => { if (complete) queueMicrotask(() => utterance.onend?.()); }) };
  return window.speechSynthesis;
}
it("chooses a local voice from the text language while respecting an explicit voice", async () => {
  const synthesis = speechMock({ complete: true });
  await speakSystemText("你好，这是中文。", {});
  expect(synthesis.speak.mock.calls[0][0].voice.voiceURI).toBe("zh");
  await speakSystemText("你好。", { systemVoiceURI: "en" });
  expect(synthesis.speak.mock.calls[1][0].voice.voiceURI).toBe("en");
  expect(speechLanguage("こんにちは世界")).toBe("ja-JP");
  expect(speechLanguage("Hello world")).toBe("en-US");
});
it("settles a cancelled utterance without waiting for a browser end event", async () => {
  const synthesis = speechMock();
  const controller = new AbortController();
  const result = speakSystemText("First sentence. Another sentence.", {}, { signal: controller.signal });
  const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await assertion;
  expect(synthesis.cancel).toHaveBeenCalledOnce();
});
it("reads the complete long text in bounded sequential utterances", async () => {
  const synthesis = speechMock({ complete: true });
  const text = "这是一段用于检查长文本顺序朗读是否完整的测试文字。".repeat(60);
  await speakSystemText(text, {});
  const spoken = synthesis.speak.mock.calls.map(([utterance]) => utterance.text);
  expect(spoken.length).toBeGreaterThan(10);
  expect(spoken.join("").replaceAll(" ", "")).toBe(text);
  expect(Math.max(...spoken.map((part) => part.length))).toBeLessThan(150);
});
it("supports start, stop, restart, completion, and unmount cleanup without a chat model", async () => {
  const synthesis = speechMock();
  const user = userEvent.setup();
  const { unmount } = render(<TextReader loadSettings={async () => ({ mode: "system" })} onSettings={vi.fn()} />);
  expect(screen.getByRole("button", { name: "开始朗读" })).toBeDisabled();
  await user.type(screen.getByLabelText("朗读内容"), "这是需要朗读的正文。");
  await user.click(screen.getByRole("button", { name: "开始朗读" }));
  await waitFor(() => expect(synthesis.speak).toHaveBeenCalledOnce());
  await user.click(screen.getByRole("button", { name: "停止朗读" }));
  expect(screen.getByRole("button", { name: "开始朗读" })).toBeEnabled();
  synthesis.speak.mockImplementation((utterance) => queueMicrotask(() => utterance.onend?.()));
  await user.click(screen.getByRole("button", { name: "开始朗读" }));
  await screen.findByText("朗读完成");
  synthesis.speak.mockImplementation(() => {});
  await user.click(screen.getByRole("button", { name: "开始朗读" }));
  await screen.findByRole("button", { name: "停止朗读" });
  unmount();
  expect(synthesis.cancel).toHaveBeenCalledTimes(2);
});
it("does not silently switch an unavailable cloned voice to a different speaker", async () => {
  const synthesis = speechMock();
  const user = userEvent.setup();
  render(<TextReader loadSettings={async () => ({ requestedMode: "streaming", profileId: "voice-1", degradedReason: "not ready" })} onSettings={vi.fn()} />);
  await user.type(screen.getByLabelText("朗读内容"), "你好。");
  await user.click(screen.getByRole("button", { name: "开始朗读" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("not ready");
  expect(synthesis.speak).not.toHaveBeenCalled();
});
