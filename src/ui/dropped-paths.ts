/**
 * Detects a dropped file/image path arriving in the paste handler.
 *
 * Most terminals implement drag-and-drop by pasting the dropped item's absolute path (sometimes
 * one per line for a multi-file drop) instead of any richer protocol — indistinguishable, at the
 * paste-handler level, from someone pasting an absolute path on purpose. `detectDroppedPaths` is
 * the pure, synchronous half: it recognizes the *shape* (one or more absolute, unspaced-or-quoted
 * paths and nothing else) without touching the filesystem, so it's cheap to unit test. The caller
 * is expected to additionally verify existence (via `resolveDroppedPaths`, or its own `stat`) before
 * treating the paste as a real drop instead of literal text that merely looked like a path.
 */
import type { Stats } from "node:fs";

export interface DroppedPathCandidate {
  readonly raw: string;
  readonly absolutePath: string;
  readonly looksLikeImage: boolean;
}

export interface ResolvedDroppedPath extends DroppedPathCandidate {
  readonly isDirectory: boolean;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * Returns the drop candidates if `pastedText` looks like nothing but one or more dropped paths
 * (one per line), or `undefined` if it looks like ordinary pasted text.
 */
export function detectDroppedPaths(pastedText: string): readonly DroppedPathCandidate[] | undefined {
  if (pastedText.length <= 1) return undefined;
  const lines = pastedText.split(/\r\n|\r|\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;
  const candidates: DroppedPathCandidate[] = [];
  for (const line of lines) {
    const candidate = parseCandidate(line);
    if (candidate === undefined) return undefined;
    candidates.push(candidate);
  }
  return candidates;
}

function parseCandidate(line: string): DroppedPathCandidate | undefined {
  const { path, explainedWhitespace } = normalizePathLike(line);
  if (!isAbsolutePathLike(path)) return undefined;
  // A space that survives unquoting/unescaping/URI-decoding is a legitimate part of a filename
  // ("My File.png"). A *bare* space that was never explained by any of those is far more likely
  // to mean this line is prose or a shell command that merely starts with "/", not a dropped path.
  if (!explainedWhitespace && /\s/u.test(path)) return undefined;
  return { raw: line, absolutePath: path, looksLikeImage: IMAGE_EXTENSIONS.has(extensionOf(path)) };
}

function isAbsolutePathLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
}

function normalizePathLike(value: string): { readonly path: string; readonly explainedWhitespace: boolean } {
  let result = value;
  let explainedWhitespace = false;
  if (result.startsWith("file://")) {
    explainedWhitespace = true;
    try { result = decodeURIComponent(result.slice("file://".length)); } catch { /* leave undecoded on malformed escapes */ }
  }
  if (isQuotedPath(result)) { result = result.slice(1, -1); explainedWhitespace = true; }
  if (/\\ /u.test(result)) { result = result.replace(/\\ /gu, " "); explainedWhitespace = true; }
  return { path: result, explainedWhitespace };
}

function isQuotedPath(value: string): boolean {
  if (value.length < 2) return false;
  const first = value[0];
  const last = value.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'");
}

function extensionOf(path: string): string {
  const match = /\.[a-zA-Z0-9]+$/u.exec(path);
  return match === null ? "" : match[0].toLowerCase();
}

export type StatLike = (path: string) => Promise<Pick<Stats, "isDirectory">>;

/** Verifies each candidate actually exists on disk, dropping the ones that don't. */
export async function resolveDroppedPaths(candidates: readonly DroppedPathCandidate[], stat: StatLike): Promise<readonly ResolvedDroppedPath[]> {
  const resolved: ResolvedDroppedPath[] = [];
  for (const candidate of candidates) {
    try {
      const stats = await stat(candidate.absolutePath);
      resolved.push({ ...candidate, isDirectory: stats.isDirectory() });
    } catch {
      // not a real path on this filesystem — drop it silently, caller falls back to literal paste
    }
  }
  return resolved;
}
