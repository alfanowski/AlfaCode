import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderModel, UsageSnapshot } from "./provider-contract.js";

export type AttemptOutcome = "completed" | "partial" | "failed" | "cancelled";

export interface UsageAttemptInput {
  readonly session: string;
  readonly agent: string;
  readonly parentAgent?: string;
  readonly providerId: string;
  readonly routeModelId: string;
  readonly upstreamModel: string;
  readonly model: ProviderModel;
  readonly requestedOutputTokens?: number;
  readonly extendedContext: boolean;
}

export interface UsageAttempt {
  readonly id: string;
}

export interface UsageAttemptRecord {
  readonly id: string;
  readonly sessionKey: string;
  readonly agentKey: string;
  readonly parentAgentKey?: string;
  readonly providerId: string;
  readonly routeModelId: string;
  readonly upstreamModel: string;
  readonly contextWindowTokens?: number;
  readonly requestedOutputTokens?: number;
  readonly extendedContext: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly toolTokens?: number;
  readonly totalTokens?: number;
  readonly usageCompleteness: "unknown" | "interim" | "final";
  readonly outcome: AttemptOutcome;
  readonly responseStarted: boolean;
  readonly errorClass?: string;
}

export interface UsageQuery {
  readonly session?: string;
  readonly providerId?: string;
  readonly routeModelId?: string;
  readonly limit?: number;
}

export interface UsageSummary {
  readonly attempts: readonly UsageAttemptRecord[];
  readonly totals: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens: number;
    readonly toolTokens: number;
    readonly totalTokens: number;
  };
}

/** Aggregate only content-free, recorded usage within a rolling time window. */
export interface RollingUsageQuery {
  readonly since: number;
  readonly providerId?: string;
  readonly upstreamModel?: string;
}

export interface RollingUsage {
  readonly attempts: number;
  readonly completedAttempts: number;
  readonly failedAttempts: number;
  /** Undefined means the providers did not report a total for any matching attempt. */
  readonly totalTokens?: number;
}

/** Local-only, content-free token accounting suitable for a UI. */
export class UsageLedger {
  private constructor(
    private readonly database: DatabaseSync,
    private readonly secret: Buffer,
  ) {}

  static async open(directory: string): Promise<UsageLedger> {
    await ensurePrivateDirectory(directory);
    const secret = await loadOrCreateSecret(join(directory, "ledger.key"));
    const databasePath = join(directory, "usage.sqlite");
    let database: DatabaseSync;
    try {
      database = openDatabase(databasePath);
    } catch {
      await recoverDatabase(databasePath);
      database = openDatabase(databasePath);
    }
    await chmod(databasePath, 0o600);
    return new UsageLedger(database, secret);
  }

  async registerModel(providerId: string, routeModelId: string, model: ProviderModel): Promise<void> {
    this.database.prepare(`
      INSERT INTO model_catalog (route_model_id, provider_id, upstream_model, context_window_tokens, max_input_tokens, max_output_tokens, context_includes_output, token_counting, usage_reporting, discovered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(route_model_id) DO UPDATE SET
        provider_id=excluded.provider_id, upstream_model=excluded.upstream_model,
        context_window_tokens=excluded.context_window_tokens, max_input_tokens=excluded.max_input_tokens,
        max_output_tokens=excluded.max_output_tokens, context_includes_output=excluded.context_includes_output,
        token_counting=excluded.token_counting, usage_reporting=excluded.usage_reporting, discovered_at=excluded.discovered_at
    `).run(
      routeModelId,
      providerId,
      model.id,
      model.limits?.contextWindowTokens ?? null,
      model.limits?.maxInputTokens ?? null,
      model.limits?.maxOutputTokens ?? null,
      model.limits?.contextIncludesOutput === true ? 1 : 0,
      model.capabilities?.tokenCounting ?? "none",
      model.capabilities?.usageReporting ?? "none",
      Date.now(),
    );
  }

  async start(input: UsageAttemptInput): Promise<UsageAttempt> {
    const id = randomUUID();
    const sessionKey = this.pseudonym(input.session);
    const agentKey = this.pseudonym(input.agent);
    const parentAgentKey = input.parentAgent === undefined ? null : this.pseudonym(input.parentAgent);
    const now = Date.now();
    this.database.prepare(`
      INSERT INTO attempts (id, started_at, session_key, agent_key, parent_agent_key, provider_id, route_model_id, upstream_model, context_window_tokens, requested_output_tokens, extended_context, usage_completeness, outcome, response_started)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 'partial', 0)
    `).run(
      id, now, sessionKey, agentKey, parentAgentKey, input.providerId, input.routeModelId, input.upstreamModel,
      input.model.limits?.contextWindowTokens ?? null, input.requestedOutputTokens ?? null, input.extendedContext ? 1 : 0,
    );
    return { id };
  }

