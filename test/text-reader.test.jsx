import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import TextReader from "../src/components/assistant/TextReader.jsx";
import { LiveVoiceClient } from "../src/liveVoice.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("queues an entire article in one turn before playback completes and cancels it as one operation", async () => {
  let finish;
  const start = vi.spyOn(LiveVoiceClient.prototype, "startTts").mockResolvedValue("reading");
  const append = vi.spyOn(LiveVoiceClient.prototype, "appendSegment").mockImplementation(() => {});
  const commit = vi.spyOn(LiveVoiceClient.prototype, "commitReply").mockImplementation(() => {});
  vi.spyOn(LiveVoiceClient.prototype, "waitForPlayback").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const close = vi.spyOn(LiveVoiceClient.prototype, "close").mockResolvedValue();
  render(<TextReader loadSettings={async () => ({ mode: "streaming", profileId: "voice" })} />);
  const article = "请自然地读出这句话，然后继续下一段。".repeat(40);
  fireEvent.change(screen.getByLabelText("朗读内容"), { target: { value: article } });
  fireEvent.click(screen.getByRole("button", { name: "开始朗读" }));
  await waitFor(() => expect(commit).toHaveBeenCalledOnce());
  expect(start).toHaveBeenCalledOnce();
  expect(append.mock.calls.length).toBeGreaterThan(3);
  expect(append.mock.calls.map(([text]) => text).join("").replace(/\s/g, "")).toBe(article);
  fireEvent.click(screen.getByRole("button", { name: "停止朗读" }));
  expect(close).toHaveBeenCalled();
  finish();
  await waitFor(() => expect(screen.getByRole("button", { name: "开始朗读" })).toBeEnabled());
  expect(start).toHaveBeenCalledOnce();
});
