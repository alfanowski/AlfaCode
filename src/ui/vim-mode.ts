/**
 * A small, self-contained modal-editing engine for the composer.
 *
 * Design: `stepVim` is a pure reducer — `(editor, vimState, text, key) -> { editor, vimState, handled }`.
 * It owns NORMAL/VISUAL command dispatch and INSERT-mode text edits (delegated to `editInput` so
 * surrogate-pair handling never diverges from the plain, non-vim composer). Callers (chat-tui.tsx)
 * only need to: keep `VimState` alongside the existing `EditorState`, call `stepVim` first, and if
 * `handled` is false, fall back to the pre-existing key handling (Enter/Tab/history/ctrl-combos stay
 * owned by chat-tui.tsx so vim mode composes with the rest of the composer instead of replacing it).
 *
 * Extensibility: motions live in one small table (`MOTIONS`) that maps a single logical "letter" to a
 * function computing a target offset plus linewise/inclusive flags. Operators (`d`/`c`/`y`) are generic
 * over any motion in that table, so adding a new motion automatically makes it available to every
 * operator (`dG`, `y0`, `c$`, ...) without operator-specific code. Doubled operators (`dd`/`cc`/`yy`)
 * and the `cw`→`ce` special case are the only hand-written exceptions, matching real vim.
 */
import { editInput, lineRange, nextCodePoint, previousCodePoint, type EditorState } from "./input-editor.js";

export type VimMode = "normal" | "insert" | "visual";

export interface VimRegister {
  readonly text: string;
  readonly linewise: boolean;
}

export interface VimState {
  readonly mode: VimMode;
  /** Selection anchor while `mode === "visual"`; meaningless otherwise. */
  readonly anchor: number;
  readonly register: VimRegister;
  /** Buffered leading key awaiting its next key: an operator (`d`/`c`/`y`) or the `g` of `gg`. */
  readonly pendingKey?: string;
  /** Editor snapshot captured when the current insert session began, committed to `history` on Escape (one undo step per insert session, like real vim). */
  readonly insertSnapshot?: EditorState;
  /** The column consecutive `j`/`k` presses try to land on (vim's "curswant"), so hopping over a short line doesn't forget where a taller line's column was. Cleared by any other motion or edit. */
  readonly desiredColumn?: number;
  readonly history: readonly EditorState[];
}

/** Structural subset of Ink's `Key` type — kept independent of Ink so this module has no UI dependency. */
export interface VimKeyLike {
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly escape: boolean;
  readonly backspace: boolean;
  readonly delete: boolean;
  readonly leftArrow: boolean;
  readonly rightArrow: boolean;
  readonly upArrow: boolean;
  readonly downArrow: boolean;
  readonly home: boolean;
  readonly end: boolean;
}

export interface VimStep {
  readonly editor: EditorState;
  readonly vim: VimState;
  /** False means: this key isn't vim's to consume — the caller should run its normal (non-vim) handling. */
  readonly handled: boolean;
}

const MAX_UNDO_DEPTH = 200;
const EMPTY_REGISTER: VimRegister = { text: "", linewise: false };
const OPERATORS = new Set(["d", "c", "y"]);

export function createVimState(): VimState {
  return { mode: "normal", anchor: 0, register: EMPTY_REGISTER, history: [] };
}

/** Resets modal/pending/undo state for a fresh buffer (e.g. after submitting a prompt) while keeping the yank register, the same way a system clipboard survives across separate edits. */
export function resetVimStateForNewBuffer(vim: VimState): VimState {
  return { mode: "normal", anchor: 0, register: vim.register, history: [] };
}

export function stepVim(editor: EditorState, vim: VimState, text: string, key: VimKeyLike): VimStep {
  const step = key.escape ? handleEscape(editor, vim)
    : vim.mode === "insert" ? handleInsert(editor, vim, text, key)
    : handleCommand(editor, vim, text, key);
  if (!step.handled) return step;
  const letter = resolveLetter(text, key);
  const preserveColumn = vim.mode === "normal" && vim.pendingKey === undefined && (letter === "j" || letter === "k");
  const settled = preserveColumn ? step.vim : clearDesiredColumn(step.vim);
  if (settled.mode === "insert") return { editor: step.editor, vim: settled, handled: true };
  return { editor: { value: step.editor.value, cursor: clampNormalCursor(step.editor.value, step.editor.cursor) }, vim: settled, handled: true };
}

