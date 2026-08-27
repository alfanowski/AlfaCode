import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  reduceSdkMessage,
  selectableTaskEntries,
  SubagentFocus,
  subagentTranscript,
  Transcript,
  type TranscriptItem,
} from "../src/chat-tui.js";
import { getTheme } from "../src/ui/theme.js";

const theme = getTheme("nova");

describe("Transcript's subagent-picker highlight (selectedTaskId)", () => {
  const running: TranscriptItem = { id: "task-1", role: "tool", text: "Reviewing the diff", status: "running", detail: "subagent", taskId: "1" };
  const other: TranscriptItem = { id: "task-2", role: "tool", text: "Writing docs", status: "running", detail: "subagent", taskId: "2" };
  const plainTool: TranscriptItem = { id: "tool-1", role: "tool", text: "Bash", status: "running" };

  it("marks the highlighted Task row with a cursor and an 'enter to focus' hint", () => {
    const frame = render(<Transcript items={[running, other]} theme={theme} width={80} busy={false} detailed={false} selectedTaskId="task-1" />).lastFrame() ?? "";
    expect(frame).toContain("❯");
    expect(frame).toContain("enter to focus");
  });

  it("hints only the highlighted row, not the others", () => {
    const frame = render(<Transcript items={[running, other]} theme={theme} width={80} busy={false} detailed={false} selectedTaskId="task-1" />).lastFrame() ?? "";
    const lines = frame.split("\n");
    const reviewingLine = lines.find((line) => line.includes("Reviewing the diff"));
    const docsLine = lines.find((line) => line.includes("Writing docs"));
    expect(reviewingLine).toContain("enter to focus");
    expect(docsLine).not.toContain("enter to focus");
  });

  it("shows no cursor or hint at all when nothing is selected", () => {
    const frame = render(<Transcript items={[running, other]} theme={theme} width={80} busy={false} detailed={false} />).lastFrame() ?? "";
    expect(frame).not.toContain("enter to focus");
  });

  it("never hints a plain tool row even if its id happens to match selectedTaskId (defensive: only taskId rows are real picker targets)", () => {
    const frame = render(<Transcript items={[plainTool]} theme={theme} width={80} busy={false} detailed={false} selectedTaskId="tool-1" />).lastFrame() ?? "";
    expect(frame).not.toContain("enter to focus");
  });
});

