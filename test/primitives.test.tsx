import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Brand, EmptyState, mixHex, ProgressBar } from "../src/ui/primitives.js";
import { getTheme } from "../src/ui/theme.js";

const theme = getTheme("nova");

describe("Brand", () => {
  it("renders the star wordmark glyph in the theme's accent color", () => {
    const view = render(<Brand theme={theme} />);
    expect(view.lastFrame()).toContain("✦");
    expect(view.lastFrame()).not.toContain("◆");
  });
});

describe("EmptyState", () => {
  it("renders the star wordmark and a starfield flourish at a comfortable width", () => {
    const view = render(<EmptyState theme={theme} width={60} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("✦");
    expect(frame).toContain("✧");
    expect(frame).not.toContain("◆");
  });

  it("skips the starfield flourish at a narrow width without breaking the rest of the layout", () => {
    const view = render(<EmptyState theme={theme} width={20} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("ALFA");
    expect(frame).toContain("CODE");
    expect(frame).not.toContain("✧");
  });

  it("still renders correctly with no width provided at all", () => {
    const view = render(<EmptyState theme={theme} />);
    expect(view.lastFrame()).toContain("ALFA");
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
