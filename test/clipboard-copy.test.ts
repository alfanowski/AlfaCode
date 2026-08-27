import { describe, expect, it, vi } from "vitest";
import {
  createClipboardWriter,
  createSystemClipboardWriter,
  encodeOsc52Copy,
  isLikelySshSession,
  shouldUsePbcopy,
  wrapForTmuxPassthrough,
  type ClipboardWriteDeps,
  type SystemClipboardWriteDeps,
} from "../src/ui/clipboard-copy.js";

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

describe("SSH session detection", () => {
  it("is true when SSH_TTY or SSH_CONNECTION is set", () => {
    expect(isLikelySshSession({ SSH_TTY: "/dev/ttys000" })).toBe(true);
    expect(isLikelySshSession({ SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" })).toBe(true);
  });

  it("is false on a plain local environment", () => {
    expect(isLikelySshSession({})).toBe(false);
  });
});

describe("shouldUsePbcopy", () => {
  it("is true only for local (non-SSH) macOS", () => {
    expect(shouldUsePbcopy("darwin", {})).toBe(true);
  });

  it("is false on non-macOS platforms regardless of SSH state", () => {
    expect(shouldUsePbcopy("linux", {})).toBe(false);
    expect(shouldUsePbcopy("win32", {})).toBe(false);
  });

  it("is false on macOS over SSH — pbcopy there would hit the remote host's clipboard, not the user's", () => {
    expect(shouldUsePbcopy("darwin", { SSH_TTY: "/dev/ttys000" })).toBe(false);
    expect(shouldUsePbcopy("darwin", { SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" })).toBe(false);
  });
});

function systemDeps(overrides: Partial<SystemClipboardWriteDeps>): SystemClipboardWriteDeps {
  return {
    platform: "darwin",
    environment: {},
    runPbcopy: vi.fn(async () => true),
    writeOsc52: vi.fn(() => ({ sequence: "osc52-sequence", truncated: false })),
    ...overrides,
  };
}

describe("system clipboard writer (pbcopy primary, OSC 52 fallback)", () => {
  it("uses pbcopy on local macOS and never touches the OSC 52 fallback", async () => {
    const runPbcopy = vi.fn(async () => true);
    const writeOsc52 = vi.fn(() => ({ sequence: "osc52-sequence", truncated: false }));
    const writer = createSystemClipboardWriter(systemDeps({ runPbcopy, writeOsc52 }));

    const result = await writer("hello");

    expect(runPbcopy).toHaveBeenCalledWith("hello");
    expect(writeOsc52).not.toHaveBeenCalled();
    expect(result).toEqual({ method: "pbcopy", truncated: false });
  });

  it("falls back to OSC 52 when pbcopy isn't the applicable path (non-macOS)", async () => {
    const runPbcopy = vi.fn(async () => true);
    const writeOsc52 = vi.fn(() => ({ sequence: "osc52-sequence", truncated: false }));
    const writer = createSystemClipboardWriter(systemDeps({ platform: "linux", runPbcopy, writeOsc52 }));

    const result = await writer("hello");

    expect(runPbcopy).not.toHaveBeenCalled();
    expect(writeOsc52).toHaveBeenCalledWith("hello");
    expect(result).toEqual({ method: "osc52", truncated: false });
  });

  it("falls back to OSC 52 when running over SSH, even on macOS", async () => {
    const runPbcopy = vi.fn(async () => true);
    const writer = createSystemClipboardWriter(systemDeps({ environment: { SSH_TTY: "/dev/ttys000" }, runPbcopy }));

    const result = await writer("hello");

    expect(runPbcopy).not.toHaveBeenCalled();
    expect(result.method).toBe("osc52");
  });

  it("falls back to OSC 52 when pbcopy itself fails", async () => {
    const runPbcopy = vi.fn(async () => false);
    const writeOsc52 = vi.fn(() => ({ sequence: "osc52-sequence", truncated: false }));
    const writer = createSystemClipboardWriter(systemDeps({ runPbcopy, writeOsc52 }));

    const result = await writer("hello");

    expect(writeOsc52).toHaveBeenCalledWith("hello");
    expect(result).toEqual({ method: "osc52", truncated: false });
  });

  it("surfaces OSC 52's own truncation flag on fallback", async () => {
    const writeOsc52 = vi.fn(() => ({ sequence: "osc52-sequence", truncated: true }));
    const writer = createSystemClipboardWriter(systemDeps({ platform: "linux", writeOsc52 }));

    const result = await writer("hello");

    expect(result).toEqual({ method: "osc52", truncated: true });
  });
});
