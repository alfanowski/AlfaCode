/**
 * Writes plain text to the system clipboard via the OSC 52 terminal escape sequence
 * (`ESC ] 52 ; c ; <base64> BEL`) — the terminal-protocol clipboard-set request that most modern
 * terminal emulators honor (iTerm2, Kitty, WezTerm, Windows Terminal, recent xterm/VTE, ...) and,
 * crucially, one that works over SSH: the terminal the user is physically looking at receives the
 * sequence over the same stream as everything else AlfaCode prints, so there's no clipboard
 * binary, DBus session, or native dependency required on whatever host AlfaCode happens to be
 * running on. This is what backs the `/copy` command in chat-tui.tsx.
 *
 * SECURITY BOUNDARY — read before touching this file:
 * `sanitizeTerminalText` (src/ui/markdown.tsx) strips OSC 52 — and every other OSC/DCS/CSI escape
 * — out of MODEL AND TOOL OUTPUT before it is ever rendered to the terminal. That's the
 * load-bearing protection against a malicious or compromised model response smuggling an OSC 52
 * sequence into its own text to hijack the user's clipboard; every assistant/tool transcript row
 * passes through it on the way to the screen. This module is the opposite, controlled direction:
 * AlfaCode's OWN code, only in direct response to an explicit user-typed `/copy` command, builds a
 * real OSC 52 sequence and writes it to the terminal itself. Its payload is content AlfaCode
 * already rendered and sanitized — `markdownToPlainText` in markdown.tsx (which `/copy` uses to
 * build that payload) runs the same `sanitizeTerminalText` over the source before doing anything
 * else with it, so no unsanitized model output can ever ride through this path as a live escape
 * sequence. This file never reads, calls, or weakens `sanitizeTerminalText` — it's the other side
 * of that boundary, not an exception to it.
 */

const OSC52_OPEN = "\x1b]52;c;";
const OSC52_CLOSE = "\x07";

/**
 * Most terminals cap how much they'll accept in one OSC 52 request — xterm's long-standing
 * default is 100,000 bytes for the whole escape sequence, which limits the raw (pre-base64) text
 * to comfortably less than that once the ~4/3 base64 blow-up is accounted for. Staying well inside
 * that budget means a long `/copy` request degrades to "copies a truncated tail" instead of
 * "silently ignored by the terminal" or "corrupts terminal state".
 */
export const MAX_CLIPBOARD_TEXT_BYTES = 70_000;

export interface Osc52Copy {
  readonly sequence: string;
  readonly truncated: boolean;
}

/**
 * Pure: builds the exact OSC 52 clipboard-set escape sequence for `text`. When the UTF-8 byte
 * length of `text` exceeds `maxBytes`, truncates to the largest whole-codepoint prefix that fits
 * before base64-encoding (never splits a multi-byte character mid-sequence) and reports that via
 * `truncated`.
 */
export function encodeOsc52Copy(text: string, maxBytes: number = MAX_CLIPBOARD_TEXT_BYTES): Osc52Copy {
  const { value, truncated } = truncateToByteBudget(text, maxBytes);
  const base64 = Buffer.from(value, "utf8").toString("base64");
  return { sequence: `${OSC52_OPEN}${base64}${OSC52_CLOSE}`, truncated };
}

function truncateToByteBudget(text: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { value: text, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid; else high = mid - 1;
  }
  return { value: text.slice(0, low), truncated: true };
}

/**
 * tmux intercepts a raw OSC 52 sequence written by a program running inside one of its panes
 * instead of forwarding it to the real terminal, so `/copy` would otherwise silently do nothing
 * for the (very common) case of AlfaCode running inside a tmux session. Wrapping the sequence in
 * tmux's DCS passthrough envelope — `ESC P tmux ; <payload, with every ESC byte doubled> ESC \` —
 * tells tmux to hand it straight through to the outer terminal instead. This is the same wrapping
 * used by widely-deployed OSC-52-over-tmux tools (e.g. the oscyank family of editor plugins). A
 * no-op (never called) outside tmux.
 */
export function wrapForTmuxPassthrough(sequence: string): string {
  const doubled = sequence.replace(/\x1b/gu, "\x1b\x1b");
  return `\x1bPtmux;${doubled}\x1b\\`;
}

export interface ClipboardWriteDeps {
  readonly write: (chunk: string) => void;
  readonly insideTmux: () => boolean;
}

const REAL_DEPS: ClipboardWriteDeps = {
  write: (chunk) => { process.stdout.write(chunk); },
  insideTmux: () => process.env.TMUX !== undefined,
};

/** Builds a clipboard writer bound to `deps`, fully unit-testable without touching a real terminal or tmux. */
export function createClipboardWriter(deps: ClipboardWriteDeps = REAL_DEPS): (text: string) => Osc52Copy {
  return (text) => {
    const copy = encodeOsc52Copy(text);
    deps.write(deps.insideTmux() ? wrapForTmuxPassthrough(copy.sequence) : copy.sequence);
    return copy;
  };
}

/** The real, stdout-backed writer chat-tui.tsx's `/copy` command uses. */
export const writeClipboardText: (text: string) => Osc52Copy = createClipboardWriter();
