import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkflowDemo } from "./WorkflowDemo";
let top: number;
let reduced: boolean;
let mediaChange: ((event: MediaQueryListEvent) => void) | undefined;
let frame: FrameRequestCallback | undefined;
const animate = vi.fn();
const cancel = vi.fn();
const disconnect = vi.fn();
beforeEach(() => {
  top = 880;
  reduced = false;
  mediaChange = undefined;
  frame = undefined;
  vi.clearAllMocks();
  vi.stubGlobal("innerHeight", 1000);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({
      top,
      height: 400,
      bottom: top + 400,
      left: 0,
      right: 600,
      width: 600,
      x: 0,
      y: top,
      toJSON() {},
    }),
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback) => {
      frame = callback;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  window.matchMedia = vi.fn().mockReturnValue({
    get matches() {
      return reduced;
    },
    addEventListener: vi.fn((_, callback) => {
      mediaChange = callback;
    }),
    removeEventListener: vi.fn(),
  });
  animate.mockImplementation(() => ({
    cancel,
    finished: new Promise(() => {}),
  }));
  HTMLElement.prototype.animate = animate;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, isIntersecting: true }] as IntersectionObserverEntry[],
          this as unknown as IntersectionObserver,
        );
      }
      unobserve() {}
      disconnect = disconnect;
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function scroll(value: number) {
  top = value;
  act(() => {
    fireEvent.scroll(window);
    const callback = frame;
    frame = undefined;
    callback?.(0);
  });
}
it("scrubs the illustration forward and backward with normal page scrolling", () => {
  const { container } = render(<WorkflowDemo />);
  const demo = container.querySelector<HTMLElement>("[data-workflow-demo]")!;
  expect(demo).not.toBeNull();
  expect(demo.style.getPropertyValue("--demo-progress")).toBe("0.0000");
  scroll(490);
  expect(demo.style.getPropertyValue("--demo-progress")).toBe("0.5000");
  expect(screen.getByText("Connected editor").closest("li")).toHaveAttribute(
    "data-current",
  );
  scroll(100);
  expect(demo.style.getPropertyValue("--demo-progress")).toBe("1.0000");
  scroll(880);
  expect(demo.style.getPropertyValue("--demo-progress")).toBe("0.0000");
});
it("keeps a static readable illustration when reduced motion is enabled", () => {
  reduced = true;
  const { container } = render(<WorkflowDemo />);
  expect(container.querySelector("[data-scroll-ready]")).toBeNull();
  expect(animate).not.toHaveBeenCalled();
  expect(screen.getByText(/Do not edit anything/)).toBeVisible();
});
it("cancels entrances and resets the illustration when the preference changes", () => {
  const { container, unmount } = render(<WorkflowDemo />);
  expect(animate).toHaveBeenCalled();
  act(() => {
    reduced = true;
    mediaChange?.({ matches: true } as MediaQueryListEvent);
  });
  expect(cancel).toHaveBeenCalled();
  expect(container.querySelector("[data-scroll-ready]")).toBeNull();
  act(() => {
    reduced = false;
    mediaChange?.({ matches: false } as MediaQueryListEvent);
  });
  expect(container.querySelector("[data-scroll-ready]")).not.toBeNull();
  fireEvent.scroll(window);
  unmount();
  expect(cancelAnimationFrame).toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalled();
});
