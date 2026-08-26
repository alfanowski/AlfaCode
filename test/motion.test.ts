import { describe, expect, it } from "vitest";
import { shouldAnimate } from "../src/ui/motion.js";

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
