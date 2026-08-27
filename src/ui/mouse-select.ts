import { useEffect } from "react";

/**
 * Mouse-driven "select text, it gets copied" support for the terminal. Ink has no built-in mouse
 * support at all — this is built from scratch on top of the xterm SGR extended mouse-tracking
 * protocol, in three pieces, all pure and unit-testable:
 *
 *  1. `ENABLE_MOUSE_TRACKING` / `DISABLE_MOUSE_TRACKING` + `useMouseTrackingMode`: the terminal-mode
 *     lifecycle (write the enable sequence once on mount, the disable sequence on every teardown
 *     path). This module does NOT attach its own stdin listener — see `useMouseTrackingMode`'s doc
 *     comment for why, and chat-tui.tsx for where the actual SGR reports get read.
 *  2. `parseSgrMouseSequence`: decodes one SGR mouse report into a structured event.
 *  3. `reduceMouseSelection` / `mouseSelectionRowSpan` / `resolveMouseSelectionItems`: a tiny state
 *     machine that turns a press → drag* → release sequence into a completed selection span, plus a
 *     row-count heuristic that maps that span onto whole rendered transcript items. See
 *     `resolveMouseSelectionItems`'s doc comment for exactly what granularity that gives you, and
 *     why exact (row, col) → character mapping isn't attempted.
 */

/** Enables xterm SGR extended mouse tracking: button press/release/drag reporting (1000), decimal
 * (not raw-byte) coordinates (1006) so columns/rows past 223 don't corrupt the encoding. Write once
 * on startup. */
export const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h";
/** The exact inverse of `ENABLE_MOUSE_TRACKING`. MUST be written on every exit path — normal exit,
 * Ctrl+C, an uncaught error — or the user's terminal is left reporting mouse events (as garbage
 * escape sequences) to whatever runs next in it after AlfaCode quits. */
export const DISABLE_MOUSE_TRACKING = "\x1b[?1000l\x1b[?1006l";

export type SgrMouseEventKind = "press" | "drag" | "release";

export interface SgrMouseEvent {
  readonly kind: SgrMouseEventKind;
  /** 0 = left, 1 = middle, 2 = right. Only meaningful when `isWheel` is false. */
  readonly button: number;
  /** 1-based terminal column. */
  readonly column: number;
  /** 1-based terminal row. */
  readonly row: number;
  readonly isWheel: boolean;
}

/**
 * Matches an SGR mouse report body: `Cb;Cx;CyM` (press/drag) or `...m` (release), per xterm's
 * "SGR 1006" mouse-tracking spec.
 *
 * The leading ESC is optional on purpose. The true wire protocol always has one (`ESC [ < ...`),
 * but Ink's own key parser (`parse-keypress.js`) strips the leading ESC byte off any sequence it
 * doesn't recognize as a named key before handing it to `useInput` as `text` — confirmed by reading
 * Ink's source: it never matches the mouse report's `fnKeyRe`/`metaKeyCodeRe` key patterns (the `<`
 * right after `[` breaks both), so it falls through to `key.sequence = s` (the full original
 * string) and then `useInput`'s `handleData` unconditionally strips exactly one leading ESC byte
 * off `input` before invoking the callback. So what actually reaches a `useInput` callback for a
 * mouse report is `"[<0;45;12M"` — ESC already stripped, not the full wire-protocol sequence.
 * Accepting both forms keeps this function correct against the real wire protocol (and directly
 * testable against it) while also being exactly what chat-tui.tsx feeds it live.
 */
const SGR_MOUSE_PATTERN = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/u;

/** Pure: decodes one complete SGR mouse report. `undefined` for anything else (not a mouse report,
 * or an incomplete/malformed one) — never throws. */
export function parseSgrMouseSequence(text: string): SgrMouseEvent | undefined {
  const match = SGR_MOUSE_PATTERN.exec(text);
  if (match === null) return undefined;
  const buttonByte = Number.parseInt(match[1]!, 10);
  const column = Number.parseInt(match[2]!, 10);
  const row = Number.parseInt(match[3]!, 10);
  if (column < 1 || row < 1) return undefined;
  const isWheel = (buttonByte & 0x40) !== 0;
  const isMotion = (buttonByte & 0x20) !== 0;
  const button = buttonByte & 0x03;
  const kind: SgrMouseEventKind = match[4] === "m" ? "release" : isMotion ? "drag" : "press";
  return { kind, button, column, row, isWheel };
}

export interface MouseSelectionTrackerState {
  readonly startRow: number;
  readonly startCol: number;
}

