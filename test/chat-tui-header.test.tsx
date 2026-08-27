import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Header, ThinkingLine, Transcript, transcriptStage, type TranscriptItem } from "../src/chat-tui.js";
import { getTheme } from "../src/ui/theme.js";

const theme = getTheme("nova");

describe("Header", () => {
  const base = { model: "route/model", mode: "default" as const, providers: 3, compatible: true, theme, width: 80 };

  it("keeps every existing piece of information present while ready", () => {
    const frame = render(<Header {...base} busy={false} />).lastFrame() ?? "";
    expect(frame).toContain("AlfaCode");
    expect(frame).toContain("ready");
    expect(frame).toContain("model");
    expect(frame).toContain("3P");
    expect(frame).toContain("default");
  });

  it("keeps every existing piece of information present while busy, plus the mismatch warning", () => {
    const frame = render(<Header {...base} busy compatible={false} />).lastFrame() ?? "";
    expect(frame).toContain("AlfaCode");
    expect(frame).toContain("working");
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

describe("transcriptStage", () => {
  const userItem: TranscriptItem = { id: "u1", role: "user", text: "hello" };
  const assistantItem: TranscriptItem = { id: "a1", role: "assistant", text: "partial answer" };
  const toolItem: TranscriptItem = { id: "t1", role: "tool", text: "Bash", status: "running" };

  it("is idle whenever nothing is busy, regardless of transcript contents", () => {
    expect(transcriptStage([], false)).toBe("idle");
    expect(transcriptStage([userItem, assistantItem], false)).toBe("idle");
  });

  it("is thinking while busy with nothing assistant-authored at the tail yet", () => {
    expect(transcriptStage([userItem], true)).toBe("thinking");
    expect(transcriptStage([], true)).toBe("thinking");
  });

  it("is writing once the tail item is the assistant's own growing reply", () => {
    expect(transcriptStage([userItem, assistantItem], true)).toBe("writing");
  });

  it("is tool whenever the tail item is a tool call, independent of its own status", () => {
    expect(transcriptStage([userItem, toolItem], true)).toBe("tool");
  });
});

describe("Transcript role separation", () => {
  const longUser: TranscriptItem = { id: "u1", role: "user", text: "first line\nsecond line\nthird line" };
  const longAssistant: TranscriptItem = { id: "a1", role: "assistant", text: "para one\n\npara two" };

  it("carries a left rail down every line of a multi-line user message, not just the first", () => {
    const frame = render(<Transcript items={[longUser]} theme={theme} width={80} busy={false} detailed={false} />).lastFrame() ?? "";
    const rows = frame.split("\n").filter((line) => line.includes("line"));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) expect(row.trimStart().startsWith("│")).toBe(true);
  });

  it("carries a left rail down every line of a multi-block assistant reply", () => {
    const frame = render(<Transcript items={[longAssistant]} theme={theme} width={80} busy={false} detailed={false} />).lastFrame() ?? "";
    const rows = frame.split("\n").filter((line) => line.includes("para"));
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.trimStart().startsWith("│")).toBe(true);
  });

  it("keeps the user marker glyph and role text visually distinguishable from an assistant reply", () => {
    const frame = render(<Transcript items={[longUser, longAssistant]} theme={theme} width={80} busy={false} detailed={false} />).lastFrame() ?? "";
    expect(frame).toContain("❯ first line");
    expect(frame).toContain("para one");
  });
});

describe("ToolActivity phrasing (via Transcript)", () => {
  const runningItem: TranscriptItem = { id: "t1", role: "tool", text: "Bash", status: "running" };
  const completedItem: TranscriptItem = { id: "t2", role: "tool", text: "Write", status: "completed" };
  const failedItem: TranscriptItem = { id: "t3", role: "tool", text: "Read", status: "failed" };
  const subagentItem: TranscriptItem = { id: "t4", role: "tool", text: "Task", status: "running", detail: "subagent" };

  it("distinguishes 'waiting for a tool result' with an explicit running verb and ellipsis", () => {
    const frame = render(<Transcript items={[runningItem]} theme={theme} width={80} busy={false} detailed={false} />).lastFrame() ?? "";
    expect(frame).toContain("Running Bash…");
  });

  it("drops the verb once a tool call has landed successfully", () => {
    const frame = render(<Transcript items={[completedItem]} theme={theme} width={80} busy={false} detailed={false} />).lastFrame() ?? "";
    expect(frame).toContain("Write");
    expect(frame).not.toContain("Running Write");
  });

  it("calls out a failure explicitly rather than reusing the same phrasing as success", () => {
    const frame = render(<Transcript items={[failedItem]} theme={theme} width={80} busy={false} detailed={false} />).lastFrame() ?? "";
    expect(frame).toContain("Failed — Read");
  });

  it("still surfaces the subagent detail alongside the status-aware phrasing", () => {
    const frame = render(<Transcript items={[subagentItem]} theme={theme} width={80} busy={false} detailed={false} />).lastFrame() ?? "";
    expect(frame).toContain("Running Task");
    expect(frame).toContain("subagent");
  });
});
