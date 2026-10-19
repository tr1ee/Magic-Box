import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import App, { ToolboxHome } from "../src/App.jsx";

function json(payload) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Magic Box toolbox carousel", () => {
  it("starts on the supplied world", () => {
    render(<ToolboxHome initialWorldId="images" onNavigate={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Open Image Downloader" }))
      .toHaveAttribute("aria-current", "true");
  });

  it("tracks a pointer drag before committing the next world", () => {
    render(<ToolboxHome initialWorldId="assistant" onNavigate={vi.fn()} />);
    const stage = screen.getByRole("region", { name: /tool carousel/i });

    fireEvent.pointerDown(stage, { button: 0, clientX: 720, pointerId: 1, timeStamp: 10 });
    fireEvent.pointerMove(stage, { clientX: 480, pointerId: 1, timeStamp: 40 });

    expect(stage).toHaveClass("is-dragging");
    expect(stage.style.getPropertyValue("--carousel-drag-offset")).toBe("-240px");

    fireEvent.pointerUp(stage, { clientX: 480, pointerId: 1, timeStamp: 60 });

    expect(stage).not.toHaveClass("is-dragging");
    expect(screen.getByRole("button", { name: "Open Torrent Downloader" }))
      .toHaveAttribute("aria-current", "true");
  });

  it("contains the Private Assistant poster world", () => {
    render(<ToolboxHome initialWorldId="assistant" onNavigate={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Open Private Assistant" }))
      .toHaveAttribute("data-world", "assistant");
  });

  it("gives Private Assistant a dedicated Quiet Observatory cover", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

    expect(styles).toContain('.world-poster[data-world="assistant"] .world-poster-art');
    expect(styles).toContain('.world-poster[data-world="assistant"] .poster-form-five');
  });

  it("returns to the last opened world without persisting a carousel key", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("magicBox.openingSeen.v1", "true");
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const path = new URL(String(input), "http://magic-box.local").pathname;
      if (path === "/api/config") {
        return json({ platform: "win32", defaultDownloadDir: "", savedToolPaths: {} });
      }
      return json([]);
    }));

    render(<App />);

    await user.click(screen.getByRole("button", { name: "Open Image Downloader" }));
    await user.click(await screen.findByRole("button", { name: "Toolbox" }));

    expect(screen.getByRole("button", { name: "Open Image Downloader" }))
      .toHaveAttribute("aria-current", "true");
    expect(window.localStorage.getItem("magicBox.carouselWorld")).toBeNull();
  });
});
