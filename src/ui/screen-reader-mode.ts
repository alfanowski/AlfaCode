import type { TranscriptItem } from "../chat-tui.js";

/**
 * Whether AlfaCode should render its plain, linear, screen-reader-friendly UI: no box-drawing
 * characters, no in-place redraws of history, numbered pickers instead of arrow-key highlighting.
 *
 * `ALFACODE_SCREEN_READER=1` is AlfaCode's own opt-in, following the `ALFACODE_THEME` /
 * `ALFACODE_REDUCED_MOTION` convention in ui/theme.ts. `INK_SCREEN_READER=true` is Ink's own
 * convention (see ink's "Screen Reader Support" docs) and is honored too, so an assistive setup
 * that already exports it for other Ink-based tools works here without extra configuration.
 */
export function isScreenReaderMode(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.ALFACODE_SCREEN_READER === "1" || environment.INK_SCREEN_READER === "true";
}

/**
 * Rings the terminal bell. Used as the screen-reader-mode completion signal: response completion,
 * a permission prompt appearing, and a tool call running past a short threshold. A sibling tier is
 * separately building a richer turn-completion notification; this plain `\x07` is a deliberately
 * simple fallback that doesn't depend on that work landing first.
 */
export function ringBell(write: (chunk: string) => void = (chunk) => { process.stdout.write(chunk); }): void {
  write("\x07");
}

/** Formats a 1-based numbered-list entry, e.g. `numberedLabel(0, "gpt-5")` -> `"1) gpt-5"`. */
export function numberedLabel(index: number, label: string): string {
  return `${index + 1}) ${label}`;
}

/**
 * Parses typed digits (e.g. "2") into a 0-based index, the numbered-picker counterpart to
 * arrow-key highlighting. Returns undefined for anything that isn't a plain positive integer
 * within range, so callers can fall back to their existing cursor-based selection.
 */
export function parseNumberedSelection(input: string, count: number): number | undefined {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const index = Number.parseInt(trimmed, 10) - 1;
  return index >= 0 && index < count ? index : undefined;
}

/**
 * Parses typed digits into a set of 0-based indexes for a multi-select numbered picker, e.g.
 * "1,3" or "1 3" -> [0, 2]. Returns undefined if any token is invalid or out of range, or if the
 * input has no digit tokens at all.
 */
export function parseNumberedMultiSelection(input: string, count: number): readonly number[] | undefined {
  const tokens = input.trim().split(/[\s,]+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;
  const indexes: number[] = [];
  for (const token of tokens) {
    const index = parseNumberedSelection(token, count);
    if (index === undefined) return undefined;
    if (!indexes.includes(index)) indexes.push(index);
  }
  return indexes;
}

export type YesNoDecision = "allow" | "allow-always" | "deny";

/** Parses a typed y/n(/a) permission decision, the plain-text alternative to arrow+enter. */
export function parseYesNoDecision(input: string, allowAlways: boolean): YesNoDecision | undefined {
  const value = input.trim().toLowerCase();
  if (value === "y" || value === "yes") return "allow";
  if (value === "n" || value === "no") return "deny";
  if (allowAlways && (value === "a" || value === "always")) return "allow-always";
  return undefined;
}

export interface TranscriptLogState {
  readonly loggedKeys: ReadonlySet<string>;
  readonly lines: readonly string[];
}

export const emptyTranscriptLog: TranscriptLogState = { loggedKeys: new Set(), lines: [] };

/** One plain-text line per transcript item, with a textual prefix instead of color/position. */
export function formatTranscriptLine(item: TranscriptItem): string {
  if (item.role === "user") return `You: ${item.text}`;
  if (item.role === "assistant") return `Assistant: ${item.text}`;
  if (item.role === "tool") return `Tool (${item.detail ?? "tool"}): ${item.text} — ${item.status ?? "running"}`;
  return `System: ${item.text}`;
}

/**
 * Turns the mutation-friendly TranscriptItem[] model used by the boxed chat UI (an assistant
 * message grows in place while it streams; a tool's status flips from "running" to "completed" on
 * the same item) into an append-only sequence of plain-text lines, safe to feed to Ink's
 * `<Static>`. Every event is logged exactly once and nothing already returned is ever rewritten:
 *
 * - A user/system item is logged the moment it's first seen.
 * - A tool item is logged twice: once when first seen (its start), and once more the first time
 *   its status is observed to have left "running" (its outcome) — two distinct lines rather than
 *   one rewritten in place.
 * - An assistant item is held back for as long as it is still the last item and `flushTail` is
 *   false (i.e. it may still be streaming); once something is appended after it, or the caller
 *   passes `flushTail: true` (a turn has ended), it is logged once as one complete line.
 */
export function appendTranscriptLog(state: TranscriptLogState, items: readonly TranscriptItem[], flushTail: boolean): TranscriptLogState {
  const loggedKeys = new Set(state.loggedKeys);
  const newLines: string[] = [];
  items.forEach((item, index) => {
    const isTail = index === items.length - 1;
    const wasLogged = state.loggedKeys.has(item.id);
    const stillStreaming = item.role === "assistant" && isTail && !flushTail;
    if (!wasLogged && !stillStreaming) {
      newLines.push(formatTranscriptLine(item));
      loggedKeys.add(item.id);
      return;
    }
    if (wasLogged && item.role === "tool" && item.status !== undefined && item.status !== "running") {
      const doneKey = `${item.id}:${item.status}`;
      if (!loggedKeys.has(doneKey)) {
        newLines.push(formatTranscriptLine(item));
        loggedKeys.add(doneKey);
      }
    }
  });
  return newLines.length === 0 ? state : { loggedKeys, lines: [...state.lines, ...newLines] };
}
