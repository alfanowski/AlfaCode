import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StatusBar } from "../src/ui/status-bar.js";
import { getTheme } from "../src/ui/theme.js";

const theme = getTheme("nova");

describe("StatusBar", () => {
  it("renders nothing when there is no message", () => {
    const view = render(<StatusBar message={undefined} theme={theme} />);
    expect(view.lastFrame()).toBe("");
  });

  it("renders the message behind a plain '›' marker, distinct from the transcript's own row markers", () => {
    const view = render(<StatusBar message="Press Ctrl+C again to exit." theme={theme} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("› Press Ctrl+C again to exit.");
    // Neither the transcript's system-row "!" marker nor the composer's bold "❯" prompt marker —
    // StatusBar is a third, deliberately distinct visual channel (see its own doc comment).
    expect(frame).not.toContain("❯");
    expect(frame).not.toContain("!");
  });

  it("has no panel border, unlike bordered boxes such as the composer or a picker panel", () => {
    const view = render(<StatusBar message="Copy to clipboard: on" theme={theme} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).not.toContain("╭");
    expect(frame).not.toContain("╮");
    expect(frame).not.toContain("│");
  });

  // ANSI color itself isn't inspectable through ink-testing-library's rendered frames (see
  // todo-panel.test.tsx / ui/primitives.test.tsx for the same note), so the flash transition —
  // driven by the shared useFlash hook rather than an ad-hoc timer — is exercised for rendering
  // stability across an appearing / changing / clearing message rather than for its color.
  it("keeps rendering correctly across a message appearing, changing, and clearing", () => {
    const view = render(<StatusBar message={undefined} theme={theme} />);
    expect(view.lastFrame()).toBe("");
    view.rerender(<StatusBar message="Press Ctrl+C again to exit." theme={theme} />);
    expect(view.lastFrame() ?? "").toContain("Press Ctrl+C again to exit.");
    view.rerender(<StatusBar message="Model switched to [anthropic] Sonnet 5" theme={theme} />);
    expect(view.lastFrame() ?? "").toContain("Model switched to [anthropic] Sonnet 5");
    expect(view.lastFrame() ?? "").not.toContain("Press Ctrl+C again to exit.");
    view.rerender(<StatusBar message={undefined} theme={theme} />);
    expect(view.lastFrame()).toBe("");
  });
});
