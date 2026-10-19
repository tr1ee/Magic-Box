import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StartupExperience from "../src/components/StartupExperience.jsx";

function mount({ reducedMotion = false } = {}) {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} })));
  return render(<StrictMode><StartupExperience><button>Toolbox ready</button></StartupExperience></StrictMode>);
}
function tick(ms) { act(() => vi.advanceTimersByTime(ms)); }
function artworkLoaded(container) {
  fireEvent.load(container.querySelector(".startup-color"));
  fireEvent.loadedData(container.querySelector(".startup-eye-film"));
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("startup experience", () => {
  it("boots the app behind an inert overlay, then reveals it automatically", () => {
    const { container } = mount();
    expect(container.querySelector(".startup-app-content")).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: /跳过并进入/ })).toHaveFocus();
    artworkLoaded(container);
    tick(8700); tick(650);
    expect(screen.queryByRole("region", { name: "Magic Box 启动动画" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toolbox ready" })).toBeVisible();
    expect(container.querySelector(".startup-app-content")).not.toHaveAttribute("inert");
    expect(container.querySelector(".startup-app-content")).toHaveFocus();
  });
  it.each(["Escape", "click"])("supports %s before artwork finishes loading", (method) => {
    mount();
    if (method === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else fireEvent.click(screen.getByRole("button", { name: /跳过并进入/ }));
    tick(650);
    expect(screen.getByRole("button", { name: "Toolbox ready" })).toBeVisible();
  });
  it("does not replay after visibility changes or parent rerenders", () => {
    const { rerender } = mount();
    fireEvent.keyDown(window, { key: "Escape" }); tick(650);
    fireEvent(document, new Event("visibilitychange"));
    rerender(<StrictMode><StartupExperience><button>Toolbox ready</button></StartupExperience></StrictMode>);
    expect(screen.queryByRole("region", { name: "Magic Box 启动动画" })).not.toBeInTheDocument();
  });
  it("shortens the static introduction when reduced motion is preferred", () => {
    const { container } = mount({ reducedMotion: true });
    fireEvent.load(container.querySelector(".startup-color"));
    expect(container.querySelector(".startup-screen")).toHaveClass("is-reduced");
    tick(900); tick(80);
    expect(screen.getByRole("button", { name: "Toolbox ready" })).toBeVisible();
  });
  it("never blocks entry when the portrait fails or stalls", () => {
    const { container, unmount } = mount();
    fireEvent.error(container.querySelector(".startup-color")); tick(650);
    expect(screen.getByRole("button", { name: "Toolbox ready" })).toBeVisible();
    unmount();
    mount(); tick(12000); tick(650);
    expect(screen.getByRole("button", { name: "Toolbox ready" })).toBeVisible();
  });
  it("holds the completed line drawing, transfers color beneath the strokes, then opens the eyes before the welcome", () => {
    const { container } = mount(); artworkLoaded(container);
    const intro = screen.getByRole("region", { name: "Magic Box 启动动画" });
    expect(intro).toHaveAttribute("data-phase", "drawing");
    tick(2700); expect(intro).toHaveAttribute("data-phase", "hold");
    tick(350); expect(intro).toHaveAttribute("data-phase", "impact");
    tick(150); expect(intro).toHaveAttribute("data-phase", "awakening");
    tick(1600); expect(intro).toHaveAttribute("data-phase", "welcome");
    expect(container.querySelector(".startup-app-content")).toHaveAttribute("inert");
  });
  it("waits for the first decoded eye film frame before starting the sequence", () => {
    const { container } = mount();
    fireEvent.load(container.querySelector(".startup-color"));
    tick(2000);
    expect(screen.getByRole("region", { name: "Magic Box 启动动画" })).toHaveAttribute("aria-busy", "true");
    fireEvent.loadedData(container.querySelector(".startup-eye-film"));
    expect(screen.getByRole("region", { name: "Magic Box 启动动画" })).toHaveAttribute("aria-busy", "false");
    tick(2500);
    expect(screen.getByRole("region", { name: "Magic Box 启动动画" })).toHaveAttribute("data-phase", "hold");
  });
  it("plays one continuous eye film after color transfer and cancels it on skip", () => {
    const { container } = mount(); artworkLoaded(container);
    expect(container.querySelectorAll(".startup-eye-film")).toHaveLength(1);
    expect(container.querySelector(".startup-eye-poses")).toBeNull();
    tick(3349); expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    tick(1); expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    tick(650); expect(screen.getByRole("button", { name: "Toolbox ready" })).toBeVisible();
  });
  it("enters the toolbox when the eye film cannot load", () => {
    const { container } = mount();
    fireEvent.error(container.querySelector(".startup-eye-film")); tick(650);
    expect(screen.getByRole("button", { name: "Toolbox ready" })).toBeVisible();
  });

});
