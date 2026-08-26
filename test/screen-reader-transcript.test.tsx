import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ScreenReaderTranscript } from "../src/ui/screen-reader-transcript.js";

describe("screen-reader transcript rendering", () => {
  it("renders plain, labeled lines with no box-drawing characters", () => {
    const view = render(<ScreenReaderTranscript lines={["You: hello", "Assistant: hi there", "Tool (tool): Read — completed"]} stage="idle" />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("You: hello");
    expect(frame).toContain("Assistant: hi there");
    expect(frame).toContain("Tool (tool): Read — completed");
    expect(frame).not.toMatch(/[┌┐└┘│─╭╮╰╯]/u);
  });

  it("shows nothing decorative when idle with no history", () => {
    const idle = render(<ScreenReaderTranscript lines={[]} stage="idle" />);
    expect(idle.lastFrame()).toContain("Ask AlfaCode anything");
  });

  it("distinguishes thinking, writing, and tool-running as distinct plain-text status lines", () => {
    const thinking = render(<ScreenReaderTranscript lines={["You: hello"]} stage="thinking" />);
    expect(thinking.lastFrame()).toContain("Thinking…");

    const writing = render(<ScreenReaderTranscript lines={["You: hello"]} stage="writing" />);
    expect(writing.lastFrame()).toContain("Writing…");

    const tool = render(<ScreenReaderTranscript lines={["You: hello"]} stage="tool" />);
    expect(tool.lastFrame()).toContain("Running a tool…");
  });

  it("never shrinks: once a line has been rendered, a later render only ever adds more, it never drops or reorders prior lines", () => {
    const view = render(<ScreenReaderTranscript lines={["You: first"]} stage="idle" />);
    expect(view.lastFrame()).toContain("You: first");
    view.rerender(<ScreenReaderTranscript lines={["You: first", "Assistant: second"]} stage="idle" />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("You: first");
    expect(frame).toContain("Assistant: second");
  });
});