describe("SubagentFocus", () => {
  const runningTask: TranscriptItem = { id: "task-1", role: "tool", text: "Auditing the migration for locking issues", status: "running", detail: "subagent", taskId: "1", parentToolUseId: "tool-task-1", subagentType: "code-reviewer" };
  const completedTask: TranscriptItem = { ...runningTask, status: "completed", text: "Reviewed 3 files" };
  const subagentAssistant: TranscriptItem = { id: "a-sub", role: "assistant", text: "Looks safe under concurrent writes.", streamId: "tool-task-1" };
  const subagentTool: TranscriptItem = { id: "tool-sub", role: "tool", text: "Read", status: "completed", detail: "subagent", parentToolUseId: "tool-task-1" };

  it("titles the header with the subagent type and shows the esc-to-return hint", () => {
    const frame = render(<SubagentFocus task={runningTask} items={[]} theme={theme} width={80} detailed={false} />).lastFrame() ?? "";
    expect(frame).toContain("Viewing subagent: code-reviewer");
    expect(frame).toContain("esc to return");
  });

  it("falls back to a generic 'subagent' label when the engine doesn't report a subagent type", () => {
    const untyped: TranscriptItem = { id: "task-1", role: "tool", text: runningTask.text, status: "running", detail: "subagent", taskId: "1", parentToolUseId: "tool-task-1" };
    const frame = render(<SubagentFocus task={untyped} items={[]} theme={theme} width={80} detailed={false} />).lastFrame() ?? "";
    expect(frame).toContain("Viewing subagent: subagent");
  });

  it("shows the task's own live description as a subtitle", () => {
    const frame = render(<SubagentFocus task={runningTask} items={[]} theme={theme} width={80} detailed={false} />).lastFrame() ?? "";
    expect(frame).toContain("Auditing the migration for locking issues");
  });

  it("renders the subagent's own assistant text and tool calls through the ordinary Transcript components", () => {
    const frame = render(<SubagentFocus task={runningTask} items={[subagentAssistant, subagentTool]} theme={theme} width={80} detailed={false} />).lastFrame() ?? "";
    expect(frame).toContain("Looks safe under concurrent writes.");
    expect(frame).toContain("Read");
  });

  it("shows a waiting message while running with no activity yet, distinct from a completed subagent with none", () => {
    const waitingFrame = render(<SubagentFocus task={runningTask} items={[]} theme={theme} width={80} detailed={false} />).lastFrame() ?? "";
    expect(waitingFrame).toContain("Waiting for this subagent's first activity");
    const doneFrame = render(<SubagentFocus task={completedTask} items={[]} theme={theme} width={80} detailed={false} />).lastFrame() ?? "";
    expect(doneFrame).toContain("no visible activity");
  });

  it("stays showing the subagent's completed state rather than needing a running task", () => {
    const frame = render(<SubagentFocus task={completedTask} items={[subagentAssistant]} theme={theme} width={80} detailed={false} />).lastFrame() ?? "";
    expect(frame).toContain("Reviewed 3 files");
    expect(frame).toContain("Looks safe under concurrent writes.");
  });

  it("degrades gracefully instead of crashing when the task row can no longer be found", () => {
    const frame = render(<SubagentFocus task={undefined} items={[]} theme={theme} width={80} detailed={false} />).lastFrame() ?? "";
    expect(frame).toContain("esc to return");
    expect(frame).toContain("no longer part of the transcript");
  });
});

describe("end-to-end: SDK messages -> reduceSdkMessage -> picker/filter -> focus-mode render", () => {
  it("traces a Task launch and its subagent's activity all the way to the focused view", () => {
    let items: readonly TranscriptItem[] = [];
    items = reduceSdkMessage(items, {
      type: "system", subtype: "task_started", uuid: "s1", session_id: "sess", task_id: "task-1",
      tool_use_id: "tool-task-1", subagent_type: "code-reviewer", description: "Starting review",
    } as unknown as SDKMessage);
    items = reduceSdkMessage(items, {
      type: "stream_event", uuid: "e1", session_id: "sess", parent_tool_use_id: "tool-task-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Checking locks…" } },
    } as unknown as SDKMessage);
    items = reduceSdkMessage(items, {
      type: "stream_event", uuid: "e2", session_id: "sess", parent_tool_use_id: "tool-task-1",
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "nested-read", name: "Read", input: {} } },
    } as unknown as SDKMessage);

    // Main-conversation text arriving interleaved shouldn't leak into the subagent's stream.
    items = reduceSdkMessage(items, {
      type: "stream_event", uuid: "e3", session_id: "sess", parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Main agent reply" } },
    } as unknown as SDKMessage);

    const candidates = selectableTaskEntries(items);
    expect(candidates).toHaveLength(1);
    const task = candidates[0]!;
    expect(task.parentToolUseId).toBe("tool-task-1");

    const isolated = subagentTranscript(items, task.parentToolUseId!);
    expect(isolated.map((item) => item.text)).toEqual(["Checking locks…", "Read"]);

    const pickerFrame = render(<Transcript items={items.filter((item) => item.role !== "assistant" || item.streamId === null)} theme={theme} width={80} busy detailed={false} selectedTaskId={task.id} />).lastFrame() ?? "";
    expect(pickerFrame).toContain("enter to focus");

    const focusFrame = render(<SubagentFocus task={task} items={isolated} theme={theme} width={80} detailed={false} />).lastFrame() ?? "";
    expect(focusFrame).toContain("Viewing subagent: code-reviewer");
    expect(focusFrame).toContain("Checking locks…");
    expect(focusFrame).toContain("Read");
    expect(focusFrame).not.toContain("Main agent reply");
  });
});