  async observe(attempt: UsageAttempt, snapshot: UsageSnapshot): Promise<void> {
    const existing = this.database.prepare("SELECT snapshot_json FROM usage_observations WHERE attempt_id = ? ORDER BY observed_at DESC LIMIT 1").get(attempt.id) as { snapshot_json?: string } | undefined;
    const previous = existing?.snapshot_json === undefined ? undefined : JSON.parse(existing.snapshot_json) as UsageSnapshot;
    const merged = mergeUsage(previous, snapshot);
    const now = Date.now();
    this.database.prepare("INSERT INTO usage_observations (attempt_id, observed_at, stage, snapshot_json) VALUES (?, ?, ?, ?)").run(attempt.id, now, merged.stage, JSON.stringify(merged));
    this.database.prepare(`
      UPDATE attempts SET input_tokens=?, output_tokens=?, cached_input_tokens=?, cache_write_tokens=?, reasoning_tokens=?, tool_tokens=?, total_tokens=?, usage_completeness=? WHERE id=?
    `).run(
      merged.inputTokens ?? null, merged.outputTokens ?? null, merged.cachedInputTokens ?? null,
      merged.cacheWriteTokens ?? null, merged.reasoningTokens ?? null, merged.toolTokens ?? null,
      merged.totalTokens ?? null, merged.stage === "final" ? "final" : "interim", attempt.id,
    );
  }

  async finish(attempt: UsageAttempt, outcome: AttemptOutcome, responseStarted: boolean, errorClass?: string): Promise<void> {
    this.database.prepare("UPDATE attempts SET finished_at=?, outcome=?, response_started=?, error_class=? WHERE id=?").run(
      Date.now(), outcome, responseStarted ? 1 : 0, errorClass ?? null, attempt.id,
    );
  }

  async query(query: UsageQuery = {}): Promise<UsageSummary> {
    const values: Array<string | number> = [];
    const where: string[] = [];
    if (query.session !== undefined) {
      where.push("session_key = ?");
      values.push(this.pseudonym(query.session));
    }
    if (query.providerId !== undefined) { where.push("provider_id = ?"); values.push(query.providerId); }
    if (query.routeModelId !== undefined) { where.push("route_model_id = ?"); values.push(query.routeModelId); }
    const limit = Math.max(1, Math.min(query.limit ?? 100, 1_000));
    values.push(limit);
    const rows = this.database.prepare(`SELECT * FROM attempts ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`} ORDER BY started_at DESC LIMIT ?`).all(...values) as Array<Record<string, unknown>>;
    const attempts = rows.map(toAttemptRecord);
    return {
      attempts,
      totals: attempts.reduce((total, attempt) => ({
        inputTokens: total.inputTokens + (attempt.inputTokens ?? 0),
        outputTokens: total.outputTokens + (attempt.outputTokens ?? 0),
        cachedInputTokens: total.cachedInputTokens + (attempt.cachedInputTokens ?? 0),
        cacheWriteTokens: total.cacheWriteTokens + (attempt.cacheWriteTokens ?? 0),
        reasoningTokens: total.reasoningTokens + (attempt.reasoningTokens ?? 0),
        toolTokens: total.toolTokens + (attempt.toolTokens ?? 0),
        totalTokens: total.totalTokens + (attempt.totalTokens ?? 0),
      }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, toolTokens: 0, totalTokens: 0 }),
    };
  }

  async rollingUsage(query: RollingUsageQuery): Promise<RollingUsage> {
    const values: Array<string | number> = [query.since];
    const where = ["started_at >= ?"];
    if (query.providerId !== undefined) { where.push("provider_id = ?"); values.push(query.providerId); }
    if (query.upstreamModel !== undefined) { where.push("upstream_model = ?"); values.push(query.upstreamModel); }
    const row = this.database.prepare(`
      SELECT COUNT(*) AS attempts,
        SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed_attempts,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed_attempts,
        SUM(total_tokens) AS total_tokens, COUNT(total_tokens) AS reported_totals
      FROM attempts WHERE ${where.join(" AND ")}
    `).get(...values) as { attempts?: number; completed_attempts?: number; failed_attempts?: number; total_tokens?: number; reported_totals?: number };
    return {
      attempts: row.attempts ?? 0,
      completedAttempts: row.completed_attempts ?? 0,
      failedAttempts: row.failed_attempts ?? 0,
      ...(row.reported_totals === undefined || row.reported_totals === 0 || row.total_tokens === undefined ? {} : { totalTokens: row.total_tokens }),
    };
  }

  async close(): Promise<void> { this.database.close(); }

  private pseudonym(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }
}

function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  const check = database.prepare("PRAGMA quick_check").get() as { quick_check?: string };
  if (check.quick_check !== "ok") {
    database.close();
    throw new Error("Usage ledger integrity check failed");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS model_catalog (
      route_model_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, upstream_model TEXT NOT NULL,
      context_window_tokens INTEGER, max_input_tokens INTEGER, max_output_tokens INTEGER,
      context_includes_output INTEGER NOT NULL, token_counting TEXT NOT NULL, usage_reporting TEXT NOT NULL, discovered_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER,
      session_key TEXT NOT NULL, agent_key TEXT NOT NULL, parent_agent_key TEXT,
      provider_id TEXT NOT NULL, route_model_id TEXT NOT NULL, upstream_model TEXT NOT NULL,
      context_window_tokens INTEGER, requested_output_tokens INTEGER, extended_context INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, tool_tokens INTEGER, total_tokens INTEGER,
      usage_completeness TEXT NOT NULL, outcome TEXT NOT NULL, response_started INTEGER NOT NULL, error_class TEXT
    );
    CREATE TABLE IF NOT EXISTS usage_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL, observed_at INTEGER NOT NULL, stage TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      FOREIGN KEY (attempt_id) REFERENCES attempts(id)
    );
    CREATE INDEX IF NOT EXISTS attempts_session_started ON attempts(session_key, started_at DESC);
  `);
  const columns = database.prepare("PRAGMA table_info(attempts)").all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === "extended_context")) {
    database.exec("ALTER TABLE attempts ADD COLUMN extended_context INTEGER NOT NULL DEFAULT 0");
  }
  return database;
}

