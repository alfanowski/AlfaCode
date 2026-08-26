import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  commandSuggestions,
  contextFullThreshold,
  contextFullWarning,
  createTranscriptItemId,
  describePermissionDecision,
  formatCostUsd,
  historySearchMatches,
  reduceSdkMessage,
  resolveInitialVimMode,
  resolveLineEditorOperation,
  tailItemsByRows,
  truncateCheckpointsAt,
  truncateOneLine,
  truncateTranscriptAt,
  turnCostFromResult,
} from "../src/chat-tui.js";

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

  it("registers /vim in the default command list", () => {
    expect(commandSuggestions("/vim").map((command) => command.name)).toEqual(["/vim"]);
  });

  it("registers the discovery and export commands alongside the built-ins", () => {
    expect(commandSuggestions("/the").map((command) => command.name)).toEqual(["/theme"]);
    expect(commandSuggestions("/mcp").map((command) => command.name)).toEqual(["/mcp"]);
    expect(commandSuggestions("/exp").map((command) => command.name)).toEqual(["/export"]);
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

describe("context-full warning", () => {
  it("uses the engine's own auto-compact threshold when it is a sane percentage", () => {
    expect(contextFullThreshold({ autoCompactThreshold: 70 })).toBe(70);
  });

  it("falls back to the default threshold for an absent or out-of-range value", () => {
    expect(contextFullThreshold({})).toBe(80);
    expect(contextFullThreshold({ autoCompactThreshold: 0 })).toBe(80);
    expect(contextFullThreshold({ autoCompactThreshold: 150_000 })).toBe(80);
  });

  const baseContext = { totalTokens: 1, maxTokens: 1, model: "route/model" } as const;

  it("stays quiet below the threshold", () => {
    expect(contextFullWarning({ ...baseContext, percentage: 79 }, false)).toBeUndefined();
  });

  it("warns once the threshold is crossed, mentioning /compact", () => {
    const warning = contextFullWarning({ ...baseContext, percentage: 85 }, false);
    expect(warning).toContain("85% full");
    expect(warning).toContain("/compact");
  });

  it("mentions auto-compaction only when the engine reports it as enabled", () => {
    expect(contextFullWarning({ ...baseContext, percentage: 85, isAutoCompactEnabled: true }, false)).toContain("before the engine compacts it for you");
    expect(contextFullWarning({ ...baseContext, percentage: 85, isAutoCompactEnabled: false }, false)).not.toContain("before the engine compacts it for you");
  });

  it("does not repeat the warning once already shown", () => {
    expect(contextFullWarning({ ...baseContext, percentage: 90 }, true)).toBeUndefined();
  });
});

describe("per-turn cost", () => {
  function resultMessage(totalCostUsd: number): SDKResultMessage {
    return {
      type: "result", subtype: "success", duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 1,
      result: "ok", stop_reason: null, total_cost_usd: totalCostUsd, usage: {} as never, modelUsage: {},
      permission_denials: [], uuid: "result-uuid", session_id: "session",
    } as unknown as SDKResultMessage;
  }

  it("derives this turn's cost as the delta from the previous cumulative total", () => {
    const result = turnCostFromResult(resultMessage(0.05), 0.02);
    expect(result?.cumulativeCostUsd).toBe(0.05);
    expect(result?.turnCostUsd).toBeCloseTo(0.03, 10);
  });

  it("clamps a negative delta (a session reset) to zero instead of going negative", () => {
    expect(turnCostFromResult(resultMessage(0.01), 0.05)).toEqual({ turnCostUsd: 0, cumulativeCostUsd: 0.01 });
  });

  it("returns undefined when the engine did not report a cost", () => {
    expect(turnCostFromResult({ total_cost_usd: undefined } as unknown as SDKResultMessage, 0)).toBeUndefined();
  });

  it("formats small costs with extra precision instead of always reading $0.00", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(0.0034)).toBe("$0.0034");
    expect(formatCostUsd(1.2)).toBe("$1.20");
  });
});

describe("composer history search", () => {
  const history = ["fix the login bug", "refactor gateway routing", "add login tests"];

  it("returns the full history for an empty query", () => {
    expect(historySearchMatches(history, "")).toEqual(history);
  });

  it("filters case-insensitively", () => {
    expect(historySearchMatches(history, "LOGIN")).toEqual(["fix the login bug", "add login tests"]);
  });

  it("returns no matches when nothing matches", () => {
    expect(historySearchMatches(history, "nonexistent")).toEqual([]);
  });
});

describe("rewind truncation", () => {
  const items = [
    { id: "user-1", role: "user", text: "first" },
    { id: "assistant-1", role: "assistant", text: "reply" },
    { id: "user-2", role: "user", text: "second" },
    { id: "assistant-2", role: "assistant", text: "reply two" },
  ] as const;

  it("drops the checkpoint item and everything after it", () => {
    expect(truncateTranscriptAt(items, "user-2").map((item) => item.id)).toEqual(["user-1", "assistant-1"]);
  });

  it("leaves the transcript unchanged when the checkpoint id is unknown", () => {
    expect(truncateTranscriptAt(items, "missing")).toEqual([...items]);
  });

  const checkpoints = [
    { uuid: "a", text: "first", transcriptItemId: "user-1", at: 1 },
    { uuid: "b", text: "second", transcriptItemId: "user-2", at: 2 },
  ];

  it("drops the checkpoint and every later checkpoint", () => {
    expect(truncateCheckpointsAt(checkpoints, "b")).toEqual([checkpoints[0]]);
  });

  it("truncates one-line previews without breaking words mid-way past the limit", () => {
    expect(truncateOneLine("a".repeat(80), 10)).toBe(`${"a".repeat(9)}…`);
    expect(truncateOneLine("short", 10)).toBe("short");
    expect(truncateOneLine("line one\nline two", 100)).toBe("line one line two");
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
