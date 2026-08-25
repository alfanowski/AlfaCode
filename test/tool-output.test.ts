import { describe, expect, it } from "vitest";
import { stringifyToolPayload, truncateForDisplay } from "../src/ui/tool-output.js";

const ESC = String.fromCharCode(27);

describe("tool output formatting", () => {
  it("pretty-prints structured input as sanitized JSON", () => {
    expect(stringifyToolPayload({ command: "pwd", timeout: 10 })).toBe('{\n  "command": "pwd",\n  "timeout": 10\n}');
  });

  it("passes strings through sanitized instead of re-quoting them", () => {
    expect(stringifyToolPayload("plain output")).toBe("plain output");
  });

  it("strips ANSI control sequences from a raw string payload", () => {
    expect(stringifyToolPayload(`ok${ESC}[31mred${ESC}[0m`)).toBe("okred");
  });

  it("never lets a raw control byte through a serialized object payload", () => {
    // JSON.stringify itself escapes control characters inside string values (e.g. ESC becomes the
    // literal, inert text ""), so the sanitize pass on top guards the JSON structure itself
    // (keys/braces) rather than needing to re-strip already-neutralized string content.
    const serialized = stringifyToolPayload({ note: `ok${ESC}[31mred${ESC}[0m` });
    expect(serialized).not.toContain(ESC);
    expect(serialized).toContain("ok");
    expect(serialized).toContain("red");
  });

  it("returns an empty string for undefined input rather than the literal 'undefined'", () => {
    expect(stringifyToolPayload(undefined)).toBe("");
  });

  it("falls back to String() when a value cannot be JSON-serialized", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(stringifyToolPayload(cyclic)).toBe("[object Object]");
  });

  it("truncates long payloads and marks them as truncated", () => {
    const long = "x".repeat(2_000);
    const truncated = truncateForDisplay(long, 100);
    expect(truncated.startsWith("x".repeat(100))).toBe(true);
    expect(truncated).toContain("truncated");
    expect(truncated.length).toBeLessThan(long.length);
  });

  it("leaves short payloads untouched", () => {
    expect(truncateForDisplay("short", 100)).toBe("short");
  });
});
