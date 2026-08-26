export interface EditorState {
  readonly value: string;
  readonly cursor: number;
}

export type EditorOperation =
  | { readonly type: "insert"; readonly text: string }
  | { readonly type: "left" }
  | { readonly type: "right" }
  | { readonly type: "home" }
  | { readonly type: "end" }
  | { readonly type: "backspace" }
  | { readonly type: "delete" }
  | { readonly type: "delete-to-start" }
  | { readonly type: "delete-to-end" }
  | { readonly type: "delete-word" };

export function editInput(state: EditorState, operation: EditorOperation): EditorState {
  const cursor = clampCursor(state.value, state.cursor);
  switch (operation.type) {
    case "insert":
      return {
        value: state.value.slice(0, cursor) + operation.text + state.value.slice(cursor),
        cursor: cursor + operation.text.length,
      };
    case "left": return { value: state.value, cursor: previousCodePoint(state.value, cursor) };
    case "right": return { value: state.value, cursor: nextCodePoint(state.value, cursor) };
    case "home": return { value: state.value, cursor: 0 };
    case "end": return { value: state.value, cursor: state.value.length };
    case "backspace": {
      const start = previousCodePoint(state.value, cursor);
      return { value: state.value.slice(0, start) + state.value.slice(cursor), cursor: start };
    }
    case "delete": {
      const end = nextCodePoint(state.value, cursor);
      return { value: state.value.slice(0, cursor) + state.value.slice(end), cursor };
    }
    case "delete-to-start": return { value: state.value.slice(cursor), cursor: 0 };
    case "delete-to-end": return { value: state.value.slice(0, cursor), cursor };
    case "delete-word": {
      const prefix = state.value.slice(0, cursor);
      const start = prefix.search(/\s*\S+\s*$/u);
      const safeStart = start < 0 ? 0 : start;
      return { value: state.value.slice(0, safeStart) + state.value.slice(cursor), cursor: safeStart };
    }
  }
}

export function splitAtCursor(state: EditorState): { readonly before: string; readonly cursor: string; readonly after: string } {
  const index = clampCursor(state.value, state.cursor);
  const end = nextCodePoint(state.value, index);
  return {
    before: state.value.slice(0, index),
    cursor: state.value.slice(index, end) || " ",
    after: state.value.slice(end),
  };
}

/** Character offset (start inclusive, end exclusive of the line break) of the line containing `index`. Reused by vim-mode.ts for line-wise motions/operators. */
export function lineRange(value: string, index: number): { readonly start: number; readonly end: number } {
  const clamped = clampCursor(value, index);
  const start = value.lastIndexOf("\n", clamped - 1) + 1;
  const nextBreak = value.indexOf("\n", clamped);
  const end = nextBreak === -1 ? value.length : nextBreak;
  return { start, end };
}

function clampCursor(value: string, cursor: number): number {
  return Math.max(0, Math.min(value.length, cursor));
}

/** Exported so callers extending cursor movement (e.g. vim-mode motions) stay UTF-16-surrogate-pair-safe instead of re-deriving this. */
export function previousCodePoint(value: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const code = value.charCodeAt(cursor - 1);
  return code >= 0xDC00 && code <= 0xDFFF ? Math.max(0, cursor - 2) : cursor - 1;
}

export function nextCodePoint(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;
  const code = value.charCodeAt(cursor);
  return code >= 0xD800 && code <= 0xDBFF ? Math.min(value.length, cursor + 2) : cursor + 1;
}
