import { describe, expect, it } from "vitest";
import { editInput, lineRange, nextCodePoint, previousCodePoint, splitAtCursor, type EditorState } from "../src/ui/input-editor.js";

describe("composer input editor", () => {
  it("inserts and deletes at the cursor instead of only at the end", () => {
    const initial: EditorState = { value: "AlfaCode", cursor: 4 };
    const inserted = editInput(initial, { type: "insert", text: "-" });
    expect(inserted).toEqual({ value: "Alfa-Code", cursor: 5 });
    expect(editInput(inserted, { type: "backspace" })).toEqual(initial);
    expect(editInput(initial, { type: "delete" })).toEqual({ value: "Alfaode", cursor: 4 });
  });

  it("handles emoji as a single cursor unit", () => {
    const moved = editInput({ value: "A🤖B", cursor: 3 }, { type: "left" });
    expect(moved.cursor).toBe(1);
    expect(editInput(moved, { type: "delete" })).toEqual({ value: "AB", cursor: 1 });
  });

  it("supports shell-style line and word deletion", () => {
    const state: EditorState = { value: "inspect src now", cursor: 11 };
    expect(editInput(state, { type: "delete-word" })).toEqual({ value: "inspect now", cursor: 7 });
    expect(editInput(state, { type: "delete-to-start" })).toEqual({ value: " now", cursor: 0 });
    expect(editInput(state, { type: "delete-to-end" })).toEqual({ value: "inspect src", cursor: 11 });
  });

  it("splits the visible cursor without losing surrogate pairs", () => {
    expect(splitAtCursor({ value: "A◆B", cursor: 1 })).toEqual({ before: "A", cursor: "◆", after: "B" });
  });

  it("exposes surrogate-pair-safe code point stepping for callers extending cursor movement (e.g. vim motions)", () => {
    expect(previousCodePoint("A🤖B", 3)).toBe(1);
    expect(nextCodePoint("A🤖B", 1)).toBe(3);
  });

  it("finds the line containing a given offset, excluding the line break itself", () => {
    const value = "one\ntwo\nthree";
    expect(lineRange(value, 0)).toEqual({ start: 0, end: 3 });
    expect(lineRange(value, 5)).toEqual({ start: 4, end: 7 }); // inside "two"
    expect(lineRange(value, 12)).toEqual({ start: 8, end: 13 }); // last line, no trailing newline
    expect(lineRange("", 0)).toEqual({ start: 0, end: 0 });
  });
});
