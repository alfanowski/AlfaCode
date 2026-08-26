import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ScreenReaderTranscript } from "../src/ui/screen-reader-transcript.js";

describe("screen-reader transcript rendering", () => {
  it("renders plain, labeled lines with no box-drawing characters", () => {
    const view = render(<ScreenReaderTranscript lines={["You: hello", "Assistant: hi there", "Tool (tool): Read — completed"]} busy={false} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("You: hello");
    expect(frame).toContain("Assistant: hi there");
    expect(frame).toContain("Tool (tool): Read — completed");
    expect(frame).not.toMatch(/[┌┐└┘│─╭╮╰╯]/u);
  });

  it("shows a plain 'Working…' status line while busy, and nothing decorative when idle with no history", () => {
    const idle = render(<ScreenReaderTranscript lines={[]} busy={false} />);
    expect(idle.lastFrame()).toContain("Ask AlfaCode anything");

    const busy = render(<ScreenReaderTranscript lines={["You: hello"]} busy />);
    expect(busy.lastFrame()).toContain("Working…");
  });

  it("never shrinks: once a line has been rendered, a later render only ever adds more, it never drops or reorders prior lines", () => {
    const view = render(<ScreenReaderTranscript lines={["You: first"]} busy={false} />);
    expect(view.lastFrame()).toContain("You: first");
    view.rerender(<ScreenReaderTranscript lines={["You: first", "Assistant: second"]} busy={false} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("You: first");
    expect(frame).toContain("Assistant: second");
  });
});
