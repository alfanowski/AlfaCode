import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { reduceSdkMessage, type TranscriptItem } from "../src/chat-tui.js";
import {
  appendTranscriptLog,
  emptyTranscriptLog,
  formatTranscriptLine,
  isScreenReaderMode,
  numberedLabel,
  parseNumberedMultiSelection,
  parseNumberedSelection,
  parseYesNoDecision,
  ringBell,
} from "../src/ui/screen-reader-mode.js";

describe("screen-reader mode detection", () => {
  it("is off by default", () => {
    expect(isScreenReaderMode({})).toBe(false);
  });

  it("honors AlfaCode's own opt-in", () => {
    expect(isScreenReaderMode({ ALFACODE_SCREEN_READER: "1" })).toBe(true);
    expect(isScreenReaderMode({ ALFACODE_SCREEN_READER: "0" })).toBe(false);
  });

  it("also honors Ink's own screen-reader convention, for interop with an existing AT setup", () => {
    expect(isScreenReaderMode({ INK_SCREEN_READER: "true" })).toBe(true);
    expect(isScreenReaderMode({ INK_SCREEN_READER: "false" })).toBe(false);
  });
});

describe("terminal bell", () => {
  it("writes a single BEL character", () => {
    const written: string[] = [];
    ringBell((chunk) => written.push(chunk));
    expect(written).toEqual(["\x07"]);
  });
});

describe("numbered-picker selection logic", () => {
  it("formats a 1-based numbered label", () => {
    expect(numberedLabel(0, "gpt-5")).toBe("1) gpt-5");
    expect(numberedLabel(9, "claude")).toBe("10) claude");
  });

  it("parses a typed number into a 0-based index within range", () => {
    expect(parseNumberedSelection("1", 3)).toBe(0);
    expect(parseNumberedSelection("3", 3)).toBe(2);
    expect(parseNumberedSelection(" 2 ", 3)).toBe(1);
  });

  it("rejects out-of-range, non-numeric, or empty input so callers can fall back to their existing cursor", () => {
    expect(parseNumberedSelection("0", 3)).toBeUndefined();
    expect(parseNumberedSelection("4", 3)).toBeUndefined();
    expect(parseNumberedSelection("gpt-5", 3)).toBeUndefined();
    expect(parseNumberedSelection("", 3)).toBeUndefined();
    expect(parseNumberedSelection("-1", 3)).toBeUndefined();
    expect(parseNumberedSelection("1.5", 3)).toBeUndefined();
  });

  it("parses multiple typed numbers for a multi-select picker", () => {
    expect(parseNumberedMultiSelection("1,3", 4)).toEqual([0, 2]);
    expect(parseNumberedMultiSelection("1 3 3", 4)).toEqual([0, 2]);
    expect(parseNumberedMultiSelection("2", 4)).toEqual([1]);
  });

  it("rejects a multi-select list if any token is invalid", () => {
    expect(parseNumberedMultiSelection("1,9", 4)).toBeUndefined();
    expect(parseNumberedMultiSelection("1,x", 4)).toBeUndefined();
    expect(parseNumberedMultiSelection("", 4)).toBeUndefined();
  });
});

describe("y/n prompt handling", () => {
  it("parses plain typed yes/no", () => {
    expect(parseYesNoDecision("y", false)).toBe("allow");
    expect(parseYesNoDecision("yes", false)).toBe("allow");
    expect(parseYesNoDecision("N", false)).toBe("deny");
    expect(parseYesNoDecision("no", false)).toBe("deny");
  });

  it("only accepts 'always allow' when the caller says it's on offer", () => {
    expect(parseYesNoDecision("a", true)).toBe("allow-always");
    expect(parseYesNoDecision("always", true)).toBe("allow-always");
    expect(parseYesNoDecision("a", false)).toBeUndefined();
  });

  it("rejects anything else, so the caller can fall back to arrow+enter", () => {
    expect(parseYesNoDecision("maybe", false)).toBeUndefined();
    expect(parseYesNoDecision("", false)).toBeUndefined();
  });
});

