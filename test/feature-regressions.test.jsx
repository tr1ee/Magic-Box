import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import HistoryPage from "../src/pages/HistoryPage.jsx";
import PreviewModal from "../src/components/PreviewModal.jsx";
import FileTransferPage from "../src/pages/FileTransferPage.jsx";
import App from "../src/App.jsx";
import { factoryApi } from "../src/FormatFactory.jsx";
import VoiceClonePage from "../src/pages/VoiceClonePage.jsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const room = { id: "room", mode: "lan", networkAvailable: false, urls: [], pairingCode: "123456", connectedDevices: [], sharedFiles: [], receivedFiles: [] };
const transferProps = { onError: vi.fn(), onNotice: vi.fn(), onOpenPath: vi.fn() };

it("renders BT byte counts together with image and video history", () => {
  render(<HistoryPage history={[
    { id: "bt", type: "torrent", name: "Archive torrent", length: 2048, downloaded: 1024, progress: 0.5, status: "downloading" },
    { id: "image", type: "image", sourceUrl: "https://example.com/gallery", downloaded: 2 },
    { id: "video", type: "video", sourceUrl: "https://example.com/video", downloaded: 1 }
  ]} historySearch="" />);
  expect(screen.getByText("Archive torrent")).toBeVisible();
  expect(screen.getByText("1 KB / 2 KB")).toBeVisible();
  expect(screen.getByText("2 saved")).toBeVisible();
});

it("image preview reports decode errors and supports keyboard dismissal", () => {
  const onClose = vi.fn();
  render(<PreviewModal preview={{ title: "broken.png", previewUrl: "blob:broken", mediaType: "image" }} onClose={onClose} />);
  expect(screen.getByRole("button", { name: "Close preview" })).toHaveFocus();
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByText("Preview unavailable.")).toBeVisible();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});

it("restores transfer room under StrictMode and deduplicates files within a single drop", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ session: room })));
  const { container } = render(<StrictMode><FileTransferPage {...transferProps} /></StrictMode>);
  await screen.findByText("Room live");
  const file = new File(["payload"], "note.txt");
  fireEvent.drop(container.querySelector(".transfer-drop-zone"), { dataTransfer: { files: [file, file] } });
  expect(screen.getByText("1 selected")).toBeVisible();
});

it("a delayed room refresh cannot reopen a room after Stop room succeeds", async () => {
  vi.useFakeTimers();
  let resolveRefresh;
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    if (options?.method === "DELETE") return new Response(null, { status: 204 });
    if (++reads === 1) return json({ session: room });
    return new Promise((resolve) => { resolveRefresh = resolve; });
  }));
  render(<FileTransferPage {...transferProps} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop room" })); });
  expect(screen.getByRole("button", { name: "Start transfer room" })).toBeVisible();
  await act(async () => { resolveRefresh(json({ session: room })); });
  expect(screen.queryByText("Room live")).toBeNull();
});

it("Format Factory gives a useful service error for non-JSON failures", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Service unavailable", { status: 503 })));
  await expect(factoryApi("/jobs")).rejects.toThrow("503");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  await expect(factoryApi("/jobs/finished", { method: "DELETE" })).resolves.toBeNull();
});

it.each(["images", "videos"])("%s continues observing a job after a transient status failure without resubmitting it", async (kind) => {
  localStorage.setItem("magicBox.openingSeen.v1", "true");
  localStorage.setItem("magicBox.activeView.v1", kind);
  const image = kind === "images";
  const mediaUrl = `https://example.com/one.${image ? "png" : "mp4"}`;
  const scan = { pageUrl: "https://example.com/gallery", [kind]: [{ url: mediaUrl, filename: image ? "one.png" : "one.mp4", listIndex: 1 }], galleryName: "Test" };
  localStorage.setItem(image ? "magicBox.imageSession.v1" : "magicBox.videoSession.v1", JSON.stringify(image
    ? { imageScan: scan, selectedImageKeys: ["1:full"] }
    : { videoScan: scan, selectedVideoKeys: [`1:${mediaUrl}`] }));
  let creates = 0, polls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    if (url === "/api/config") return json({ platform: "win32", savedToolPaths: {} });
    if (url === "/api/history" || url === "/api/torrents") return json([]);
    if (url === `/api/${kind}/download` && options?.method === "POST") { creates++; return json({ id: "job", status: "queued", items: [] }); }
    if (url === `/api/${kind}/download/job`) {
      if (++polls === 1) return json({ error: "Temporary status failure" }, 503);
      return json({ id: "job", status: "complete", items: [], result: { downloaded: 1, failed: 0, skipped: 0, total: 1, files: [], failures: [] } });
    }
    if (String(url).startsWith("/api/images/preview")) return new Response(new Blob(["preview"]));
    return json({});
  }));
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Download selected/ }));
  await waitFor(() => expect(polls).toBe(2), { timeout: 3500 });
  expect(creates).toBe(1);
  expect(screen.queryByRole("button", { name: "Stop", exact: true })).toBeNull();
});

it("voice preparation resumes progress observation after a transient service error", async () => {
  let polls = 0;
  const onNotice = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url === "/api/voice-clone/health") return json({});
    if (url === "/api/voice-clone/preparation-jobs") return json(polls < 2 ? [{ id: "prep", status: "running" }] : []);
    if (url === "/api/voice-clone/jobs/prep") {
      if (++polls === 1) return json({ error: "temporary unavailable" }, 503);
      return json({ id: "prep", status: "completed" });
    }
    return json([]);
  }));
  render(<VoiceClonePage config={{ platform: "win32" }} onError={vi.fn()} onNotice={onNotice} downloadPath="" />);
  await waitFor(() => expect(polls).toBe(2), { timeout: 4000 });
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith("1 local voice source is ready for review."));
});
