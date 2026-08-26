/**
 * `@`-file mention autocomplete for the composer.
 *
 * Mirrors the existing `/` slash-command palette on purpose: a pure "what's the active query"
 * function, a pure "filter + rank" function, and a pure "accept this entry" function, all decoupled
 * from Ink so chat-tui.tsx can wire them into the same navigate/tab/enter pattern the command
 * palette already uses instead of inventing a second popup interaction model. The only I/O is the
 * directory walk (`listMentionEntries`), kept separate so the filtering/ranking logic stays testable
 * with plain in-memory arrays.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface MentionEntry {
  /** POSIX-style path relative to the scanned root, no leading "./". */
  readonly relativePath: string;
  readonly isDirectory: boolean;
}

export interface MentionQuery {
  /** Index of the triggering "@" in the composer value. */
  readonly start: number;
  /** Index right after the query text (the cursor, while the token is still being typed). */
  readonly end: number;
  readonly query: string;
}

/**
 * Finds the `@token` containing the cursor, if any — the same "look left from the cursor for an
 * unterminated trigger" shape as a typical slash/mention popup. A token starts at the beginning of
 * the buffer or after whitespace, and ends at the cursor (so the popup only shows while actively
 * typing the mention, matching how the command palette behaves).
 */
export function activeMentionQuery(value: string, cursor: number): MentionQuery | undefined {
  const clampedCursor = Math.max(0, Math.min(value.length, cursor));
  const before = value.slice(0, clampedCursor);
  const at = before.lastIndexOf("@");
  if (at < 0) return undefined;
  if (at > 0 && !/\s/u.test(before[at - 1] ?? "\n")) return undefined;
  const token = before.slice(at + 1);
  if (/\s/u.test(token)) return undefined;
  return { start: at, end: clampedCursor, query: token };
}

export function filterMentionEntries(entries: readonly MentionEntry[], query: string, limit = 8): readonly MentionEntry[] {
  const needle = query.toLowerCase();
  const matches = needle.length === 0 ? [...entries] : entries.filter((entry) => entry.relativePath.toLowerCase().includes(needle));
  matches.sort((left, right) => {
    const byRank = mentionRank(left, needle) - mentionRank(right, needle);
    if (byRank !== 0) return byRank;
    const byLength = left.relativePath.length - right.relativePath.length;
    return byLength !== 0 ? byLength : left.relativePath.localeCompare(right.relativePath);
  });
  return matches.slice(0, limit);
}

function mentionRank(entry: MentionEntry, needle: string): number {
  if (needle.length === 0) return 0;
  const lower = entry.relativePath.toLowerCase();
  if (lower.startsWith(needle)) return 0;
  const base = lower.split("/").at(-1) ?? lower;
  if (base.startsWith(needle)) return 1;
  return 2;
}

/** Replaces the active `@query` token with `@entry/path ` and returns the new editor state. */
export function insertMention(value: string, query: MentionQuery, entry: MentionEntry): { readonly value: string; readonly cursor: number } {
  // Only add a separating space when one isn't already sitting right after the token (e.g. a
  // mention accepted in the middle of existing text) — otherwise the mention's own trailing space
  // would double up with it.
  const nextChar = value[query.end];
  const needsTrailingSpace = nextChar === undefined || !/\s/u.test(nextChar);
  const mention = `@${entry.relativePath}${entry.isDirectory ? "/" : ""}${needsTrailingSpace ? " " : ""}`;
  const nextValue = value.slice(0, query.start) + mention + value.slice(query.end);
  return { value: nextValue, cursor: query.start + mention.length };
}

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".cache", "coverage", ".venv"]);
const DEFAULT_MAX_ENTRIES = 4_000;
const DEFAULT_MAX_DEPTH = 8;

export interface ListMentionEntriesOptions {
  readonly maxEntries?: number;
  readonly maxDepth?: number;
}

/** Bounded recursive walk of `root` for the mention popup. Missing/unreadable directories are skipped rather than failing the whole listing. */
export async function listMentionEntries(root: string, options: ListMentionEntriesOptions = {}): Promise<readonly MentionEntry[]> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const results: MentionEntry[] = [];

  async function walk(absoluteDir: string, relativeDir: string, depth: number): Promise<void> {
    if (results.length >= maxEntries || depth > maxDepth) return;
    let children: Dirent[];
    try {
      children = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (results.length >= maxEntries) return;
      const relativePath = relativeDir === "" ? child.name : `${relativeDir}/${child.name}`;
      if (child.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(child.name)) continue;
        results.push({ relativePath, isDirectory: true });
        await walk(join(absoluteDir, child.name), relativePath, depth + 1);
        continue;
      }
      if (child.isFile()) results.push({ relativePath, isDirectory: false });
    }
  }

  await walk(root, "", 0);
  return results;
}
