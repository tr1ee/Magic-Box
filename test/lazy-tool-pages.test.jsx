import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App, { ToolPageLoadingFallback } from "../src/App.jsx";
import AccessibleConfirmationDialog from "../src/components/AccessibleConfirmationDialog.jsx";
import { isVoiceJobTerminal } from "../src/pages/VoiceClonePage.jsx";

function json(payload) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" }
  });
}

function installAppFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    const path = new URL(String(input), "http://magic-box.local").pathname;
    if (path === "/api/config") {
      return json({ platform: "win32", defaultDownloadDir: "", savedToolPaths: {} });
    }
    if (path === "/api/torrents" || path === "/api/history") {
      return json([]);
    }
    return json({ error: `Unexpected request: ${path}` }, 500);
  }));
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("lazy tool pages", () => {
  it("renders and executes the shared destructive-action confirmation dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConfirm = vi.fn(async () => {});
    render(<AccessibleConfirmationDialog
      confirmation={{
        title: "Delete saved model?",
        description: "This removes its unshared files.",
        confirmLabel: "Delete model",
        onConfirm
      }}
      onClose={onClose}
    />);

    await user.click(screen.getByRole("button", { name: "Delete model" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("treats review-required and rejected voice jobs as terminal", () => {
    expect(isVoiceJobTerminal({ status: "needs-review" })).toBe(true);
    expect(isVoiceJobTerminal({ status: "rejected" })).toBe(true);
    expect(isVoiceJobTerminal({ status: "running" })).toBe(false);
  });

  it("keeps a persisted active view while its deferred page becomes ready", async () => {
    window.localStorage.setItem("magicBox.openingSeen.v1", "true");
    window.localStorage.setItem("magicBox.activeView.v1", "images");
    installAppFetch();

    render(<App />);

    expect(await screen.findByRole("heading", { name: "No images scanned yet" })).toBeVisible();
    expect(window.localStorage.getItem("magicBox.activeView.v1")).toBe("images");
  });

  it("navigates from Toolbox into a deferred Video Downloader page", async () => {
    window.localStorage.setItem("magicBox.openingSeen.v1", "true");
    installAppFetch();
    const user = userEvent.setup();

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open Video Downloader" }));

    expect(await screen.findByRole("heading", { name: "No videos scanned yet" })).toBeVisible();
    expect(window.localStorage.getItem("magicBox.activeView.v1")).toBe("videos");
  });

  it("uses a clear, keyboard-safe loading state while a page module is pending", () => {
    render(<ToolPageLoadingFallback label="Image Downloader" />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading Image Downloader…")).toBeVisible();
  });
});
