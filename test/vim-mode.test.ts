import { describe, expect, it } from "vitest";
import type { EditorState } from "../src/ui/input-editor.js";
import { createVimState, resetVimStateForNewBuffer, stepVim, type VimKeyLike, type VimState } from "../src/ui/vim-mode.js";

function key(overrides: Partial<VimKeyLike> = {}): VimKeyLike {
  return {
    ctrl: false, meta: false, escape: false, backspace: false, delete: false,
    leftArrow: false, rightArrow: false, upArrow: false, downArrow: false, home: false, end: false,
    ...overrides,
  };
}

interface Frame { readonly editor: EditorState; readonly vim: VimState; }

function press(frame: Frame, text: string, overrides: Partial<VimKeyLike> = {}): Frame {
  const step = stepVim(frame.editor, frame.vim, text, key(overrides));
  return { editor: step.editor, vim: step.vim };
}

function type(frame: Frame, text: string): Frame {
  return [...text].reduce((current, character) => press(current, character), frame);
}

function start(value = "", cursor = 0): Frame {
  return { editor: { value, cursor }, vim: createVimState() };
}

describe("vim-mode", () => {
  it("starts in NORMAL mode and enters INSERT via i, typing at the cursor", () => {
    const frame = start("Aloha", 0);
    expect(frame.vim.mode).toBe("normal");
    const afterI = press(frame, "i");
    expect(afterI.vim.mode).toBe("insert");
    const typed = type(afterI, "Hi ");
    expect(typed.editor.value).toBe("Hi Aloha");
    expect(typed.editor.cursor).toBe(3);
  });

  it("moves the cursor back one column on Escape, matching vim's insert-exit quirk", () => {
    const frame = type(press(start("", 0), "i"), "abc");
    expect(frame.editor).toEqual({ value: "abc", cursor: 3 });
    const normal = press(frame, "", { escape: true });
    expect(normal.vim.mode).toBe("normal");
    expect(normal.editor.cursor).toBe(2);
  });

  it("clamps the NORMAL-mode cursor so it never rests past the last character of a line", () => {
    // cursor 2 is one-past "hi" — an insert-mode-only position. Any handled NORMAL-mode step,
    // even one that leaves the buffer untouched, must clamp it back onto the last character.
    const swallowed = press(start("hi", 2), "z");
    expect(swallowed.editor).toEqual({ value: "hi", cursor: 1 });
  });

  describe("hjkl motions", () => {
    it("h/l stay within the current line", () => {
      const frame = start("ab\ncd", 0);
      const atA = frame;
      const clampedLeft = press(atA, "h");
      expect(clampedLeft.editor.cursor).toBe(0);
      const right = press(press(atA, "l"), "l");
      expect(right.editor.cursor).toBe(1); // clamped onto 'b', the last char of line 1
    });

    it("j/k move vertically, preserving column and clamping to shorter lines", () => {
      const frame = start("abcdef\nxy\nqwerty", 3); // cursor on 'd'
      const down = press(frame, "j");
      expect(down.editor.cursor).toBe(8); // "xy" line: start 7, clamped to end 9->'y' at col index 1 => 8
      const downAgain = press(down, "j");
      expect(downAgain.editor.cursor).toBe(13); // back to column 3 on the third line
      const up = press(downAgain, "k");
      expect(up.editor.cursor).toBe(8);
    });
  });

  describe("word motions", () => {
    it("w jumps to the start of the next word, skipping punctuation runs as their own class", () => {
      const frame = start("foo, bar baz", 0);
      const first = press(frame, "w");
      expect(first.editor.cursor).toBe(3); // start of the ',' punctuation run
      const second = press(first, "w");
      expect(second.editor.cursor).toBe(5); // start of "bar"
      const third = press(second, "w");
      expect(third.editor.cursor).toBe(9); // start of "baz"
    });

    it("b jumps to the start of the previous word", () => {
      const frame = start("foo bar baz", 8); // on 'b' of baz
      const back = press(frame, "b");
      expect(back.editor.cursor).toBe(4);
      const backAgain = press(back, "b");
      expect(backAgain.editor.cursor).toBe(0);
    });

    it("e jumps to the end of the current or next word", () => {
      const frame = start("foo bar", 0);
      const end = press(frame, "e");
      expect(end.editor.cursor).toBe(2); // end of "foo"
      const nextEnd = press(end, "e");
      expect(nextEnd.editor.cursor).toBe(6); // end of "bar"
    });
  });

  it("0 and $ jump to the first and last column of the current line", () => {
    const frame = start("hello world", 6);
    expect(press(frame, "0").editor.cursor).toBe(0);
    expect(press(frame, "$").editor.cursor).toBe(10);
  });

  it("gg and G jump to the first and last line", () => {
    const frame = start("one\ntwo\nthree", 5);
    const top = press(frame, "g");
    const topTop = press(top, "g");
    expect(topTop.editor.cursor).toBe(0);
    const bottom = press(frame, "G");
    expect(bottom.editor.cursor).toBe(8); // start of "three"
  });

  it("x deletes the character under the cursor into the register", () => {
    const frame = start("abc", 1);
    const deleted = press(frame, "x");
    expect(deleted.editor).toEqual({ value: "ac", cursor: 1 });
    expect(deleted.vim.register).toEqual({ text: "b", linewise: false });
  });

  it("dd deletes the whole current line and merges the surrounding lines", () => {
    const frame = start("one\ntwo\nthree", 5); // inside "two"
    const deleted = press(press(frame, "d"), "d");
    expect(deleted.editor.value).toBe("one\nthree");
    expect(deleted.vim.register).toEqual({ text: "two\n", linewise: true });
  });

  it("dd on the only line clears the buffer", () => {
    const frame = start("solo", 2);
    const deleted = press(press(frame, "d"), "d");
    expect(deleted.editor).toEqual({ value: "", cursor: 0 });
  });

  it("dw deletes from the cursor to the start of the next word", () => {
    const frame = start("foo bar baz", 0);
    const deleted = press(press(frame, "d"), "w");
    expect(deleted.editor).toEqual({ value: "bar baz", cursor: 0 });
    expect(deleted.vim.register).toEqual({ text: "foo ", linewise: false });
  });

  it("cc clears the current line's text and enters INSERT", () => {
    const frame = start("one\ntwo\nthree", 5);
    const changed = press(press(frame, "c"), "c");
    expect(changed.editor).toEqual({ value: "one\n\nthree", cursor: 4 });
    expect(changed.vim.mode).toBe("insert");
    const typed = type(changed, "TWO");
    expect(typed.editor.value).toBe("one\nTWO\nthree");
  });

  it("cw behaves like ce: changes to the end of the current word", () => {
    const frame = start("foo bar", 0);
    const changed = press(press(frame, "c"), "w");
    expect(changed.editor).toEqual({ value: " bar", cursor: 0 });
    expect(changed.vim.mode).toBe("insert");
  });

  it("yy yanks the current line linewise, and p pastes it below", () => {
    const frame = start("one\ntwo", 0);
    const yanked = press(press(frame, "y"), "y");
    expect(yanked.vim.register).toEqual({ text: "one\n", linewise: true });
    expect(yanked.editor.cursor).toBe(0); // yank doesn't move the cursor off the yanked line
    const pasted = press(yanked, "p");
    expect(pasted.editor.value).toBe("one\none\ntwo");
  });

  it("charwise yank and p pastes immediately after the cursor", () => {
    const frame = start("abcdef", 0);
    const yanked = press(press(frame, "y"), "l"); // yl == yank 'a'
    expect(yanked.vim.register).toEqual({ text: "a", linewise: false });
    const pasted = press(yanked, "p");
    expect(pasted.editor.value).toBe("aabcdef");
  });

  it("u undoes the most recent mutating command", () => {
    const frame = start("abc", 0);
    const deleted = press(frame, "x");
    expect(deleted.editor.value).toBe("bc");
    const undone = press(deleted, "u");
    expect(undone.editor).toEqual({ value: "abc", cursor: 0 });
  });

  it("u undoes a whole insert session (typed text) as a single step", () => {
    const frame = press(start("go", 0), "i");
    const typed = type(frame, "hi ");
    const afterEscape = press(typed, "", { escape: true });
    expect(afterEscape.editor.value).toBe("hi go");
    const undone = press(afterEscape, "u");
    expect(undone.editor).toEqual({ value: "go", cursor: 0 });
  });

  describe("visual mode", () => {
    it("v + motion selects, and d deletes the selection", () => {
      const frame = start("abcdef", 0);
      const visual = press(frame, "v");
      expect(visual.vim.mode).toBe("visual");
      const extended = press(press(visual, "l"), "l"); // select a,b,c (anchor 0, cursor 2, inclusive)
      const deleted = press(extended, "d");
      expect(deleted.editor).toEqual({ value: "def", cursor: 0 });
      expect(deleted.vim.mode).toBe("normal");
    });

    it("v + motion + y yanks without deleting, then p pastes it", () => {
      const frame = start("abcdef", 0);
      const selected = press(press(press(frame, "v"), "l"), "l");
      const yanked = press(selected, "y");
      expect(yanked.editor).toEqual({ value: "abcdef", cursor: 0 });
      expect(yanked.vim.register).toEqual({ text: "abc", linewise: false });
      const pasted = press(yanked, "p");
      expect(pasted.editor.value).toBe("aabcbcdef");
    });
  });

  describe("keys vim doesn't own", () => {
    it("leaves an Enter/Tab-shaped key (no text, no recognized flag) unhandled in both modes, so submit/palette-completion always runs", () => {
      const normalFrame = start("abc", 0);
      expect(stepVim(normalFrame.editor, normalFrame.vim, "", key()).handled).toBe(false);

      const insertFrame = press(normalFrame, "i");
      expect(stepVim(insertFrame.editor, insertFrame.vim, "", key()).handled).toBe(false);
    });

    it("passes ctrl-combo keys through unhandled in INSERT mode so existing shortcuts keep working", () => {
      const insertFrame = press(start("abc", 0), "i");
      const ctrlU = stepVim(insertFrame.editor, insertFrame.vim, "u", key({ ctrl: true }));
      expect(ctrlU.handled).toBe(false);
    });

    it("passes up/down arrows through unhandled in INSERT mode (history stays available while typing)", () => {
      const insertFrame = press(start("abc", 0), "i");
      const up = stepVim(insertFrame.editor, insertFrame.vim, "", key({ upArrow: true }));
      expect(up.handled).toBe(false);
    });

    it("handles up/down arrows as j/k motions in NORMAL mode instead of history", () => {
      const frame = start("abc\ndef", 1);
      const down = stepVim(frame.editor, frame.vim, "", key({ downArrow: true }));
      expect(down.handled).toBe(true);
      expect(down.editor.cursor).toBe(5);
    });

    it("swallows a multi-character paste in NORMAL mode instead of falling through to raw insertion", () => {
      const frame = start("abc", 0);
      const pasted = stepVim(frame.editor, frame.vim, "pasted text", key());
      expect(pasted.handled).toBe(true);
      expect(pasted.editor.value).toBe("abc");
      expect(pasted.vim.mode).toBe("normal");
    });

    it("swallows a multi-character paste in VISUAL mode too", () => {
      const frame = press(start("abc", 0), "v");
      expect(frame.vim.mode).toBe("visual");
      const pasted = stepVim(frame.editor, frame.vim, "pasted text", key());
      expect(pasted.handled).toBe(true);
      expect(pasted.editor.value).toBe("abc");
    });

    it("still inserts a multi-character paste normally in INSERT mode", () => {
      const frame = press(start("abc", 3), "i");
      const pasted = stepVim(frame.editor, frame.vim, "pasted text", key());
      expect(pasted.handled).toBe(true);
      expect(pasted.editor.value).toBe("abcpasted text");
    });
  });

  describe("resetVimStateForNewBuffer", () => {
    it("returns to NORMAL mode and clears undo/pending state, but keeps the yank register", () => {
      const frame = start("abcdef", 0);
      const yanked = press(press(frame, "y"), "y");
      const midInsert = press(yanked, "i");
      const reset = resetVimStateForNewBuffer(midInsert.vim);
      expect(reset).toEqual({ mode: "normal", anchor: 0, register: { text: "abcdef", linewise: true }, history: [] });
    });
  });
});