// ---------------------------------------------------------------------------
// INSERT mode: delegate to the plain editor; leave Enter/Tab/ctrl-combos/history arrows unhandled.
// ---------------------------------------------------------------------------

function handleInsert(editor: EditorState, vim: VimState, text: string, key: VimKeyLike): VimStep {
  if (key.upArrow || key.downArrow) return notHandled(editor, vim);
  if (key.leftArrow) return handled(editInput(editor, { type: "left" }), vim);
  if (key.rightArrow) return handled(editInput(editor, { type: "right" }), vim);
  if (key.home) return handled(editInput(editor, { type: "home" }), vim);
  if (key.end) return handled(editInput(editor, { type: "end" }), vim);
  if (key.backspace) return handled(editInput(editor, { type: "backspace" }), vim);
  if (key.delete) return handled(editInput(editor, { type: "delete" }), vim);
  if (key.ctrl || key.meta) return notHandled(editor, vim);
  if (text.length === 0) return notHandled(editor, vim);
  return handled(editInput(editor, { type: "insert", text }), vim);
}

function handleEscape(editor: EditorState, vim: VimState): VimStep {
  if (vim.mode === "insert") {
    const { start } = lineRange(editor.value, editor.cursor);
    const cursor = editor.cursor > start ? previousCodePoint(editor.value, editor.cursor) : editor.cursor;
    const history = vim.insertSnapshot === undefined ? vim.history : [...vim.history, vim.insertSnapshot].slice(-MAX_UNDO_DEPTH);
    return handled({ value: editor.value, cursor }, clearSnapshot(clearPending({ ...vim, mode: "normal", history })));
  }
  if (vim.mode === "visual") return handled(editor, clearPending({ ...vim, mode: "normal" }));
  return handled(editor, clearPending(vim));
}

// ---------------------------------------------------------------------------
// NORMAL / VISUAL mode command dispatch
// ---------------------------------------------------------------------------

function handleCommand(editor: EditorState, vim: VimState, text: string, key: VimKeyLike): VimStep {
  const letter = resolveLetter(text, key);
  if (letter === undefined) return notHandled(editor, vim);
  return vim.mode === "visual" ? handleVisual(editor, vim, letter) : handleNormal(editor, vim, letter);
}

function handleNormal(editor: EditorState, vim: VimState, letter: string): VimStep {
  if (vim.pendingKey === "g") {
    const cleared = clearPending(vim);
    if (letter === "g") return applyMotionMove(editor, cleared, MOTIONS.gg!);
    return handled(editor, cleared);
  }
  if (vim.pendingKey !== undefined && OPERATORS.has(vim.pendingKey)) {
    return applyPendingOperator(editor, vim, vim.pendingKey as "d" | "c" | "y", letter);
  }
  if (letter === "j" || letter === "k") return applyVerticalMotion(editor, vim, letter === "j" ? 1 : -1);
  const motion = MOTIONS[letter];
  if (motion !== undefined) return applyMotionMove(editor, vim, motion);
  switch (letter) {
    case "g": return handled(editor, setPending(vim, "g"));
    case "x": return performDeleteChar(editor, vim);
    case "d": case "c": case "y": return handled(editor, setPending(vim, letter));
    case "p": return performPaste(editor, vim);
    case "u": return performUndo(editor, vim);
    case "i": return handled(editor, beginInsert(clearPending(vim), editor));
    case "a": return handled(moveCursor(editor, nextCodePoint(editor.value, editor.cursor)), beginInsert(clearPending(vim), editor));
    case "I": return handled(moveCursor(editor, lineRange(editor.value, editor.cursor).start), beginInsert(clearPending(vim), editor));
    case "A": return handled(moveCursor(editor, lineRange(editor.value, editor.cursor).end), beginInsert(clearPending(vim), editor));
    case "o": return performOpenLine(editor, vim, "below");
    case "O": return performOpenLine(editor, vim, "above");
    case "v": return handled(editor, { ...clearPending(vim), mode: "visual", anchor: editor.cursor });
    default: return handled(editor, vim);
  }
}