describe("append-only transcript log (plain-text output format)", () => {
  it("logs a user line immediately", () => {
    const items: readonly TranscriptItem[] = [{ id: "u1", role: "user", text: "hello" }];
    const log = appendTranscriptLog(emptyTranscriptLog, items, false);
    expect(log.lines).toEqual(["You: hello"]);
  });

  it("holds back a still-streaming assistant tail until the turn ends", () => {
    const streaming: readonly TranscriptItem[] = [{ id: "a1", role: "assistant", text: "partial" }];
    const midTurn = appendTranscriptLog(emptyTranscriptLog, streaming, false);
    expect(midTurn.lines).toEqual([]);

    const grown: readonly TranscriptItem[] = [{ id: "a1", role: "assistant", text: "partial and more" }];
    const stillMidTurn = appendTranscriptLog(midTurn, grown, false);
    expect(stillMidTurn.lines).toEqual([]);

    const flushed = appendTranscriptLog(stillMidTurn, grown, true);
    expect(flushed.lines).toEqual(["Assistant: partial and more"]);
  });

  it("flushes an assistant item as soon as something is appended after it, without waiting for flushTail", () => {
    const items: readonly TranscriptItem[] = [
      { id: "a1", role: "assistant", text: "before the tool call" },
      { id: "t1", role: "tool", text: "Read", status: "running" },
    ];
    const log = appendTranscriptLog(emptyTranscriptLog, items, false);
    expect(log.lines).toEqual(["Assistant: before the tool call", "Tool (tool): Read — running"]);
  });

  it("logs a tool call's start and its outcome as two separate lines, never rewriting the first", () => {
    const started: readonly TranscriptItem[] = [{ id: "t1", role: "tool", text: "Bash", detail: "tool", status: "running" }];
    const afterStart = appendTranscriptLog(emptyTranscriptLog, started, false);
    expect(afterStart.lines).toEqual(["Tool (tool): Bash — running"]);

    const completed: readonly TranscriptItem[] = [{ id: "t1", role: "tool", text: "Bash", detail: "tool", status: "completed" }];
    const afterComplete = appendTranscriptLog(afterStart, completed, false);
    expect(afterComplete.lines).toEqual(["Tool (tool): Bash — running", "Tool (tool): Bash — completed"]);

    // Calling again with the same items must not duplicate the outcome line.
    const idempotent = appendTranscriptLog(afterComplete, completed, false);
    expect(idempotent.lines).toBe(afterComplete.lines);
  });

  it("never re-adds a line for an item already logged", () => {
    const items: readonly TranscriptItem[] = [{ id: "s1", role: "system", text: "notice" }];
    const first = appendTranscriptLog(emptyTranscriptLog, items, false);
    const second = appendTranscriptLog(first, items, false);
    expect(second).toBe(first);
  });

  it("labels each transcript role with a distinct textual prefix", () => {
    expect(formatTranscriptLine({ id: "1", role: "user", text: "hi" })).toBe("You: hi");
    expect(formatTranscriptLine({ id: "2", role: "assistant", text: "hi there" })).toBe("Assistant: hi there");
    expect(formatTranscriptLine({ id: "3", role: "tool", text: "Read", detail: "subagent", status: "completed" })).toBe("Tool (subagent): Read — completed");
    expect(formatTranscriptLine({ id: "4", role: "system", text: "warning" })).toBe("System: warning");
  });

  it("stays append-only end-to-end when driven by real reduceSdkMessage output (streamed text, a tool call, and a result)", () => {
    let items: readonly TranscriptItem[] = [];
    let log = emptyTranscriptLog;
    const drive = (message: SDKMessage, busy: boolean): void => {
      items = reduceSdkMessage(items, message);
      log = appendTranscriptLog(log, items, !busy);
    };

    drive({ type: "stream_event", uuid: "1", session_id: "s", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } } as unknown as SDKMessage, true);
    drive({ type: "stream_event", uuid: "2", session_id: "s", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } } } as unknown as SDKMessage, true);
    expect(log.lines).toEqual([]); // still streaming, nothing written yet

    drive({ type: "stream_event", uuid: "3", session_id: "s", parent_tool_use_id: null, event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool", name: "Read", input: {} } } } as unknown as SDKMessage, true);
    expect(log.lines).toEqual(["Assistant: Hello world", "Tool (tool): Read — running"]);

    drive({ type: "result", subtype: "success", uuid: "4", session_id: "s", is_error: false, result: "ok" } as unknown as SDKMessage, false);
    expect(log.lines).toEqual(["Assistant: Hello world", "Tool (tool): Read — running", "Tool (tool): Read — completed"]);

    // Nothing is ever rewritten: once a line is in the log, later calls only ever append.
    expect(log.lines.slice(0, 2)).toEqual(["Assistant: Hello world", "Tool (tool): Read — running"]);
  });
});
