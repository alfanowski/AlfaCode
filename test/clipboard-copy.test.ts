import { describe, expect, it, vi } from "vitest";
import { createClipboardWriter, encodeOsc52Copy, wrapForTmuxPassthrough, type ClipboardWriteDeps } from "../src/ui/clipboard-copy.js";

function deps(overrides: Partial<ClipboardWriteDeps>): ClipboardWriteDeps {
  return { write: vi.fn(), insideTmux: () => false, ...overrides };
}

describe("OSC 52 clipboard encoding", () => {
  it("builds the exact escape sequence for a known input", () => {
    const copy = encodeOsc52Copy("hi");
    expect(copy).toEqual({ sequence: "\x1b]52;c;aGk=\x07", truncated: false });
  });

  it("base64-encodes UTF-8 bytes, not UTF-16 code units", () => {
    const copy = encodeOsc52Copy("café ☕");
    expect(copy.sequence).toBe(`\x1b]52;c;${Buffer.from("café ☕", "utf8").toString("base64")}\x07`);
    expect(copy.truncated).toBe(false);
  });

  it("returns an empty-payload sequence for empty input", () => {
    expect(encodeOsc52Copy("")).toEqual({ sequence: "\x1b]52;c;\x07", truncated: false });
  });

  it("truncates text exceeding the byte budget and reports it", () => {
    const copy = encodeOsc52Copy("abcdefghij", 5);
    expect(copy.truncated).toBe(true);
    expect(Buffer.from(copy.sequence.slice("\x1b]52;c;".length, -1), "base64").toString("utf8")).toBe("abcde");
  });

  it("never splits a multi-byte codepoint when truncating", () => {
    // Each "é" is 2 UTF-8 bytes; a 3-byte budget must drop to a whole-character boundary.
    const copy = encodeOsc52Copy("éé", 3);
    const decoded = Buffer.from(copy.sequence.slice("\x1b]52;c;".length, -1), "base64").toString("utf8");
    expect(decoded).toBe("é");
    expect(copy.truncated).toBe(true);
  });

  it("does not truncate text that exactly fits the budget", () => {
    const copy = encodeOsc52Copy("abcde", 5);
    expect(copy.truncated).toBe(false);
  });
});

describe("tmux passthrough wrapping", () => {
  it("wraps the sequence in tmux's DCS envelope, doubling embedded ESC bytes", () => {
    const sequence = "\x1b]52;c;aGk=\x07";
    expect(wrapForTmuxPassthrough(sequence)).toBe("\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\");
  });
});

describe("clipboard writer", () => {
  it("writes the raw OSC 52 sequence directly outside tmux", () => {
    const write = vi.fn();
    const writer = createClipboardWriter(deps({ write, insideTmux: () => false }));

    const result = writer("hi");

    expect(write).toHaveBeenCalledWith("\x1b]52;c;aGk=\x07");
    expect(result).toEqual({ sequence: "\x1b]52;c;aGk=\x07", truncated: false });
  });

  it("wraps the sequence for tmux passthrough when inside tmux", () => {
    const write = vi.fn();
    const writer = createClipboardWriter(deps({ write, insideTmux: () => true }));

    writer("hi");

    expect(write).toHaveBeenCalledWith(wrapForTmuxPassthrough("\x1b]52;c;aGk=\x07"));
  });
});