function mergeUsage(previous: UsageSnapshot | undefined, next: UsageSnapshot): UsageSnapshot {
  const inputTokens = next.inputTokens ?? previous?.inputTokens;
  const outputTokens = next.outputTokens ?? previous?.outputTokens;
  const cachedInputTokens = next.cachedInputTokens ?? previous?.cachedInputTokens;
  const cacheWriteTokens = next.cacheWriteTokens ?? previous?.cacheWriteTokens;
  const reasoningTokens = next.reasoningTokens ?? previous?.reasoningTokens;
  const toolTokens = next.toolTokens ?? previous?.toolTokens;
  const totalTokens = next.totalTokens ?? previous?.totalTokens;
  return {
    semantics: "cumulative",
    stage: previous?.stage === "final" || next.stage === "final" ? "final" : "interim",
    source: next.source,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(toolTokens === undefined ? {} : { toolTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function toAttemptRecord(row: Record<string, unknown>): UsageAttemptRecord {
  const numberOrUndefined = (value: unknown) => typeof value === "number" ? value : undefined;
  const stringOrUndefined = (value: unknown) => typeof value === "string" ? value : undefined;
  const parentAgentKey = stringOrUndefined(row.parent_agent_key);
  const contextWindowTokens = numberOrUndefined(row.context_window_tokens);
  const requestedOutputTokens = numberOrUndefined(row.requested_output_tokens);
  const extendedContext = row.extended_context === 1;
  const inputTokens = numberOrUndefined(row.input_tokens);
  const outputTokens = numberOrUndefined(row.output_tokens);
  const cachedInputTokens = numberOrUndefined(row.cached_input_tokens);
  const cacheWriteTokens = numberOrUndefined(row.cache_write_tokens);
  const reasoningTokens = numberOrUndefined(row.reasoning_tokens);
  const toolTokens = numberOrUndefined(row.tool_tokens);
  const totalTokens = numberOrUndefined(row.total_tokens);
  const errorClass = stringOrUndefined(row.error_class);
  return {
    id: String(row.id), sessionKey: String(row.session_key), agentKey: String(row.agent_key),
    ...(parentAgentKey === undefined ? {} : { parentAgentKey }),
    providerId: String(row.provider_id), routeModelId: String(row.route_model_id), upstreamModel: String(row.upstream_model),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(requestedOutputTokens === undefined ? {} : { requestedOutputTokens }),
    extendedContext,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(toolTokens === undefined ? {} : { toolTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    usageCompleteness: String(row.usage_completeness) as UsageAttemptRecord["usageCompleteness"],
    outcome: String(row.outcome) as AttemptOutcome, responseStarted: row.response_started === 1,
    ...(errorClass === undefined ? {} : { errorClass }),
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("Usage ledger directory must be a private non-symlink directory");
  }
}

async function loadOrCreateSecret(path: string): Promise<Buffer> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("Usage ledger secret is unsafe");
    return Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
  } catch (error: unknown) {
    if (!(typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    const value = randomBytes(32).toString("base64url");
    try {
      await writeFile(path, `${value}\n`, { mode: 0o600, flag: "wx" });
      return Buffer.from(value, "base64url");
    } catch (writeError: unknown) {
      if (!(typeof writeError === "object" && writeError !== null && "code" in writeError && (writeError as NodeJS.ErrnoException).code === "EEXIST")) throw writeError;
      return loadOrCreateSecret(path);
    }
  }
}

async function recoverDatabase(path: string): Promise<void> {
  const suffix = `.corrupt-${Date.now()}`;
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map(async (candidate) => {
    try {
      await rename(candidate, `${candidate}${suffix}`);
    } catch (error: unknown) {
      if (!(typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
  }));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}
