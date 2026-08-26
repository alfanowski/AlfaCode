import { describe, expect, it, vi } from "vitest";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { shouldAnimate, useSpinner, usePulse, useTwinkle, useFlash, spinnerFrames, pulseFrames } from "../src/ui/motion.js";

describe("reduced-motion extension: shouldAnimate", () => {
  it("animates by default in an interactive, color-capable terminal", () => {
    expect(shouldAnimate({ TERM: "xterm-256color" })).toBe(true);
  });

  it("still disables animation for every existing reduced-motion signal (CI, TERM=dumb, ALFACODE_REDUCED_MOTION)", () => {
    expect(shouldAnimate({ CI: "true" })).toBe(false);
    expect(shouldAnimate({ TERM: "dumb" })).toBe(false);
    expect(shouldAnimate({ ALFACODE_REDUCED_MOTION: "1" })).toBe(false);
  });

  it("additionally disables animation in screen-reader mode, even when nothing else asked for reduced motion", () => {
    expect(shouldAnimate({ TERM: "xterm-256color", ALFACODE_SCREEN_READER: "1" })).toBe(false);
    expect(shouldAnimate({ TERM: "xterm-256color", INK_SCREEN_READER: "true" })).toBe(false);
  });
});

function Spinner(): React.JSX.Element { return <Text>{useSpinner()}</Text>; }
function Pulse(): React.JSX.Element { return <Text>{usePulse()}</Text>; }

// useSpinner/usePulse read process.env directly (through shouldAnimate/supportsMotion) rather
// than accepting an environment override, so the animation-gating signals need to be pinned to
// their "animate" values for the duration of these tests, not just assumed from the ambient shell.
const animationEnv = ["CI", "TERM", "ALFACODE_REDUCED_MOTION", "ALFACODE_SCREEN_READER", "INK_SCREEN_READER"] as const;

function withAnimationEnabled<T>(run: () => T): T {
  const original = Object.fromEntries(animationEnv.map((key) => [key, process.env[key]]));
  delete process.env.CI;
  process.env.TERM = "xterm-256color";
  delete process.env.ALFACODE_REDUCED_MOTION;
  delete process.env.ALFACODE_SCREEN_READER;
  delete process.env.INK_SCREEN_READER;
  try {
    return run();
  } finally {
    for (const key of animationEnv) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  }
}

describe("spinner and pulse glyph sequences", () => {
  // The exact frame data is asserted directly (no rendering or fake timers needed — a real
  // setInterval-driven React re-render under fake timers is a known-flaky combination, and the
  // data itself is what actually defines the animation).
  it("uses the orbit/phase glyphs for the spinner, in order", () => {
    expect(spinnerFrames).toEqual(["◐", "◓", "◑", "◒"]);
  });

  it("uses the star-glint glyphs for the pulse, in order", () => {
    expect(pulseFrames).toEqual(["·", "✧", "✦", "✧"]);
  });

  it("renders the first spinner and pulse frame on initial mount", () => {
    withAnimationEnabled(() => {
      // Unmounted after reading, not left running: the shared clock below asserts exact
      // setInterval/clearInterval counts, which a leaked, never-unmounted subscription from an
      // earlier test would silently pollute (harmless under the old one-timer-per-hook design,
      // consequential now that every hook shares one module-level timer).
      const spinner = render(<Spinner />);
      expect(spinner.lastFrame()).toBe(spinnerFrames[0]);
      spinner.unmount();
      const pulse = render(<Pulse />);
      expect(pulse.lastFrame()).toBe(pulseFrames[0]);
      pulse.unmount();
    });
  });
});

function Twinkle({ count }: { readonly count: number }): React.JSX.Element {
  return <Text>{useTwinkle(count).join(",")}</Text>;
}

describe("useTwinkle", () => {
  it("staggers each point's phase by its own index rather than cycling in lockstep", () => {
    withAnimationEnabled(() => {
      // At tick 0 (initial mount), point i's level is (0 + i*1) % 3 — i.e. 0,1,2,0,1,... — so
      // adjacent points start at different brightness levels instead of blinking together.
      const view = render(<Twinkle count={5} />);
      expect(view.lastFrame()).toBe("0,1,2,0,1");
      view.unmount(); // see the shared-clock describe block below for why this matters now
    });
  });

  it("pins every point at its brightest level when animation is disabled", () => {
    process.env.ALFACODE_REDUCED_MOTION = "1";
    try {
      expect(render(<Twinkle count={4} />).lastFrame()).toBe("2,2,2,2");
    } finally {
      delete process.env.ALFACODE_REDUCED_MOTION;
    }
  });

  it("returns an empty sequence for zero points without throwing", () => {
    withAnimationEnabled(() => {
      expect(render(<Twinkle count={0} />).lastFrame()).toBe("");
    });
  });
});

