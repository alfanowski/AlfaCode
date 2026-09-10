import { describe, expect, it } from "vitest";
import { createTerminalUi, requireInteractive, sanitizeTerminalText } from "../src/terminal-ui.js";

describe("outer terminal UI", () => {
  it("honors NO_COLOR without relying on terminal decorations", () => {
    const terminal = createTerminalUi({ interactive: true, environment: { NO_COLOR: "1", TERM: "xterm-256color" } });
    expect(terminal.interactive).toBe(true);
    expect(terminal.color).toBe(false);
  });

  it("rejects secret setup prompts in a non-interactive terminal", () => {
    expect(() => requireInteractive(false)).toThrow("interactive terminal");
  });
});

describe("sanitizeTerminalText", () => {
  it("strips ANSI escape sequences and control characters from untrusted third-party text", () => {
    const escape = String.fromCharCode(0x1b);
    const bell = String.fromCharCode(0x07);
    const input = `${escape}[31mDanger${escape}[0m${bell} zone`;
    expect(sanitizeTerminalText(input)).toBe("Danger zone");
  });
});