function handleVisual(editor: EditorState, vim: VimState, letter: string): VimStep {
  if (vim.pendingKey === "g") {
    const cleared = clearPending(vim);
    if (letter === "g") return handled(moveCursor(editor, MOTIONS.gg!(editor.value, editor.cursor).index), cleared);
    return handled(editor, cleared);
  }
  const motion = MOTIONS[letter];
  if (motion !== undefined) return handled(moveCursor(editor, motion(editor.value, editor.cursor).index), vim);
  switch (letter) {
    case "g": return handled(editor, setPending(vim, "g"));
    case "d": case "x": return performVisualDelete(editor, vim, false);
    case "c": return performVisualDelete(editor, vim, true);
    case "y": return performVisualYank(editor, vim);
    case "v": return handled(editor, { ...clearPending(vim), mode: "normal" });
    default: return handled(editor, vim);
  }
}

// ---------------------------------------------------------------------------
// Motions — each maps (value, cursor) -> target offset plus linewise/inclusive flags.
// ---------------------------------------------------------------------------

interface MotionResult { readonly index: number; readonly linewise: boolean; readonly inclusive: boolean; }
type Motion = (value: string, cursor: number) => MotionResult;

const MOTIONS: Record<string, Motion> = {
  h: (value, cursor) => ({ index: Math.max(lineRange(value, cursor).start, previousCodePoint(value, cursor)), linewise: false, inclusive: false }),
  l: (value, cursor) => ({ index: Math.min(lineRange(value, cursor).end, nextCodePoint(value, cursor)), linewise: false, inclusive: false }),
  j: (value, cursor) => moveVertical(value, cursor, 1),
  k: (value, cursor) => moveVertical(value, cursor, -1),
  w: wordForward,
  b: wordBackward,
  e: wordEnd,
  "0": (value, cursor) => ({ index: lineRange(value, cursor).start, linewise: false, inclusive: false }),
  "$": (value, cursor) => ({ index: lastColumn(value, cursor), linewise: false, inclusive: true }),
  gg: () => ({ index: 0, linewise: true, inclusive: false }),
  G: (value) => ({ index: lineRange(value, Math.max(0, value.length - 1)).start, linewise: true, inclusive: false }),
};

function lastColumn(value: string, cursor: number): number {
  const { start, end } = lineRange(value, cursor);
  return end === start ? start : previousCodePoint(value, end);
}

/** Used directly by `applyVerticalMotion` (sticky column) and by the generic operator table (`dj`/`yk`, one-shot, no sticky column needed). */
function moveVertical(value: string, cursor: number, direction: 1 | -1, overrideColumn?: number): MotionResult {
  const current = lineRange(value, cursor);
  const column = overrideColumn ?? cursor - current.start;
  if (direction > 0) {
    if (current.end >= value.length) return { index: cursor, linewise: true, inclusive: false };
    const target = lineRange(value, current.end + 1);
    return { index: Math.min(target.start + column, target.end), linewise: true, inclusive: false };
  }
  if (current.start === 0) return { index: cursor, linewise: true, inclusive: false };
  const target = lineRange(value, current.start - 1);
  return { index: Math.min(target.start + column, target.end), linewise: true, inclusive: false };
}

type CharClass = "space" | "word" | "punct";

function classifyAt(value: string, index: number): CharClass {
  const end = nextCodePoint(value, index);
  const ch = value.slice(index, end);
  if (ch.length === 0 || /\s/u.test(ch)) return "space";
  return /[\p{L}\p{N}_]/u.test(ch) ? "word" : "punct";
}