function Flash({ trigger }: { readonly trigger: string }): React.JSX.Element {
  return <Text>{useFlash(trigger) ? "flashing" : "idle"}</Text>;
}

// Effects (as opposed to layout effects) commit asynchronously under ink-testing-library — a
// state update an effect schedules is not necessarily reflected in `lastFrame()` the instant
// `rerender()` returns. A single macrotask tick is enough for React/Ink to settle. Kept
// self-contained (not routed through the synchronous `withAnimationEnabled` above) since that
// helper's plain try/finally would restore the environment before an awaited body finishes.
async function withAnimationEnabledAsync(run: () => Promise<void>): Promise<void> {
  const original = Object.fromEntries(animationEnv.map((key) => [key, process.env[key]]));
  delete process.env.CI;
  process.env.TERM = "xterm-256color";
  delete process.env.ALFACODE_REDUCED_MOTION;
  delete process.env.ALFACODE_SCREEN_READER;
  delete process.env.INK_SCREEN_READER;
  try {
    await run();
  } finally {
    for (const key of animationEnv) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  }
}

async function settle(): Promise<void> {
  // One tick lets a useEffect body run; the state update it schedules (setActive) needs its own
  // render+commit pass, so wait a couple more ticks for that to actually land in lastFrame().
  for (let iteration = 0; iteration < 5; iteration += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("shared animation clock", () => {
  // The regression this whole module was rewritten for: independent per-hook setInterval calls
  // used to compound (a spinner, a pulse, and several parallel tool-call spinners each ticking on
  // their own uncoordinated schedule), forcing Ink to repaint its whole live region far more often
  // than any single animation's own interval would suggest. Every hook below now subscribes to one
  // shared timer instead — mounting several concurrently must start exactly one setInterval, not
  // one per hook, and it must not stop until every last subscriber has unmounted.
  it("starts exactly one setInterval no matter how many animated hooks mount concurrently", async () => {
    await withAnimationEnabledAsync(async () => {
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      const before = setIntervalSpy.mock.calls.length;
      const view = render(<><Spinner /><Pulse /><Twinkle count={3} /></>);
      await settle();
      expect(setIntervalSpy.mock.calls.length - before).toBe(1);
      view.unmount();
      setIntervalSpy.mockRestore();
    });
  });

  it("only stops the shared timer once every subscriber has unmounted", async () => {
    await withAnimationEnabledAsync(async () => {
      const clearIntervalSpy = vi.spyOn(global, "clearInterval");
      const before = clearIntervalSpy.mock.calls.length;
      const a = render(<Spinner />);
      const b = render(<Pulse />);
      await settle();
      a.unmount();
      await settle();
      expect(clearIntervalSpy.mock.calls.length).toBe(before);
      b.unmount();
      await settle();
      expect(clearIntervalSpy.mock.calls.length - before).toBe(1);
      clearIntervalSpy.mockRestore();
    });
  });
});

describe("useFlash", () => {
  it("never flashes on first mount, only on a genuine later change", async () => {
    await withAnimationEnabledAsync(async () => {
      const view = render(<Flash trigger="a" />);
      await settle();
      expect(view.lastFrame()).toBe("idle");
      view.rerender(<Flash trigger="b" />);
      await settle();
      expect(view.lastFrame()).toBe("flashing");
    });
  });

  it("does not re-trigger when rerendered with the same trigger value", async () => {
    await withAnimationEnabledAsync(async () => {
      const view = render(<Flash trigger="a" />);
      view.rerender(<Flash trigger="a" />);
      await settle();
      expect(view.lastFrame()).toBe("idle");
    });
  });

  it("stays idle when animation is disabled, even across trigger changes", async () => {
    process.env.ALFACODE_REDUCED_MOTION = "1";
    try {
      const view = render(<Flash trigger="a" />);
      view.rerender(<Flash trigger="b" />);
      await settle();
      expect(view.lastFrame()).toBe("idle");
    } finally {
      delete process.env.ALFACODE_REDUCED_MOTION;
    }
  });
});
