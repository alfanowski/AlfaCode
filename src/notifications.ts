import { spawn } from "node:child_process";

/**
 * Turn-completion / permission-wait notifications.
 *
 * Neither Ink nor the Claude Agent SDK exposes whether the terminal window
 * currently has OS-level focus (Ink's `useFocus` is keyboard focus between
 * components inside the TUI, not window focus), so this module does not try
 * to sniff terminal-focus state itself. Instead it rings the standard
 * terminal bell (`\x07`) on every turn completion / permission wait, which
 * is the universally supported baseline: virtually every terminal emulator
 * on macOS (Terminal.app, iTerm2, Ghostty, …) already turns an unfocused
 * bell into a dock badge / banner notification when the user has that
 * terminal preference enabled, so the app only needs to ring the bell — the
 * terminal decides whether that is currently worth surfacing to the user.
 *
 * Desktop notifications (macOS `osascript -e 'display notification'`) are an
 * optional, best-effort addition on top of that: never awaited, errors are
 * swallowed, and a failure here must never affect the running session.
 */

export interface NotificationSettings {
  readonly bell: boolean;
  readonly desktop: boolean;
}

export interface NotifyTarget {
  write(chunk: string): unknown;
}

const truthyFlags = new Set(["1", "true", "yes", "on"]);
const falsyFlags = new Set(["0", "false", "no", "off"]);

/**
 * The terminal bell defaults to ON (matching Claude Code precedent and the
 * "universally supported baseline" framing) since it is inert unless the
 * user's terminal already opted into surfacing it. Desktop notifications
 * default to OFF since spawning a subprocess on every turn is a bigger
 * behavior change that a user should opt into explicitly.
 */
export function resolveNotificationSettings(environment: NodeJS.ProcessEnv = process.env): NotificationSettings {
  return {
    bell: parseFlag(environment.ALFACODE_NOTIFY_BELL, true),
    desktop: parseFlag(environment.ALFACODE_NOTIFY_DESKTOP, false),
  };
}

function parseFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (truthyFlags.has(normalized)) return true;
  if (falsyFlags.has(normalized)) return false;
  return fallback;
}

export function ringBell(target: NotifyTarget = process.stdout): void {
  target.write("");
}

export type SpawnLike = typeof spawn;

/**
 * Best-effort macOS desktop notification via `osascript`. Never throws, never
 * blocks: the child process is detached from the event loop (`unref`) and any
 * spawn/runtime error is swallowed so a missing `osascript` binary or a
 * sandboxed environment can never interrupt the session.
 */
export function notifyDesktop(title: string, body: string, platform: NodeJS.Platform = process.platform, run: SpawnLike = spawn): void {
  if (platform !== "darwin") return;
  try {
    const child = run("osascript", ["-e", buildDisplayNotificationScript(title, body)], { stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Best-effort only: a notification must never affect the session.
  }
}

function buildDisplayNotificationScript(title: string, body: string): string {
  return `display notification ${quoteAppleScriptString(body)} with title ${quoteAppleScriptString(title)}`;
}

function quoteAppleScriptString(value: string): string {
  const collapsed = value.replace(/[\r\n]+/gu, " ").slice(0, 200);
  return `"${collapsed.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

export interface NotifyTurnCompleteOptions {
  readonly settings: NotificationSettings;
  readonly title: string;
  readonly body: string;
  readonly target?: NotifyTarget;
  readonly platform?: NodeJS.Platform;
  readonly run?: SpawnLike;
}

export function notifyTurnComplete(options: NotifyTurnCompleteOptions): void {
  if (options.settings.bell) {
    try {
      ringBell(options.target);
    } catch {
      // Best-effort only: a notification must never affect the session.
    }
  }
  if (options.settings.desktop) notifyDesktop(options.title, options.body, options.platform, options.run);
}
