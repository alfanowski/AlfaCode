import { spawn } from "node:child_process";

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

// ---------------------------------------------------------------------------
// System clipboard: a local-macOS `pbcopy` primary path, OSC 52 as the fallback.
// ---------------------------------------------------------------------------

/**
 * `pbcopy` writes straight to the local macOS system clipboard via a well-known CLI, with no
 * terminal-emulator round trip and no size cap the way OSC 52 has (`MAX_CLIPBOARD_TEXT_BYTES`
 * above) — strictly more reliable than an escape sequence for the common case this backs: a mouse
 * drag-select completing on the user's own Mac. It only ever helps locally, though: over SSH,
 * `pbcopy` would write to the *remote* host's clipboard (usually nonexistent, and never the one the
 * user is looking at), so OSC 52 — which rides the same stream as everything else AlfaCode prints
 * back to the real terminal — remains the only path that can reach the user in that case. This is
 * why mouse-select copy tries `pbcopy` first, on local macOS only, and falls back to the existing
 * OSC 52 writer above (reused, not duplicated) everywhere else, including when `pbcopy` itself
 * fails for any reason.
 */

export type PbcopyRunner = (text: string) => Promise<boolean>;

/** Spawns the real `pbcopy` (array-form, no shell) and pipes `text` to its stdin. Resolves `true`
 * only on a clean (exit code 0) close; never throws — a missing binary, a spawn error, or a
 * non-zero exit all just mean "this path didn't work," so callers fall back to OSC 52. */
export const runPbcopy: PbcopyRunner = (text) => new Promise((resolve) => {
  try {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    let settled = false;
    const settle = (ok: boolean): void => { if (!settled) { settled = true; resolve(ok); } };
    child.once("error", () => settle(false));
    child.once("close", (code) => settle(code === 0));
    child.stdin.end(text, "utf8");
  } catch {
    resolve(false);
  }
});

/** True inside an SSH session, per the standard `SSH_TTY`/`SSH_CONNECTION` env vars OpenSSH sets on the remote side. */
export function isLikelySshSession(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.SSH_TTY !== undefined || environment.SSH_CONNECTION !== undefined;
}

/** Whether the `pbcopy` primary path applies: local (non-SSH) macOS only — see the section doc above. */
export function shouldUsePbcopy(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env): boolean {
  return platform === "darwin" && !isLikelySshSession(environment);
}

export interface SystemClipboardWriteDeps {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly runPbcopy: PbcopyRunner;
  readonly writeOsc52: (text: string) => Osc52Copy;
}

const REAL_SYSTEM_CLIPBOARD_DEPS: SystemClipboardWriteDeps = {
  platform: process.platform,
  environment: process.env,
  runPbcopy,
  writeOsc52: writeClipboardText,
};

export interface SystemClipboardWriteResult {
  readonly method: "pbcopy" | "osc52";
  /** Only ever true for the `osc52` method — see `MAX_CLIPBOARD_TEXT_BYTES`; `pbcopy` has no such limit. */
  readonly truncated: boolean;
}

/**
 * Builds the writer mouse-select copy-on-release uses, bound to `deps` — fully unit-testable
 * without spawning a real `pbcopy` or touching a real terminal. Tries `pbcopy` first when
 * `shouldUsePbcopy` says so; falls back to the existing OSC 52 writer (reused, not duplicated)
 * whenever that's not the case, or when `pbcopy` itself fails.
 */
export function createSystemClipboardWriter(deps: SystemClipboardWriteDeps = REAL_SYSTEM_CLIPBOARD_DEPS): (text: string) => Promise<SystemClipboardWriteResult> {
  return async (text) => {
    if (shouldUsePbcopy(deps.platform, deps.environment) && await deps.runPbcopy(text)) {
      return { method: "pbcopy", truncated: false };
    }
    const { truncated } = deps.writeOsc52(text);
    return { method: "osc52", truncated };
  };
}

/** The real writer mouse-select copy-on-release uses. */
export const writeSystemClipboardText: (text: string) => Promise<SystemClipboardWriteResult> = createSystemClipboardWriter();
