import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useTerminalResize } from "../src/chat-tui.js";

function ResizeProbe({ stdout, debounceMs }: { readonly stdout: EventEmitter; readonly debounceMs: number }): React.JSX.Element {
  const generation = useTerminalResize(stdout, debounceMs);
  return <Text>{generation}</Text>;
}

// Real timers, not fake ones: mixing fake timers with a React re-render Ink actually has to commit
// and paint is a known-flaky combination (see motion.test.tsx's own note on this). The debounce
// window is kept small so these still run fast.
async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("useTerminalResize", () => {
  it("does not rerender on mount — only in response to an actual resize", async () => {
    const stdout = new EventEmitter();
    const view = render(<ResizeProbe stdout={stdout} debounceMs={20} />);
    await wait(30);
    expect(view.lastFrame()).toBe("0");
    view.unmount();
  });

  it("triggers exactly one rerender after a resize event, once the debounce window elapses", async () => {
    const stdout = new EventEmitter();
    const view = render(<ResizeProbe stdout={stdout} debounceMs={20} />);
    stdout.emit("resize");
    await wait(10);
    expect(view.lastFrame()).toBe("0"); // debounce hasn't elapsed yet — no premature rerender
    await wait(20);
    expect(view.lastFrame()).toBe("1");
    view.unmount();
  });

  it("coalesces a burst of resize events within the debounce window into a single rerender", async () => {
    // Regression guard for the exact failure mode the task called out: a terminal firing many
    // resize events during one drag-resize gesture must not cause one React re-render per event.
    const stdout = new EventEmitter();
    const view = render(<ResizeProbe stdout={stdout} debounceMs={20} />);
    for (let i = 0; i < 10; i += 1) {
      stdout.emit("resize");
      await wait(5); // well under the 20ms debounce, so each emit keeps re-arming the same timer
    }
    await wait(30);
    expect(view.lastFrame()).toBe("1"); // one coalesced rerender, not ten
    view.unmount();
  });

  it("keeps rerendering across separate, well-spaced resizes (not just the first one)", async () => {
    const stdout = new EventEmitter();
    const view = render(<ResizeProbe stdout={stdout} debounceMs={20} />);
    stdout.emit("resize");
    await wait(30);
    expect(view.lastFrame()).toBe("1");
    stdout.emit("resize");
    await wait(30);
    expect(view.lastFrame()).toBe("2");
    view.unmount();
  });

  it("removes its resize listener on unmount instead of leaking it", async () => {
    const stdout = new EventEmitter();
    const view = render(<ResizeProbe stdout={stdout} debounceMs={20} />);
    await wait(10);
    expect(stdout.listenerCount("resize")).toBe(1);
    view.unmount();
    expect(stdout.listenerCount("resize")).toBe(0);
  });

  it("clears a pending debounce timer on unmount instead of leaking it or updating state after unmount", async () => {
    const stdout = new EventEmitter();
    const view = render(<ResizeProbe stdout={stdout} debounceMs={20} />);
    await wait(10);
    stdout.emit("resize"); // arms a pending timer that has not fired yet
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    view.unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
