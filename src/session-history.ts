import { homedir } from "node:os";
import { join } from "node:path";
import {
  getSessionInfo as sdkGetSessionInfo,
  listSessions as sdkListSessions,
  renameSession as sdkRenameSession,
  type ListSessionsOptions,
  type SDKSessionInfo,
  type SessionMutationOptions,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * AlfaCode's isolated Claude Code state directory. Matches the default computed in
 * agent-session.ts (`AgentSession`'s constructor) and claude-launcher.ts's `buildClaudeEnvironment`
 * so session lookups here resolve to the exact same on-disk sessions the engine reads/writes.
 */
export function defaultSessionsConfigDir(): string {
  return join(homedir(), ".alfacode", "claude");
}

/**
 * Runs `fn` with `CLAUDE_CONFIG_DIR` pointed at `configDir`, restoring the previous value
 * afterwards. The SDK's local-filesystem session helpers (`listSessions`, `getSessionInfo`,
 * `renameSession`) read this directory straight from `process.env` of the process that calls
 * them -- unlike the spawned engine subprocess, whose environment AgentSession already builds
 * explicitly (see claude-launcher.ts). Calling those helpers from AlfaCode's own host process
 * would otherwise silently read a bare `claude` install's `~/.claude` instead of AlfaCode's
 * isolated state, so every call in this module is scoped through this helper.
 */
export async function withSessionsConfigDir<T>(configDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}

/** Thin seam over the SDK's session-listing/renaming functions so callers can inject a fake in tests. */
export interface SessionsBackend {
  listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
  getSessionInfo(sessionId: string, options?: { readonly dir?: string }): Promise<SDKSessionInfo | undefined>;
  renameSession(sessionId: string, title: string, options?: SessionMutationOptions): Promise<void>;
}

/** The real, SDK-backed sessions source, scoped to AlfaCode's isolated Claude Code state directory. */
export function createSessionsBackend(configDir: string = defaultSessionsConfigDir()): SessionsBackend {
  return {
    listSessions: (options) => withSessionsConfigDir(configDir, () => sdkListSessions(options)),
    getSessionInfo: (sessionId, options) => withSessionsConfigDir(configDir, () => sdkGetSessionInfo(sessionId, options)),
    renameSession: (sessionId, title, options) => withSessionsConfigDir(configDir, () => sdkRenameSession(sessionId, title, options)),
  };
}

/** A resumable session, shaped for a picker: name/summary plus time-since-activity. */
export interface SessionPickerEntry {
  readonly sessionId: string;
  readonly title: string;
  readonly lastModified: number;
  readonly createdAt?: number;
  readonly cwd?: string;
  readonly gitBranch?: string;
}

function toPickerEntry(info: SDKSessionInfo): SessionPickerEntry {
  const summary = info.summary.trim();
  const title = info.customTitle?.trim() || (summary.length > 0 ? summary : "Untitled session");
  return {
    sessionId: info.sessionId,
    title,
    lastModified: info.lastModified,
    ...(info.createdAt === undefined ? {} : { createdAt: info.createdAt }),
    ...(info.cwd === undefined ? {} : { cwd: info.cwd }),
    ...(info.gitBranch === undefined ? {} : { gitBranch: info.gitBranch }),
  };
}

export interface ListRecentSessionsOptions {
  readonly cwd: string;
  readonly configDir?: string;
  readonly limit?: number;
  readonly backend?: SessionsBackend;
}

/** Recent, human-resumable sessions for `cwd` (and its git worktrees), most recently active first. */
export async function listRecentSessions(options: ListRecentSessionsOptions): Promise<readonly SessionPickerEntry[]> {
  const backend = options.backend ?? createSessionsBackend(options.configDir ?? defaultSessionsConfigDir());
  const infos = await backend.listSessions({
    dir: options.cwd,
    includeProgrammatic: false,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  return infos.map(toPickerEntry).sort((left, right) => right.lastModified - left.lastModified);
}

export type ResumeResolution =
  | { readonly kind: "id"; readonly sessionId: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly SessionPickerEntry[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether `value` already looks like a session id (a UUID), rather than a name to search for. */
export function looksLikeSessionId(value: string): boolean {
  return uuidPattern.test(value.trim());
}

export interface ResolveResumeTargetOptions {
  readonly query?: string;
  readonly cwd: string;
  readonly configDir?: string;
  readonly limit?: number;
  readonly backend?: SessionsBackend;
}

/**
 * Resolves a `--resume [name|id]` request to a concrete session id.
 *
 * A bare UUID is trusted as-is (mirroring `claude --resume <uuid>`, which does not pre-verify
 * the id either -- the engine reports a clear error itself if it doesn't exist). Anything else
 * -- a name, or no query at all -- is resolved by name/first-prompt match against this
 * directory's recent sessions; zero or multiple matches come back as `not-found`/`ambiguous` so
 * the caller can prompt.
 */
export async function resolveResumeTarget(options: ResolveResumeTargetOptions): Promise<ResumeResolution> {
  const trimmed = options.query?.trim();
  if (trimmed !== undefined && trimmed.length > 0 && looksLikeSessionId(trimmed)) return { kind: "id", sessionId: trimmed };
  const listOptions: ListRecentSessionsOptions = {
    cwd: options.cwd,
    limit: options.limit ?? 20,
    ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
    ...(options.backend === undefined ? {} : { backend: options.backend }),
  };
  const candidates = await listRecentSessions(listOptions);
  if (trimmed === undefined || trimmed.length === 0) {
    if (candidates.length === 0) return { kind: "not-found" };
    if (candidates.length === 1) return { kind: "id", sessionId: candidates[0]!.sessionId };
    return { kind: "ambiguous", candidates };
  }
  const needle = trimmed.toLowerCase();
  const matches = candidates.filter((entry) => entry.title.toLowerCase().includes(needle));
  if (matches.length === 0) return { kind: "not-found" };
  if (matches.length === 1) return { kind: "id", sessionId: matches[0]!.sessionId };
  return { kind: "ambiguous", candidates: matches };
}

export interface RenameAlfaCodeSessionOptions {
  readonly cwd?: string;
  readonly configDir?: string;
  readonly backend?: SessionsBackend;
}

/** Names a session (Claude Code's own `/rename`), so a picker can show it instead of a raw summary. */
export async function renameAlfaCodeSession(sessionId: string, title: string, options: RenameAlfaCodeSessionOptions = {}): Promise<void> {
  const backend = options.backend ?? createSessionsBackend(options.configDir ?? defaultSessionsConfigDir());
  await backend.renameSession(sessionId, title, options.cwd === undefined ? {} : { dir: options.cwd });
}

/** A short, human "time since" label -- "3m ago", "2h ago", "5d ago" -- for a picker row. */
export function formatRelativeTime(atMs: number, nowMs: number = Date.now()): string {
  const diffSeconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (diffSeconds < 45) return "just now";
  const minutes = Math.round(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(months / 12);
  return `${years}y ago`;
}

/** One-line picker label: name/summary, time-since-activity, and the git branch when known. */
export function describeSessionPickerEntry(entry: SessionPickerEntry, nowMs: number = Date.now()): string {
  const branch = entry.gitBranch === undefined ? "" : ` · ${entry.gitBranch}`;
  return `${entry.title} — ${formatRelativeTime(entry.lastModified, nowMs)}${branch}`;
}
