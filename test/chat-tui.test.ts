import { describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { commandSuggestions, createTranscriptItemId, reduceSdkMessage, resolveInitialVimMode, tailItemsByRows } from "../src/chat-tui.js";

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

    expect(tool).toMatchObject([
      { role: "assistant", text: "AlfaCode", streamId: null },
      { id: "tool-three-1", role: "tool", text: "Read", status: "running" },
    ]);
  });

  it("keeps assistant row ids unique across non-adjacent stream segments", () => {
    const first = reduceSdkMessage([], {
      type: "stream_event", uuid: "one", session_id: "session", parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Before tool" } },
    } as unknown as SDKMessage);
    const tool = reduceSdkMessage(first, {
      type: "stream_event", uuid: "two", session_id: "session", parent_tool_use_id: null,
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool", name: "Read", input: {} } },
    } as unknown as SDKMessage);
    const resumed = reduceSdkMessage(tool, {
      type: "stream_event", uuid: "three", session_id: "session", parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "After" } },
    } as unknown as SDKMessage);
    const continued = reduceSdkMessage(resumed, {
      type: "stream_event", uuid: "four", session_id: "session", parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: " tool" } },
    } as unknown as SDKMessage);
    const assistantRows = continued.filter((item) => item.role === "assistant");

    expect(assistantRows.map((item) => item.text)).toEqual(["Before tool", "After tool"]);
    expect(new Set(assistantRows.map((item) => item.id)).size).toBe(2);
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

  it("registers /vim in the default command list", () => {
    expect(commandSuggestions("/vim").map((command) => command.name)).toEqual(["/vim"]);
  });

  it("keeps the newest transcript items within the visible row budget", () => {
    const items = [
      { id: "one", role: "assistant", text: "first" },
      { id: "two", role: "assistant", text: "second" },
      { id: "three", role: "assistant", text: "third" },
    ] as const;
    expect(tailItemsByRows(items, 4, 80).map((item) => item.id)).toEqual(["two", "three"]);
  });

  it("assigns distinct transcript ids to items created in the same tick", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      expect(createTranscriptItemId("user")).not.toBe(createTranscriptItemId("user"));
    } finally {
      now.mockRestore();
    }
  });
});

describe("vim mode initial config", () => {
  it("is off by default, and on for recognized truthy ALFACODE_VIM_MODE values", () => {
    expect(resolveInitialVimMode({})).toBe(false);
    expect(resolveInitialVimMode({ ALFACODE_VIM_MODE: "0" })).toBe(false);
    expect(resolveInitialVimMode({ ALFACODE_VIM_MODE: "nope" })).toBe(false);
    for (const truthy of ["1", "true", "TRUE", "yes", "on"]) {
      expect(resolveInitialVimMode({ ALFACODE_VIM_MODE: truthy })).toBe(true);
    }
  });
});
