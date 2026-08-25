import { describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { commandSuggestions, createTranscriptItemId, maxScrollOffsetRows, reduceSdkMessage, tailItemsByRows, windowItemsByRows } from "../src/chat-tui.js";
import type { TranscriptItem } from "../src/chat-tui.js";

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

describe("scroll-offset windowing (fullscreen mode)", () => {
  // Six short single-line messages, oldest ("a") to newest ("f"). At width 80 every item's
  // estimated cost is 2 rows, so a 4-row budget shows exactly two items — matches
  // tailItemsByRows's own estimation formula (1 line-row + 1 spacer row per item).
  const items: readonly TranscriptItem[] = ["a", "b", "c", "d", "e", "f"].map((id): TranscriptItem => ({ id, role: "assistant", text: `msg-${id}` }));
  const rows = 4;
  const width = 80;

  it("reproduces tailItemsByRows exactly at offset 0 — non-fullscreen call sites are unaffected", () => {
    const windowed = windowItemsByRows(items, rows, width, 0);
    expect(windowed.items).toEqual(tailItemsByRows(items, rows, width));
    expect(windowed.items.map((item) => item.id)).toEqual(["e", "f"]);
    expect(windowed).toMatchObject({ atTail: true, hasMoreAbove: true, newerItemCount: 0 });

    // The original three-item fixture from the base tailItemsByRows test, replayed through the
    // offset-aware function, must still match its own dedicated assertion above.
    const base = [
      { id: "one", role: "assistant", text: "first" },
      { id: "two", role: "assistant", text: "second" },
      { id: "three", role: "assistant", text: "third" },
    ] as const;
    expect(windowItemsByRows(base, 4, 80, 0).items.map((item) => item.id)).toEqual(tailItemsByRows(base, 4, 80).map((item) => item.id));
  });

  it("PageUp moves the window back by roughly a screen's worth of rows and flags hidden newer messages", () => {
    const pageUp = windowItemsByRows(items, rows, width, rows);
    expect(pageUp.items.map((item) => item.id)).toEqual(["c", "d"]);
    expect(pageUp.atTail).toBe(false);
    expect(pageUp.hasMoreAbove).toBe(true);
    expect(pageUp.newerItemCount).toBe(2); // "e" and "f" scrolled past below — drives the "N new messages" indicator
  });

  it("PageDown from a scrolled position returns exactly to the tail", () => {
    const scrolledOffset = rows;
    const pageDownOffset = Math.max(0, scrolledOffset - rows);
    const pageDown = windowItemsByRows(items, rows, width, pageDownOffset);
    expect(pageDown).toMatchObject({ atTail: true, newerItemCount: 0 });
    expect(pageDown.items.map((item) => item.id)).toEqual(["e", "f"]);
  });

  it("jump-to-start (maxScrollOffsetRows) reaches the oldest message and reports nothing further above", () => {
    const max = maxScrollOffsetRows(items, width);
    expect(max).toBeGreaterThan(0);
    const start = windowItemsByRows(items, rows, width, max);
    expect(start.items.map((item) => item.id)).toEqual(["a"]);
    expect(start.hasMoreAbove).toBe(false);
    expect(start.atTail).toBe(false);
    expect(start.newerItemCount).toBe(5);

    // Any offset at or beyond the max saturates at the same window — callers can clamp with
    // Number.MAX_SAFE_INTEGER-style values without special-casing "the top".
    expect(windowItemsByRows(items, rows, width, max + 1_000).items.map((item) => item.id)).toEqual(["a"]);
  });

  it("jump-to-end (offset 0) always returns to the tail regardless of prior scroll position", () => {
    const end = windowItemsByRows(items, rows, width, 0);
    expect(end).toMatchObject({ atTail: true, hasMoreAbove: true, newerItemCount: 0 });
    expect(end.items.map((item) => item.id)).toEqual(["e", "f"]);
  });

  it("maxScrollOffsetRows is 0 when there is nothing to scroll", () => {
    expect(maxScrollOffsetRows([], width)).toBe(0);
    expect(maxScrollOffsetRows([items[0]!], width)).toBe(0);
  });

  it("a lone remaining message never falsely reports atTail: false with hidden messages below", () => {
    // Regression guard: requesting a scroll on a transcript with nothing to scroll must not report
    // a phantom "N new messages below" — atTail must reflect what actually moved, not the raw request.
    const windowed = windowItemsByRows([items[0]!], rows, width, 500);
    expect(windowed).toMatchObject({ atTail: true, hasMoreAbove: false, newerItemCount: 0 });
  });
});
