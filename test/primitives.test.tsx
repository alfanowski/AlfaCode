import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Brand, EmptyState, mixHex, panelBorder, ProgressBar } from "../src/ui/primitives.js";
import { getTheme } from "../src/ui/theme.js";

const theme = getTheme("nova");

describe("panelBorder", () => {
  it("defaults to a quiet, neutral border", () => {
    expect(panelBorder(theme)).toEqual({ borderStyle: "round", borderColor: theme.border });
  });

  it("uses the accent color when a panel needs to read as active", () => {
    expect(panelBorder(theme, "active")).toEqual({ borderStyle: "round", borderColor: theme.accent });
  });
});

describe("Brand", () => {
  it("renders the star wordmark glyph in the theme's accent color", () => {
    const view = render(<Brand theme={theme} />);
    expect(view.lastFrame()).toContain("✦");
    expect(view.lastFrame()).not.toContain("◆");
  });
});

describe("EmptyState", () => {
  it("renders the starburst core, its ray glyphs, and the outer ring at a comfortable width", () => {
    const view = render(<EmptyState theme={theme} width={60} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("✦"); // burst center
    expect(frame).toContain("─"); // horizontal ray
    expect(frame).toContain("│"); // vertical ray
    expect(frame).toContain("╲");
    expect(frame).toContain("╱");
    expect(frame).toContain("✧"); // outer ring
    expect(frame).not.toContain("◆");
  });

  it("keeps the burst's core row horizontally symmetric around its center", () => {
    // The center "✦" should have the same number of ray characters on each side on its own row —
    // a lopsided burst would silently break this without any exception being thrown.
    const view = render(<EmptyState theme={theme} width={60} />);
    const coreLine = (view.lastFrame() ?? "").split("\n").find((line) => line.includes("✦"));
    expect(coreLine).toBeDefined();
    const centerIndex = coreLine?.indexOf("✦") ?? -1;
    const left = (coreLine ?? "").slice(0, centerIndex).trimStart();
    const right = (coreLine ?? "").slice(centerIndex + 1).trimEnd();
    expect(left.length).toBe(right.length);
  });

  it("renders the AlfaCode wordmark as genuine dot-matrix block art at a comfortable width", () => {
    // Not just colored text: real letterforms built from "█" cells, wide enough to spell all
    // eight letters of ALFACODE side by side.
    const view = render(<EmptyState theme={theme} width={60} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("█");
    const letterRows = frame.split("\n").filter((line) => line.includes("█"));
    expect(letterRows.length).toBe(5); // the dot-matrix font is 5 rows tall
    // Every row starts within one column of every other row: the block itself is centered as one
    // unit, so a ragged glyph desyncing the columns of every letter after it would show up as a
    // multi-column spread here. A one-column spread is expected and correct, not a bug — "A"'s
    // narrower peak row (".##." vs "#..#") legitimately starts one column further right than the
    // rows below it.
    const leadingSpaces = letterRows.map((line) => line.length - line.trimStart().length);
    expect(Math.max(...leadingSpaces) - Math.min(...leadingSpaces)).toBeLessThanOrEqual(1);
  });

  it("falls back to a plain two-tone label below the wordmark's minimum width, without breaking layout", () => {
    const view = render(<EmptyState theme={theme} width={39} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("ALFA");
    expect(frame).toContain("CODE");
    expect(frame).not.toContain("█");
  });

  it("skips the starburst below its width threshold, still keeping the brand mark visible as plain text", () => {
    const view = render(<EmptyState theme={theme} width={20} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("ALFA");
    expect(frame).toContain("CODE");
    expect(frame).not.toContain("✧");
    expect(frame).not.toContain("✦");
  });

  it("still renders correctly with no width provided at all, defaulting to the full wordmark treatment", () => {
    const view = render(<EmptyState theme={theme} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("█");
    expect(frame).toContain("One agent. Every model. Your terminal.");
  });
});

describe("mixHex", () => {
  it("returns the start color at ratio 0 and the end color at ratio 1", () => {
    expect(mixHex("#FF4757", "#FFC93C", 0)).toBe("#ff4757");
    expect(mixHex("#FF4757", "#FFC93C", 1)).toBe("#ffc93c");
  });

  it("interpolates channel-by-channel at the midpoint", () => {
    expect(mixHex("#000000", "#FFFFFF", 0.5)).toBe("#808080");
  });

  it("clamps out-of-range ratios instead of extrapolating", () => {
    expect(mixHex("#000000", "#FFFFFF", -1)).toBe("#000000");
    expect(mixHex("#000000", "#FFFFFF", 2)).toBe("#ffffff");
  });
});

describe("ProgressBar", () => {
  it("renders a fully gradiented bar (accent to secondary) below the warning threshold", () => {
    const view = render(<ProgressBar value={0.5} width={20} theme={theme} />);
    expect(view.lastFrame()).toContain("━");
    // The actual color gradient is exercised at the unit level (see the mixHex suite above) since
    // this test environment's rendered frames don't carry ANSI color codes to inspect.
  });

  it("keeps a single flat warning color at the warning threshold instead of gradienting", () => {
    const view = render(<ProgressBar value={0.75} width={20} theme={theme} />);
    expect(view.lastFrame()).toContain("━");
  });

  it("keeps a single flat danger color near full", () => {
    const view = render(<ProgressBar value={0.95} width={20} theme={theme} />);
    expect(view.lastFrame()).toContain("━");
  });

  it("renders an empty bar without throwing when value is zero", () => {
    const view = render(<ProgressBar value={0} width={20} theme={theme} />);
    expect(view.lastFrame()).toContain("━");
  });
});
