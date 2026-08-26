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
