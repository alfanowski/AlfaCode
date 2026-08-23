import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { commandSuggestions, reduceSdkMessage, tailItemsByRows } from "../src/chat-tui.js";

describe("chat transcript reducer", () => {
  it("assembles streamed assistant text and exposes tool activity", () => {
    const start = reduceSdkMessage([], {
      type: "stream_event", uuid: "one", session_id: "session", parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Alfa" } },
    } as unknown as SDKMessage);
    const continued = reduceSdkMessage(start, {
      type: "stream_event", uuid: "two", session_id: "session", parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Code" } },
    } as unknown as SDKMessage);
    const tool = reduceSdkMessage(continued, {
      type: "stream_event", uuid: "three", session_id: "session", parent_tool_use_id: null,
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool", name: "Read", input: {} } },
    } as unknown as SDKMessage);

    expect(tool).toEqual([
      { id: "assistant-main", role: "assistant", text: "AlfaCode" },
      { id: "tool-three-1", role: "tool", text: "Read", status: "running" },
    ]);
  });

  it("collapses subagent lifecycle events into one live activity row", () => {
    const started = reduceSdkMessage([], { type: "system", subtype: "task_started", uuid: "one", session_id: "session", task_id: "task", description: "Inspect project" } as unknown as SDKMessage);
    const completed = reduceSdkMessage(started, { type: "system", subtype: "task_notification", uuid: "two", session_id: "session", task_id: "task", status: "completed", summary: "Done" } as unknown as SDKMessage);
    expect(completed).toEqual([{ id: "task-task", role: "tool", text: "Done", detail: "subagent", status: "completed" }]);
  });

  it("marks running tools as completed when the turn finishes", () => {
    const running = [{ id: "tool", role: "tool", text: "Read", status: "running" }] as const;
    const completed = reduceSdkMessage(running, { type: "result", subtype: "success", uuid: "result", session_id: "session", is_error: false, result: "ok" } as unknown as SDKMessage);
    expect(completed[0]?.status).toBe("completed");
  });

  it("filters the slash palette and keeps normal prompts out of it", () => {
    expect(commandSuggestions("/pro").map((command) => command.name)).toEqual(["/providers"]);
    expect(commandSuggestions("explain /model")).toEqual([]);
    expect(commandSuggestions("/model now")).toEqual([]);
  });

  it("keeps the newest transcript items within the visible row budget", () => {
    const items = [
      { id: "one", role: "assistant", text: "first" },
      { id: "two", role: "assistant", text: "second" },
      { id: "three", role: "assistant", text: "third" },
    ] as const;
    expect(tailItemsByRows(items, 4, 80).map((item) => item.id)).toEqual(["two", "three"]);
  });
});