export interface MouseSelectionSpan {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

export interface MouseSelectionReduceResult {
  readonly state: MouseSelectionTrackerState | undefined;
  readonly completed: MouseSelectionSpan | undefined;
}

/**
 * Pure press → drag* → release reducer, one event in, next state + (maybe) a completed span out.
 * Only the left button (button 0) drives a selection: middle/right clicks and wheel events pass
 * through with the tracker state untouched, so e.g. a terminal's own native right-click paste is
 * never mistaken for a drag. A `release` landing on the exact same cell the `press` started at is a
 * plain click, not a drag — deliberately reported as nothing completed (nothing was "selected").
 */
export function reduceMouseSelection(state: MouseSelectionTrackerState | undefined, event: SgrMouseEvent): MouseSelectionReduceResult {
  if (event.isWheel || event.button !== 0) return { state, completed: undefined };
  if (event.kind === "press") return { state: { startRow: event.row, startCol: event.column }, completed: undefined };
  if (event.kind === "drag") return { state, completed: undefined };
  // release
  if (state === undefined) return { state: undefined, completed: undefined };
  const span: MouseSelectionSpan = { startRow: state.startRow, startCol: state.startCol, endRow: event.row, endCol: event.column };
  const isClick = span.startRow === span.endRow && span.startCol === span.endCol;
  return { state: undefined, completed: isClick ? undefined : span };
}

/** How many terminal rows a completed drag crossed (inclusive of both ends), regardless of drag direction. */
export function mouseSelectionRowSpan(span: MouseSelectionSpan): number {
  return Math.abs(span.endRow - span.startRow) + 1;
}

/**
 * Maps a mouse-drag's row span onto whole rendered transcript items — this is message-granularity,
 * not a true (col, row) → character mapping. Ink repaints its entire live region on every update
 * rather than owning a stable mapping from an absolute terminal row to "this is line 3 of message
 * #12"; reconstructing that would mean re-deriving Ink's own Yoga layout tree outside of Ink, which
 * is out of reasonable scope for this feature.
 *
 * Instead: `rowSpan` (how many terminal rows the drag crossed) is walked backward from the newest
 * item in `items`, accumulating each item's own estimated on-screen row count via `estimateRows`,
 * until the accumulated total meets or exceeds `rowSpan`. That reproduces, at message granularity,
 * "roughly how far up from the bottom of the screen did this drag reach" — correct when the
 * selection (the overwhelmingly common case: the text just printed, right above the composer) is
 * anchored near the newest rendered item, and an honest approximation rather than a precise mapping
 * for a drag that started higher up an already-scrolled view. `items` should be exactly what's
 * currently rendered (the same slice the transcript viewport shows), oldest first.
 */
export function resolveMouseSelectionItems<T>(items: readonly T[], rowSpan: number, estimateRows: (item: T) => number): readonly T[] {
  if (items.length === 0 || rowSpan <= 0) return [];
  let used = 0;
  const output: T[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (output.length > 0 && used >= rowSpan) break;
    const item = items[index]!;
    output.unshift(item);
    used += estimateRows(item);
  }
  return output;
}

export interface UseMouseTrackingModeOptions {
  readonly enabled: boolean;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
}

/**
 * Owns ONLY the terminal-mode lifecycle — enable on mount (and whenever `enabled` flips from false
 * to true), disable on cleanup. Deliberately does NOT attach its own stdin listener: Ink already
 * hands every SGR mouse report to `useInput` as an unrecognized-key `text` event (see this module's
 * top-of-file doc and `parseSgrMouseSequence`'s doc comment), and Ink's own input pipeline reads
 * `stdin` in paused mode via `stdin.on('readable', …)` + `stdin.read()`. Adding a second, competing
 * `stdin.on('data', …)` listener here would switch the stream into flowing mode, which fights that
 * paused-mode reader and can drop or duplicate input — so the actual parsing happens inline in
 * chat-tui.tsx's existing `useInput` callback instead, ahead of its own key handling.
 *
 * The disable sequence is written from a plain `useEffect` cleanup — the same lifecycle point Ink
 * itself relies on for its own terminal-mode teardown (raw mode, alternate-screen, cursor
 * visibility, …): Ink's `unmount()` — invoked on normal exit, `useApp().exit()`, and, via the
 * `signal-exit` package, on Ctrl+C/SIGINT/SIGTERM/an uncaught error alike — synchronously unmounts
 * the whole React tree and flushes pending passive effects before resolving, so this cleanup runs
 * on every exit path, not only a graceful one.
 */
export function useMouseTrackingMode(options: UseMouseTrackingModeOptions): void {
  const { enabled } = options;
  const stdout = options.stdout ?? process.stdout;
  useEffect(() => {
    if (!enabled) return;
    stdout.write(ENABLE_MOUSE_TRACKING);
    return () => { stdout.write(DISABLE_MOUSE_TRACKING); };
  }, [enabled, stdout]);
}