function wordForward(value: string, cursor: number): MotionResult {
  const n = value.length;
  let i = cursor;
  if (i >= n) return { index: n, linewise: false, inclusive: false };
  const startClass = classifyAt(value, i);
  if (startClass !== "space") { while (i < n && classifyAt(value, i) === startClass) i = nextCodePoint(value, i); }
  while (i < n && classifyAt(value, i) === "space") i = nextCodePoint(value, i);
  return { index: i, linewise: false, inclusive: false };
}

function wordEnd(value: string, cursor: number): MotionResult {
  const n = value.length;
  if (n === 0) return { index: 0, linewise: false, inclusive: true };
  let i = nextCodePoint(value, cursor);
  while (i < n && classifyAt(value, i) === "space") i = nextCodePoint(value, i);
  if (i >= n) return { index: previousCodePoint(value, n), linewise: false, inclusive: true };
  const cls = classifyAt(value, i);
  let j = nextCodePoint(value, i);
  while (j < n && classifyAt(value, j) === cls) j = nextCodePoint(value, j);
  return { index: previousCodePoint(value, j), linewise: false, inclusive: true };
}

function wordBackward(value: string, cursor: number): MotionResult {
  if (cursor <= 0) return { index: 0, linewise: false, inclusive: false };
  let i = previousCodePoint(value, cursor);
  while (i > 0 && classifyAt(value, i) === "space") i = previousCodePoint(value, i);
  if (classifyAt(value, i) === "space") return { index: 0, linewise: false, inclusive: false };
  const cls = classifyAt(value, i);
  for (;;) {
    if (i <= 0) break;
    const prev = previousCodePoint(value, i);
    if (classifyAt(value, prev) !== cls) break;
    i = prev;
  }
  return { index: i, linewise: false, inclusive: false };
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

function applyMotionMove(editor: EditorState, vim: VimState, motion: Motion): VimStep {
  return handled(moveCursor(editor, motion(editor.value, editor.cursor).index), vim);
}

/** Direct (non-operator) `j`/`k`: threads `desiredColumn` through consecutive presses so a short line in between doesn't reset it (real vim's "curswant"). `stepVim` decides whether to keep or clear it afterward. */
function applyVerticalMotion(editor: EditorState, vim: VimState, direction: 1 | -1): VimStep {
  const column = vim.desiredColumn ?? editor.cursor - lineRange(editor.value, editor.cursor).start;
  const result = moveVertical(editor.value, editor.cursor, direction, column);
  return handled(moveCursor(editor, result.index), { ...vim, desiredColumn: column });
}

function applyPendingOperator(editor: EditorState, vim: VimState, op: "d" | "c" | "y", letter: string): VimStep {
  const cleared = clearPending(vim);
  if (letter === op) return performLinewiseSelf(editor, cleared, op);
  if (op === "c" && letter === "w") return performOperatorMotion(editor, cleared, op, MOTIONS.e!, true);
  const motion = letter === "g" ? undefined : MOTIONS[letter];
  if (motion === undefined) return handled(editor, cleared);
  return performOperatorMotion(editor, cleared, op, motion, false);
}

function performOperatorMotion(editor: EditorState, vim: VimState, op: "d" | "c" | "y", motion: Motion, inclusiveOverride: boolean): VimStep {
  const result = motion(editor.value, editor.cursor);
  if (result.linewise) return applyLinewiseRange(editor, vim, op, editor.cursor, result.index);
  const inclusive = inclusiveOverride || result.inclusive;
  const from = Math.min(editor.cursor, result.index);
  const rawTo = Math.max(editor.cursor, result.index);
  const to = inclusive ? nextCodePoint(editor.value, rawTo) : rawTo;
  return applyCharwiseRange(editor, vim, op, from, to);
}

function applyCharwiseRange(editor: EditorState, vim: VimState, op: "d" | "c" | "y", from: number, to: number): VimStep {
  const removed = editor.value.slice(from, to);
  const register: VimRegister = { text: removed, linewise: false };
  if (op === "y") return handled(moveCursor(editor, from), { ...vim, register });
  const nextValue = editor.value.slice(0, from) + editor.value.slice(to);
  if (op === "c") return handled({ value: nextValue, cursor: from }, beginInsert({ ...vim, register }, editor));
  return handled({ value: nextValue, cursor: from }, pushUndo({ ...vim, register }, editor));
}

/** Whole complete lines spanning offsets `a`..`b`, including one adjoining line break so removal doesn't leave a stray blank line. */
function lineSpan(value: string, a: number, b: number): { readonly start: number; readonly end: number } {
  const start = lineRange(value, Math.min(a, b)).start;
  const last = lineRange(value, Math.max(a, b));
  if (last.end < value.length) return { start, end: last.end + 1 };
  if (start > 0) return { start: start - 1, end: last.end };
  return { start, end: last.end };
}

function applyLinewiseRange(editor: EditorState, vim: VimState, op: "d" | "c" | "y", from: number, to: number): VimStep {
  const span = lineSpan(editor.value, from, to);
  const removed = editor.value.slice(span.start, span.end);
  const register: VimRegister = { text: removed, linewise: true };
  if (op === "y") return handled(moveCursor(editor, lineRange(editor.value, Math.min(from, to)).start), { ...vim, register });
  const nextValue = editor.value.slice(0, span.start) + editor.value.slice(span.end);
  if (op === "c") return handled({ value: nextValue, cursor: span.start }, beginInsert({ ...vim, register }, editor));
  return handled({ value: nextValue, cursor: span.start }, pushUndo({ ...vim, register }, editor));
}

/** Doubled operator on the current line only: `dd`, `cc`, `yy`. */
function performLinewiseSelf(editor: EditorState, vim: VimState, op: "d" | "c" | "y"): VimStep {
  const { start, end } = lineRange(editor.value, editor.cursor);
  if (op === "c") {
    const removed = editor.value.slice(start, end);
    const nextValue = editor.value.slice(0, start) + editor.value.slice(end);
    return handled({ value: nextValue, cursor: start }, beginInsert({ ...vim, register: { text: removed, linewise: true } }, editor));
  }
  const span = lineSpan(editor.value, editor.cursor, editor.cursor);
  const removed = editor.value.slice(span.start, span.end);
  const register: VimRegister = { text: removed, linewise: true };
  if (op === "y") return handled(moveCursor(editor, start), { ...vim, register });
  const nextValue = editor.value.slice(0, span.start) + editor.value.slice(span.end);
  return handled({ value: nextValue, cursor: span.start }, pushUndo({ ...vim, register }, editor));
}

function performDeleteChar(editor: EditorState, vim: VimState): VimStep {
  const { end } = lineRange(editor.value, editor.cursor);
  if (editor.cursor >= end) return handled(editor, vim);
  const target = nextCodePoint(editor.value, editor.cursor);
  const removed = editor.value.slice(editor.cursor, target);
  const nextValue = editor.value.slice(0, editor.cursor) + editor.value.slice(target);
  return handled({ value: nextValue, cursor: editor.cursor }, pushUndo({ ...vim, register: { text: removed, linewise: false } }, editor));
}

function performPaste(editor: EditorState, vim: VimState): VimStep {
  if (vim.register.text.length === 0) return handled(editor, vim);
  if (vim.register.linewise) {
    const { end } = lineRange(editor.value, editor.cursor);
    const atEnd = end >= editor.value.length;
    const insertAt = atEnd ? editor.value.length : end + 1;
    const prefix = atEnd ? "\n" : "";
    const body = vim.register.text.endsWith("\n") ? vim.register.text : `${vim.register.text}\n`;
    const nextValue = editor.value.slice(0, insertAt) + prefix + body + editor.value.slice(insertAt);
    return handled({ value: nextValue, cursor: insertAt + prefix.length }, pushUndo(vim, editor));
  }
  const insertAt = editor.value.length === 0 ? 0 : nextCodePoint(editor.value, editor.cursor);
  const nextValue = editor.value.slice(0, insertAt) + vim.register.text + editor.value.slice(insertAt);
  return handled({ value: nextValue, cursor: insertAt + vim.register.text.length }, pushUndo(vim, editor));
}

function performUndo(editor: EditorState, vim: VimState): VimStep {
  const previous = vim.history.at(-1);
  if (previous === undefined) return handled(editor, vim);
  return handled(previous, { ...vim, history: vim.history.slice(0, -1) });
}

function performOpenLine(editor: EditorState, vim: VimState, where: "below" | "above"): VimStep {
  const { start, end } = lineRange(editor.value, editor.cursor);
  const insertAt = where === "below" ? end : start;
  const nextValue = editor.value.slice(0, insertAt) + "\n" + editor.value.slice(insertAt);
  const cursor = where === "below" ? insertAt + 1 : insertAt;
  return handled({ value: nextValue, cursor }, beginInsert(vim, editor));
}

function visualRange(value: string, cursor: number, anchor: number): { readonly start: number; readonly end: number } {
  const start = Math.min(cursor, anchor);
  const end = Math.min(value.length, nextCodePoint(value, Math.max(cursor, anchor)));
  return { start, end };
}

function performVisualDelete(editor: EditorState, vim: VimState, enterInsert: boolean): VimStep {
  const { start, end } = visualRange(editor.value, editor.cursor, vim.anchor);
  const removed = editor.value.slice(start, end);
  const nextValue = editor.value.slice(0, start) + editor.value.slice(end);
  const register: VimRegister = { text: removed, linewise: false };
  if (enterInsert) return handled({ value: nextValue, cursor: start }, beginInsert({ ...clearPending(vim), register }, editor));
  return handled({ value: nextValue, cursor: start }, pushUndo({ ...clearPending(vim), mode: "normal", register }, editor));
}

function performVisualYank(editor: EditorState, vim: VimState): VimStep {
  const { start, end } = visualRange(editor.value, editor.cursor, vim.anchor);
  const removed = editor.value.slice(start, end);
  return handled(moveCursor(editor, start), { ...clearPending(vim), mode: "normal", register: { text: removed, linewise: false } });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function resolveLetter(text: string, key: VimKeyLike): string | undefined {
  if (key.ctrl || key.meta) return undefined;
  if (key.leftArrow) return "h";
  if (key.rightArrow) return "l";
  if (key.upArrow) return "k";
  if (key.downArrow) return "j";
  if (key.backspace) return "h";
  return text.length === 1 ? text : undefined;
}

function moveCursor(editor: EditorState, cursor: number): EditorState {
  return { value: editor.value, cursor };
}

function clampNormalCursor(value: string, index: number): number {
  const clamped = Math.max(0, Math.min(value.length, index));
  const { start, end } = lineRange(value, clamped);
  if (end === start) return start;
  return Math.min(clamped, previousCodePoint(value, end));
}

function pushUndo(vim: VimState, before: EditorState): VimState {
  return { ...vim, history: [...vim.history, before].slice(-MAX_UNDO_DEPTH) };
}

function beginInsert(vim: VimState, before: EditorState): VimState {
  return { ...vim, mode: "insert", insertSnapshot: vim.insertSnapshot ?? before };
}

function setPending(vim: VimState, pendingKey: string): VimState {
  return { ...vim, pendingKey };
}

function clearPending(vim: VimState): VimState {
  if (vim.pendingKey === undefined) return vim;
  const { pendingKey: _pendingKey, ...rest } = vim;
  return rest;
}

function clearSnapshot(vim: VimState): VimState {
  if (vim.insertSnapshot === undefined) return vim;
  const { insertSnapshot: _insertSnapshot, ...rest } = vim;
  return rest;
}

function clearDesiredColumn(vim: VimState): VimState {
  if (vim.desiredColumn === undefined) return vim;
  const { desiredColumn: _desiredColumn, ...rest } = vim;
  return rest;
}

function handled(editor: EditorState, vim: VimState): VimStep {
  return { editor, vim, handled: true };
}

function notHandled(editor: EditorState, vim: VimState): VimStep {
  return { editor, vim, handled: false };
}
