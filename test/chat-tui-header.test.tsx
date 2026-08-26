import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Header, ThinkingLine, Transcript, type TranscriptItem } from "../src/chat-tui.js";
import { getTheme } from "../src/ui/theme.js";

const theme = getTheme("nova");

describe("Header", () => {
  const base = { model: "route/model", mode: "default" as const, providers: 3, compatible: true, theme, width: 80 };

  it("keeps every existing piece of information present while ready", () => {
    const frame = render(<Header {...base} busy={false} />).lastFrame() ?? "";
    expect(frame).toContain("AlfaCode");
    expect(frame).toContain("ready");
    expect(frame).toContain("route");
    expect(frame).toContain("model");
    expect(frame).toContain("3P");
    expect(frame).toContain("default");
  });

  it("keeps every existing piece of information present while busy, plus the mismatch warning", () => {
    const frame = render(<Header {...base} busy compatible={false} />).lastFrame() ?? "";
    expect(frame).toContain("AlfaCode");
    expect(frame).toContain("working");
    expect(frame).toContain("route");
    expect(frame).toContain("model");
    expect(frame).toContain("3P");
    expect(frame).toContain("default");
    expect(frame).toContain("mismatch");
  });

  it("renders a full-width activity rule beneath the info rows in both states", () => {
    const readyFrame = render(<Header {...base} busy={false} />).lastFrame() ?? "";
    const busyFrame = render(<Header {...base} busy />).lastFrame() ?? "";
    expect(readyFrame).toContain("━");
    expect(busyFrame).toContain("━");
  });

  it("degrades correctly at a narrow terminal width without throwing", () => {
    const frame = render(<Header {...base} width={30} busy />).lastFrame() ?? "";
    expect(frame).toContain("AlfaCode");
    expect(frame).toContain("working");
  });

  it("has no background fill on the panel (the old violet tint is gone)", () => {
    // Structural stand-in for "no backgroundColor prop": the rendered frame is plain text/border
    // glyphs on the terminal's own background, not a filled block — there is nothing else this
    // render environment lets us inspect for a removed background color (see the mixHex/ProgressBar
    // tests elsewhere in this suite for why ANSI color isn't asserted directly).
    const frame = render(<Header {...base} busy={false} />).lastFrame() ?? "";
    expect(frame).not.toContain("╭"); // no enclosing rounded border box either
    expect(frame).not.toContain("╮");
  });

  it("signals busy/ready with a flat color+glyph swap, never a cycling animation frame", () => {
    // The ready/busy dot used to cycle through usePulse's glyphs continuously for the whole busy
    // duration — exactly the kind of sustained repaint this component's history warns against. The
    // glyph immediately before the "working"/"ready" label is a flat "●" in both states now, never
    // one of usePulse's other frames (Brand's own separate "✦" icon sits earlier on the same row
    // and is expected regardless of busy state, so the check is anchored to the label itself).
    const busyFrame = render(<Header {...base} busy />).lastFrame() ?? "";
    const readyFrame = render(<Header {...base} busy={false} />).lastFrame() ?? "";
    expect(busyFrame).toContain("● working");
    expect(readyFrame).toContain("● ready");
    for (const otherPulseFrame of ["·", "✧", "✦"]) {
      expect(busyFrame).not.toContain(`${otherPulseFrame} working`);
      expect(readyFrame).not.toContain(`${otherPulseFrame} ready`);
    }
  });
});

describe("ThinkingLine", () => {
  it("shows a distinct 'Thinking…' state before any text has arrived", () => {
    const frame = render(<ThinkingLine theme={theme} writing={false} />).lastFrame() ?? "";
    expect(frame).toContain("Thinking…");
    expect(frame).not.toContain("Writing…");
  });

  it("shows a distinct 'Writing…' state while assistant text is actively streaming", () => {
    const frame = render(<ThinkingLine theme={theme} writing />).lastFrame() ?? "";
    expect(frame).toContain("Writing…");
    expect(frame).not.toContain("Thinking…");
  });
});

describe("Transcript busy indicator", () => {
  const userItem: TranscriptItem = { id: "u1", role: "user", text: "hello" };
  const assistantItem: TranscriptItem = { id: "a1", role: "assistant", text: "partial answer" };
  const toolItem: TranscriptItem = { id: "t1", role: "tool", text: "Bash", status: "running" };

  it("shows 'Thinking…' when busy and no assistant text has arrived yet for this turn", () => {
    const frame = render(<Transcript items={[userItem]} theme={theme} width={80} busy detailed={false} />).lastFrame() ?? "";
    expect(frame).toContain("Thinking…");
    expect(frame).not.toContain("Writing…");
  });

  it("switches to 'Writing…' once assistant text is the active streaming target", () => {
    const frame = render(<Transcript items={[userItem, assistantItem]} theme={theme} width={80} busy detailed={false} />).lastFrame() ?? "";
    expect(frame).toContain("Writing…");
    expect(frame).not.toContain("Thinking…");
  });

  it("hides the indicator once a tool call is the last row (its own spinner covers that)", () => {
    const frame = render(<Transcript items={[userItem, toolItem]} theme={theme} width={80} busy detailed={false} />).lastFrame() ?? "";
    expect(frame).not.toContain("Thinking…");
    expect(frame).not.toContain("Writing…");
  });

  it("shows neither state once the turn is no longer busy", () => {
    const frame = render(<Transcript items={[userItem, assistantItem]} theme={theme} width={80} busy={false} detailed={false} />).lastFrame() ?? "";
    expect(frame).not.toContain("Thinking…");
    expect(frame).not.toContain("Writing…");
  });
});
