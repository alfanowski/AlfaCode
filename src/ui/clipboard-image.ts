/**
 * Best-effort system-clipboard image reader for the composer's image-paste shortcut.
 *
 * Terminals don't deliver clipboard *image* bytes through stdin the way they deliver pasted text
 * (bracketed paste only ever carries text) — Ctrl+V/Cmd+V, when Ink even sees the keystroke, has to
 * be treated as a trigger to go ask the operating system's clipboard directly. That's inherently
 * platform-specific shell-out territory, so this module keeps the platform dispatch isolated behind
 * an injectable `ClipboardImageDeps` seam: `createClipboardImageReader` is fully unit-testable without
 * touching a real clipboard, and `readClipboardImage` is the real, default-wired singleton chat-tui.tsx
 * uses. Every path is wrapped so failure (missing tool, empty clipboard, timeout) resolves to
 * `undefined` rather than throwing — a composer shortcut should never crash the TUI.
 */
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile as readFileAsync, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ClipboardImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ClipboardImage {
  readonly mediaType: ClipboardImageMediaType;
  readonly base64: string;
}

/** Maps a file extension to an Anthropic-supported image media type, or `undefined` for anything else. Used to attach a dropped image file (see dropped-paths.ts) the same way a clipboard paste is attached. */
export function mediaTypeForExtension(path: string): ClipboardImageMediaType | undefined {
  const extension = /\.([a-zA-Z0-9]+)$/u.exec(path)?.[1]?.toLowerCase();
  switch (extension) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    default: return undefined;
  }
}

export interface ClipboardImageDeps {
  readonly platform: () => NodeJS.Platform;
  readonly execFile: (command: string, args: readonly string[], timeoutMs: number) => Promise<Buffer>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly cleanup: (path: string) => Promise<void>;
  readonly tempFile: (extension: string) => string;
}

const TIMEOUT_MS = 4_000;

const REAL_DEPS: ClipboardImageDeps = {
  platform: () => process.platform,
  execFile: (command, args, timeoutMs) => new Promise((resolve, reject) => {
    execFileCallback(command, [...args], { encoding: "buffer", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return; }
      resolve(stdout);
    });
  }),
  readFile: (path) => readFileAsync(path),
  cleanup: async (path) => { try { await unlink(path); } catch { /* best effort cleanup */ } },
  tempFile: (extension) => join(tmpdir(), `alfacode-clip-${randomUUID()}.${extension}`),
};

export function createClipboardImageReader(deps: ClipboardImageDeps = REAL_DEPS): () => Promise<ClipboardImage | undefined> {
  return async () => {
    try {
      const platform = deps.platform();
      if (platform === "darwin") return await readMacClipboardImage(deps);
      if (platform === "linux") return await readLinuxClipboardImage(deps);
      if (platform === "win32") return await readWindowsClipboardImage(deps);
      return undefined;
    } catch {
      return undefined;
    }
  };
}

/** The default, real-OS-backed reader. chat-tui.tsx wires the Ctrl+V/Cmd+V shortcut to this. */
export const readClipboardImage: () => Promise<ClipboardImage | undefined> = createClipboardImageReader();

// ---------------------------------------------------------------------------
// macOS — osascript writes the raw clipboard data straight to a temp file so no binary data ever
// has to survive a round trip through a text-decoded pipe.
// ---------------------------------------------------------------------------

async function readMacClipboardImage(deps: ClipboardImageDeps): Promise<ClipboardImage | undefined> {
  const pngPath = await writeMacClipboardClass(deps, "PNGf", "png");
  if (pngPath !== undefined) {
    try {
      const bytes = await deps.readFile(pngPath);
      return { mediaType: "image/png", base64: bytes.toString("base64") };
    } finally {
      await deps.cleanup(pngPath);
    }
  }

  const tiffPath = await writeMacClipboardClass(deps, "TIFF", "tiff");
  if (tiffPath === undefined) return undefined;
  const convertedPath = deps.tempFile("png");
  try {
    await deps.execFile("sips", ["-s", "format", "png", tiffPath, "--out", convertedPath], TIMEOUT_MS);
    const bytes = await deps.readFile(convertedPath);
    return { mediaType: "image/png", base64: bytes.toString("base64") };
  } finally {
    await deps.cleanup(tiffPath);
    await deps.cleanup(convertedPath);
  }
}

async function writeMacClipboardClass(deps: ClipboardImageDeps, appleScriptClass: string, extension: string): Promise<string | undefined> {
  const path = deps.tempFile(extension);
  const script = [
    `set thePath to "${escapeForScript(path)}"`,
    "try",
    `  set theData to the clipboard as «class ${appleScriptClass}»`,
    "on error",
    '  return "NONE"',
    "end try",
    "set theFile to open for access thePath with write permission",
    "set eof theFile to 0",
    "write theData to theFile",
    "close access theFile",
    'return "OK"',
  ];
  const args = script.flatMap((line) => ["-e", line]);
  const stdout = await deps.execFile("osascript", args, TIMEOUT_MS);
  return stdout.toString("utf8").trim() === "OK" ? path : undefined;
}

// ---------------------------------------------------------------------------
// Linux — wl-paste (Wayland) / xclip (X11) can both emit a specific MIME type's raw bytes directly
// to stdout, so no temp files are needed here.
// ---------------------------------------------------------------------------

const LINUX_COMMANDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["wl-paste", ["--type", "image/png", "--no-newline"]],
  ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
];

async function readLinuxClipboardImage(deps: ClipboardImageDeps): Promise<ClipboardImage | undefined> {
  for (const [command, args] of LINUX_COMMANDS) {
    try {
      const bytes = await deps.execFile(command, args, TIMEOUT_MS);
      if (bytes.length > 0) return { mediaType: "image/png", base64: bytes.toString("base64") };
    } catch {
      // try the next tool
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Windows — PowerShell + WinForms clipboard API, saved to a temp file (mirrors the macOS approach).
// ---------------------------------------------------------------------------

async function readWindowsClipboardImage(deps: ClipboardImageDeps): Promise<ClipboardImage | undefined> {
  const path = deps.tempFile("png");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "if ([System.Windows.Forms.Clipboard]::ContainsImage()) {",
    "  $image = [System.Windows.Forms.Clipboard]::GetImage()",
    `  $image.Save('${escapeForScript(path)}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "  Write-Output 'OK'",
    "} else {",
    "  Write-Output 'NONE'",
    "}",
  ].join("\n");
  try {
    const stdout = await deps.execFile("powershell", ["-NoProfile", "-STA", "-Command", script], TIMEOUT_MS);
    if (stdout.toString("utf8").trim() !== "OK") return undefined;
    const bytes = await deps.readFile(path);
    return { mediaType: "image/png", base64: bytes.toString("base64") };
  } catch {
    return undefined;
  } finally {
    await deps.cleanup(path);
  }
}

function escapeForScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
