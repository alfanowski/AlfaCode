import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BackgroundTasksPanel, parseBackgroundTasksChanged } from "../src/ui/background-tasks-panel.js";
import { resolveTheme } from "../src/ui/theme.js";

const theme = resolveTheme({ ALFACODE_THEME: "dark" });

function changedMessage(tasks: readonly { readonly task_id: string; readonly task_type: string; readonly description: string }[]): SDKMessage {
  return { type: "system", subtype: "background_tasks_changed", uuid: "u", session_id: "s", tasks } as unknown as SDKMessage;
}

describe("parseBackgroundTasksChanged", () => {
  it("replaces local state with the full live set from the message", () => {
    const tasks = parseBackgroundTasksChanged(changedMessage([
      { task_id: "1", task_type: "local_bash", description: "npm run build" },
      { task_id: "2", task_type: "local_agent", description: "Refactor module" },
    ]));
    expect(tasks).toEqual([
      { taskId: "1", taskType: "local_bash", description: "npm run build" },
      { taskId: "2", taskType: "local_agent", description: "Refactor module" },
    ]);
  });

  it("returns an empty array (not undefined) when every background task has finished", () => {
    expect(parseBackgroundTasksChanged(changedMessage([]))).toEqual([]);
  });

  it("sanitizes terminal control sequences in the task description", () => {
    const esc = String.fromCharCode(27);
    const tasks = parseBackgroundTasksChanged(changedMessage([{ task_id: "1", task_type: "local_bash", description: `run${esc}[31m!` }]));
    expect(tasks?.[0]?.description).toBe("run!");
  });

  it("ignores unrelated system messages", () => {
    const message = { type: "system", subtype: "notification", uuid: "u", session_id: "s", text: "hi" } as unknown as SDKMessage;
    expect(parseBackgroundTasksChanged(message)).toBeUndefined();
  });

  it("ignores non-system messages", () => {
    const message = { type: "result", uuid: "u", session_id: "s", subtype: "success", is_error: false, result: "ok" } as unknown as SDKMessage;
    expect(parseBackgroundTasksChanged(message)).toBeUndefined();
  });
});

describe("BackgroundTasksPanel", () => {
  it("renders nothing when no background task is live", () => {
    const view = render(<BackgroundTasksPanel tasks={[]} theme={theme} />);
    expect(view.lastFrame()).toBe("");
  });

  it("lists live background tasks with their type and description", () => {
    const view = render(<BackgroundTasksPanel tasks={[
      { taskId: "1", taskType: "local_bash", description: "npm run build" },
      { taskId: "2", taskType: "local_agent", description: "Refactor module" },
    ]} theme={theme} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("2 running");
    expect(frame).toContain("npm run build");
    expect(frame).toContain("Refactor module");
  });

  it("caps the visible list and shows a remainder count", () => {
    const tasks = Array.from({ length: 6 }, (_unused, index) => ({ taskId: `${index}`, taskType: "local_bash", description: `task ${index}` }));
    const view = render(<BackgroundTasksPanel tasks={tasks} theme={theme} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("+2 more");
  });
});
