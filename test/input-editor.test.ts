import { describe, expect, it } from "vitest";
import { editInput, splitAtCursor, type EditorState } from "../src/ui/input-editor.js";

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
});
