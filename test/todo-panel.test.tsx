import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseTodoWriteTodos, TodoPanel } from "../src/ui/todo-panel.js";
import { resolveTheme } from "../src/ui/theme.js";

const theme = resolveTheme({ ALFACODE_THEME: "dark" });

function todoWriteMessage(todos: unknown): SDKMessage {
  return {
    type: "assistant",
    uuid: "assistant-1",
    session_id: "session",
    parent_tool_use_id: null,
    message: { id: "msg-1", role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "TodoWrite", input: { todos } }] },
  } as unknown as SDKMessage;
}

describe("parseTodoWriteTodos", () => {
  it("reads the updated todo list straight off a completed TodoWrite tool_use block", () => {
    const todos = parseTodoWriteTodos(todoWriteMessage([
      { content: "Write tests", activeForm: "Writing tests", status: "in_progress" },
      { content: "Ship it", activeForm: "Shipping it", status: "pending" },
    ]));
    expect(todos).toEqual([
      { content: "Write tests", activeForm: "Writing tests", status: "in_progress" },
      { content: "Ship it", activeForm: "Shipping it", status: "pending" },
    ]);
  });

  it("sanitizes terminal control sequences embedded in todo text", () => {
    const esc = String.fromCharCode(27);
    const todos = parseTodoWriteTodos(todoWriteMessage([
      { content: `danger${esc}[31m!`, activeForm: "Working", status: "pending" },
    ]));
    expect(todos?.[0]?.content).toBe("danger!");
  });

  it("ignores assistant messages that are not a TodoWrite tool_use", () => {
    const message = {
      type: "assistant", uuid: "u", session_id: "s", parent_tool_use_id: null,
      message: { id: "m", role: "assistant", content: [{ type: "text", text: "hello" }] },
    } as unknown as SDKMessage;
    expect(parseTodoWriteTodos(message)).toBeUndefined();
  });

  it("ignores malformed todo entries rather than throwing", () => {
    expect(parseTodoWriteTodos(todoWriteMessage([{ content: "missing status" }]))).toBeUndefined();
  });

  it("ignores non-assistant messages", () => {
    const message = { type: "result", uuid: "u", session_id: "s", subtype: "success", is_error: false, result: "ok" } as unknown as SDKMessage;
    expect(parseTodoWriteTodos(message)).toBeUndefined();
  });
});

describe("TodoPanel", () => {
  const todos = [
    { content: "Write tests", activeForm: "Writing tests", status: "in_progress" as const },
    { content: "Ship it", activeForm: "Shipping it", status: "pending" as const },
    { content: "Plan", activeForm: "Planning", status: "completed" as const },
  ];

  it("renders nothing when there are no todos", () => {
    const view = render(<TodoPanel todos={[]} collapsed={false} theme={theme} />);
    expect(view.lastFrame()).toBe("");
  });

  it("shows a collapsed one-line summary with the active task and completion count", () => {
    const view = render(<TodoPanel todos={todos} collapsed theme={theme} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("1/3 done");
    expect(frame).toContain("Writing tests");
    expect(frame).toContain("ctrl+t expand");
  });

  it("lists every task with a status icon when expanded", () => {
    const view = render(<TodoPanel todos={todos} collapsed={false} theme={theme} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Writing tests");
    expect(frame).toContain("Ship it");
    expect(frame).toContain("Plan");
    expect(frame).toContain("ctrl+t collapse");
  });

  // The panel border reads "active" for a moment (via useFlash, see ui/motion.ts) whenever the
  // todo list's status/content signature changes, then settles back to "quiet" — a hook called
  // unconditionally ahead of the panel's own "no todos -> render nothing" early return. Rerendering
  // across the empty <-> populated boundary a few times is what would trip a Rules-of-Hooks
  // violation (mismatched hook count between renders) if that ordering were ever wrong; ANSI border
  // color itself isn't inspectable through ink-testing-library's rendered frames (see
  // ui/primitives.test.tsx), so this asserts the panel keeps rendering correctly across the
  // transitions rather than asserting on color.
  it("keeps rendering correctly across the list appearing, changing, and disappearing", () => {
    const view = render(<TodoPanel todos={[]} collapsed={false} theme={theme} />);
    expect(view.lastFrame()).toBe("");
    view.rerender(<TodoPanel todos={todos} collapsed={false} theme={theme} />);
    expect(view.lastFrame() ?? "").toContain("Writing tests");
    const changed = [{ content: "Write tests", activeForm: "Writing tests", status: "completed" as const }, ...todos.slice(1)];
    view.rerender(<TodoPanel todos={changed} collapsed={false} theme={theme} />);
    expect(view.lastFrame() ?? "").toContain("2/3 done");
    view.rerender(<TodoPanel todos={[]} collapsed={false} theme={theme} />);
    expect(view.lastFrame()).toBe("");
  });
});
