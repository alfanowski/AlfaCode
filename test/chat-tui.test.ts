import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { commandSuggestions, createTranscriptItemId, describePermissionDecision, reduceSdkMessage, resolveLineEditorOperation, tailItemsByRows } from "../src/chat-tui.js";

function noKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
    home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false,
    backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false,
    ...overrides,
  };
}

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

  it("enriches the running tool row with its full input once the completed assistant content block arrives", () => {
    const started = reduceSdkMessage([], {
      type: "stream_event", uuid: "one", session_id: "session", parent_tool_use_id: null,
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool-use-1", name: "Bash", input: {} } },
    } as unknown as SDKMessage);
    const enriched = reduceSdkMessage(started, {
      type: "assistant", uuid: "two", session_id: "session", parent_tool_use_id: null,
      message: { id: "m", role: "assistant", content: [{ type: "tool_use", id: "tool-use-1", name: "Bash", input: { command: "pwd" } }] },
    } as unknown as SDKMessage);

    expect(enriched).toHaveLength(1);
    expect(enriched[0]).toMatchObject({ role: "tool", text: "Bash", status: "running", toolUseId: "tool-use-1", toolInput: { command: "pwd" } });
    expect(enriched[0]?.id).toBe(started[0]?.id);
  });

  it("creates a tool row directly from a completed assistant tool_use block when no stream event preceded it", () => {
    const items = reduceSdkMessage([], {
      type: "assistant", uuid: "one", session_id: "session", parent_tool_use_id: "parent-tool",
      message: { id: "m", role: "assistant", content: [{ type: "tool_use", id: "tool-use-2", name: "Write", input: { file_path: "a.ts" } }] },
    } as unknown as SDKMessage);

    expect(items).toEqual([{ id: "tool-tool-use-2", role: "tool", text: "Write", status: "running", toolUseId: "tool-use-2", toolInput: { file_path: "a.ts" }, detail: "subagent" }]);
  });

  it("settles a tool row and captures its sanitized output once the matching tool_result arrives", () => {
    const started = reduceSdkMessage([], {
      type: "stream_event", uuid: "one", session_id: "session", parent_tool_use_id: null,
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool-use-3", name: "Bash", input: {} } },
    } as unknown as SDKMessage);
    const esc = String.fromCharCode(27);
    const settled = reduceSdkMessage(started, {
      type: "user", uuid: "two", session_id: "session", parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-use-3", content: `ok${esc}[31m!` }] },
    } as unknown as SDKMessage);

    expect(settled[0]).toMatchObject({ status: "completed", toolOutput: "ok!" });
  });

  it("marks a tool row failed when its tool_result carries is_error", () => {
    const started = reduceSdkMessage([], {
      type: "stream_event", uuid: "one", session_id: "session", parent_tool_use_id: null,
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool-use-4", name: "Bash", input: {} } },
    } as unknown as SDKMessage);
    const settled = reduceSdkMessage(started, {
      type: "user", uuid: "two", session_id: "session", parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-use-4", content: "boom", is_error: true }] },
    } as unknown as SDKMessage);

    expect(settled[0]).toMatchObject({ status: "failed", toolOutput: "boom" });
  });

  it("leaves the transcript untouched when a tool_result has no matching tool row", () => {
    const items = reduceSdkMessage([], {
      type: "user", uuid: "one", session_id: "session", parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "unknown-tool", content: "ok" }] },
    } as unknown as SDKMessage);
    expect(items).toEqual([]);
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

  it("assigns distinct transcript ids to items created in the same tick", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      expect(createTranscriptItemId("user")).not.toBe(createTranscriptItemId("user"));
    } finally {
      now.mockRestore();
    }
  });
});

describe("permission decision audit trail", () => {
  it("describes a decision without a note", () => {
    expect(describePermissionDecision("Bash", "Allow once", undefined)).toBe("Permission: Bash → Allow once");
  });

  it("appends the attached note when present", () => {
    expect(describePermissionDecision("Write", "Denied", "not on this branch")).toBe("Permission: Write → Denied — “not on this branch”");
  });

  it("treats an empty note the same as no note", () => {
    expect(describePermissionDecision("Bash", "Always allow", "")).toBe("Permission: Bash → Always allow");
  });
});

describe("shared single-line editor keymap", () => {
  it("inserts sanitized, newline-collapsed text", () => {
    const esc = String.fromCharCode(27);
    const operation = resolveLineEditorOperation(`a${esc}[31mb\nc`, noKey());
    expect(operation).toEqual({ type: "insert", text: "ab c" });
  });

  it("maps navigation and deletion keys to editor operations", () => {
    expect(resolveLineEditorOperation("", noKey({ leftArrow: true }))).toEqual({ type: "left" });
    expect(resolveLineEditorOperation("", noKey({ rightArrow: true }))).toEqual({ type: "right" });
    expect(resolveLineEditorOperation("", noKey({ home: true }))).toEqual({ type: "home" });
    expect(resolveLineEditorOperation("", noKey({ end: true }))).toEqual({ type: "end" });
    expect(resolveLineEditorOperation("u", noKey({ ctrl: true }))).toEqual({ type: "delete-to-start" });
    expect(resolveLineEditorOperation("k", noKey({ ctrl: true }))).toEqual({ type: "delete-to-end" });
    expect(resolveLineEditorOperation("w", noKey({ ctrl: true }))).toEqual({ type: "delete-word" });
    expect(resolveLineEditorOperation("", noKey({ backspace: true }))).toEqual({ type: "backspace" });
    expect(resolveLineEditorOperation("", noKey({ delete: true }))).toEqual({ type: "delete" });
  });

  it("ignores unmapped control/meta chords instead of inserting them", () => {
    expect(resolveLineEditorOperation("x", noKey({ ctrl: true }))).toBeUndefined();
    expect(resolveLineEditorOperation("x", noKey({ meta: true }))).toBeUndefined();
  });
});
