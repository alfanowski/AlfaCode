import { describe, expect, it } from "vitest";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { shouldAnimate, useSpinner, usePulse, spinnerFrames, pulseFrames } from "../src/ui/motion.js";

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
      expect(render(<Spinner />).lastFrame()).toBe(spinnerFrames[0]);
      expect(render(<Pulse />).lastFrame()).toBe(pulseFrames[0]);
    });
  });
});
