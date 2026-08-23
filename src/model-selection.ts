import type { ModelDescriptor } from "./providers/foundation/types.js";
import type { UsageLedger } from "./usage-ledger.js";
import {
  type ModelSelectionHealth,
  type ModelSelectionState,
  type ModelSelectionStateStore,
  MemoryModelSelectionStateStore,
} from "./model-selection-state.js";

export interface ModelRequirements {
  readonly streaming?: boolean;
  readonly tools?: boolean;
  readonly parallelTools?: boolean;
  readonly forcedToolChoice?: boolean;
  readonly vision?: boolean;
  readonly nativeTokenCounting?: boolean;
  readonly reasoningState?: "optional" | "required";
  readonly minimumJsonSchema?: "none" | "subset" | "full";
  readonly contractTested?: boolean;
}

export interface AvailabilityProbeResult {
  readonly status: "available" | "unavailable" | "unknown";
  readonly checkedAt?: number;
  readonly expiresAt?: number;
}

/** A non-billable, provider-owned readiness check. */
export interface AvailabilityProbe {
  probe(model: ModelDescriptor, signal: AbortSignal): Promise<AvailabilityProbeResult>;
}

export type QuotaSnapshot =
  | {
    readonly known: true;
    readonly checkedAt?: number;
    readonly expiresAt?: number;
    /** Provider-reported normalized remaining capacity in the [0, 1] range. */
    readonly headroom?: number;
    readonly remainingRequests?: number;
    readonly remainingTokens?: number;
  }
  | { readonly known: false; readonly checkedAt?: number; readonly expiresAt?: number };

/** Optional provider view of a model's currently remaining allowance. */
export interface QuotaReporter {
  getQuota(model: ModelDescriptor, signal: AbortSignal): Promise<QuotaSnapshot | undefined>;
}

export interface ModelUsage {
  readonly attempts: number;
  readonly totalTokens?: number;
}

export interface ModelUsageHistory {
  rollingUsage(model: ModelDescriptor, since: number): Promise<ModelUsage>;
}

/** Adapter that keeps scheduling independent from SQLite and from route-model formatting. */
export class LedgerModelUsageHistory implements ModelUsageHistory {
  constructor(private readonly ledger: UsageLedger) {}

  async rollingUsage(model: ModelDescriptor, since: number): Promise<ModelUsage> {
    return this.ledger.rollingUsage({ since, providerId: model.providerId, upstreamModel: model.id });
  }
}

export interface ModelSelectionOptions {
  readonly availabilityProbe?: AvailabilityProbe;
  readonly quotaReporter?: QuotaReporter;
  readonly usageHistory?: ModelUsageHistory;
  readonly stateStore?: ModelSelectionStateStore;
  readonly clock?: () => number;
  readonly probeTtlMs?: number;
  readonly quotaTtlMs?: number;
  readonly notFoundCooldownMs?: number;
  readonly fallbackCooldownMs?: number;
  readonly rollingWindowMs?: number;
  readonly maxConcurrentChecks?: number;
}

export type SelectionReason =
  | "eligible"
  | "duplicate-catalog-id"
  | "capability-mismatch"
  | "deprecated"
  | "availability-unconfirmed"
  | "probe-unavailable"
  | "learned-not-found"
  | "cooldown"
  | "quota-exhausted"
  | "quota-unknown"
  | "quota-headroom"
  | "usage-history"
  | "fair-scheduling";

export interface ModelSelectionExplanation {
  readonly providerId: string;
  readonly modelId: string;
  readonly eligible: boolean;
  readonly rank?: number;
  readonly reasons: readonly SelectionReason[];
  readonly availability: "available" | "unavailable" | "unknown";
  readonly quota: "known" | "unknown";
  readonly cooldownUntil?: number;
  readonly rollingUsage?: ModelUsage;
}

export interface ModelSelectionResult {
  readonly selected?: ModelDescriptor;
  readonly explanations: readonly ModelSelectionExplanation[];
}

export interface ProviderOutcome {
  readonly providerId: string;
  readonly modelId: string;
  readonly statusCode: 404 | 429;
  /** Accepts an HTTP Retry-After value (seconds/date) or a millisecond delay. */
  readonly retryAfter?: string | number;
}

interface Candidate {
  readonly model: ModelDescriptor;
  readonly health: ModelSelectionHealth;
  readonly availability: "available" | "unavailable" | "unknown";
  readonly quota: ModelSelectionHealth["quota"];
  readonly usage: ModelUsage;
  readonly reasons: SelectionReason[];
}

const JSON_SCHEMA_RANK: Readonly<Record<NonNullable<ModelRequirements["minimumJsonSchema"]>, number>> = { none: 0, subset: 1, full: 2 };

/**
 * Ranks a fresh provider catalog only. It never infers model quality from an
 * identifier, version, display name, or catalog order.
 */
export class AutomaticModelSelector {
  private readonly stateStore: ModelSelectionStateStore;
  private readonly clock: () => number;
  private readonly probeTtlMs: number;
  private readonly quotaTtlMs: number;
  private readonly notFoundCooldownMs: number;
  private readonly fallbackCooldownMs: number;
  private readonly rollingWindowMs: number;
  private readonly maxConcurrentChecks: number;

  constructor(private readonly options: ModelSelectionOptions = {}) {
    this.stateStore = options.stateStore ?? new MemoryModelSelectionStateStore();
    this.clock = options.clock ?? Date.now;
    this.probeTtlMs = options.probeTtlMs ?? 60_000;
    this.quotaTtlMs = options.quotaTtlMs ?? 60_000;
    this.notFoundCooldownMs = options.notFoundCooldownMs ?? 3_600_000;
    this.fallbackCooldownMs = options.fallbackCooldownMs ?? 30_000;
    this.rollingWindowMs = options.rollingWindowMs ?? 3_600_000;
    this.maxConcurrentChecks = Math.max(1, options.maxConcurrentChecks ?? 2);
  }

  async select(models: readonly ModelDescriptor[], requirements: ModelRequirements = {}): Promise<ModelSelectionResult> {
    const now = this.clock();
    const duplicateKeys = findDuplicateKeys(models);
    const activeKeys = new Set(models.map(modelKey));
    const loaded = await this.stateStore.load();
    const state = pruneState(loaded, activeKeys);
    const healthByKey: Record<string, ModelSelectionHealth> = { ...state.models };

    await this.refreshChecks(models, healthByKey, now);
    const candidates: Candidate[] = [];
    const pendingExplanations: Array<Omit<ModelSelectionExplanation, "rank">> = [];
    for (const model of models) {
      const key = modelKey(model);
      const health = healthByKey[key] ?? { selections: 0 };
      const reasons: SelectionReason[] = [];
      let eligible = true;
      if (duplicateKeys.has(key)) { eligible = false; reasons.push("duplicate-catalog-id"); }
      if (model.availability === "deprecated") { eligible = false; reasons.push("deprecated"); }
      if (!meetsRequirements(model, requirements)) { eligible = false; reasons.push("capability-mismatch"); }
      const availability = effectiveAvailability(model, health, now);
      if (health.unavailableUntil !== undefined && health.unavailableUntil > now) {
        eligible = false;
        reasons.push(health.unavailableReason === "not-found" ? "learned-not-found" : "cooldown");
      } else if (availability === "unavailable") {
        eligible = false;
        reasons.push("probe-unavailable");
      } else if (availability === "unknown" && model.availability !== "available") {
        eligible = false;
        reasons.push("availability-unconfirmed");
      }
      const quota = health.quota;
      if (isQuotaExhausted(quota)) { eligible = false; reasons.push("quota-exhausted"); }
      if (quota?.known === true && quota.headroom !== undefined) reasons.push("quota-headroom");
      else reasons.push("quota-unknown");
      const usage = await this.usageFor(model, now);
      if (usage.attempts > 0 || usage.totalTokens !== undefined) reasons.push("usage-history");
      if (eligible) {
        reasons.push("eligible", "fair-scheduling");
        candidates.push({ model, health, availability, quota, usage, reasons });
      }
      pendingExplanations.push({
        providerId: model.providerId, modelId: model.id, eligible, reasons,
        availability, quota: quota?.known === true ? "known" : "unknown",
        ...(health.unavailableUntil !== undefined && health.unavailableUntil > now ? { cooldownUntil: health.unavailableUntil } : {}),
        ...(usage.attempts > 0 || usage.totalTokens !== undefined ? { rollingUsage: usage } : {}),
      });
    }
    candidates.sort(compareCandidates);
    const selected = candidates[0];
    const ranks = new Map(candidates.map((candidate, index) => [modelKey(candidate.model), index + 1]));
    if (selected !== undefined) {
      const key = modelKey(selected.model);
      healthByKey[key] = { ...selected.health, selections: selected.health.selections + 1, lastSelectedAt: now };
    }
    await this.stateStore.save({ version: 1, models: healthByKey });
    const explanations = pendingExplanations.map((explanation) => {
      const rank = ranks.get(keyFromParts(explanation.providerId, explanation.modelId));
      return { ...explanation, ...(rank === undefined ? {} : { rank }) };
    });
    return { ...(selected === undefined ? {} : { selected: selected.model }), explanations };
  }

  async recordOutcome(outcome: ProviderOutcome): Promise<void> {
    const now = this.clock();
    const state = await this.stateStore.load();
    const key = keyFromParts(outcome.providerId, outcome.modelId);
    const previous = state.models[key] ?? { selections: 0 };
    const delay = outcome.statusCode === 429 ? retryAfterDelay(outcome.retryAfter, now) ?? this.fallbackCooldownMs : this.notFoundCooldownMs;
    await this.stateStore.save({
      version: 1,
      models: {
        ...state.models,
        [key]: {
          ...previous,
          unavailableUntil: now + delay,
          unavailableReason: outcome.statusCode === 404 ? "not-found" : "rate-limited",
        },
      },
    });
  }

  private async refreshChecks(models: readonly ModelDescriptor[], healthByKey: Record<string, ModelSelectionHealth>, now: number): Promise<void> {
    const controller = new AbortController();
    if (this.options.availabilityProbe !== undefined) {
      await mapWithConcurrency(models, this.maxConcurrentChecks, async (model) => {
        const key = modelKey(model);
        const current = healthByKey[key];
        if (current?.lastProbe !== undefined && current.lastProbe.expiresAt > now) return;
        const result = await this.probe(model, controller.signal, now);
        healthByKey[key] = { ...current, selections: current?.selections ?? 0, lastProbe: result };
      });
    }
    if (this.options.quotaReporter !== undefined) {
      await mapWithConcurrency(models, this.maxConcurrentChecks, async (model) => {
        const key = modelKey(model);
        const current = healthByKey[key];
        if (current?.quota !== undefined && current.quota.expiresAt > now) return;
        const quota = await this.quota(model, controller.signal, now);
        if (quota !== undefined) healthByKey[key] = { ...current, selections: current?.selections ?? 0, quota };
      });
    }
  }

  private async probe(model: ModelDescriptor, signal: AbortSignal, now: number): Promise<NonNullable<ModelSelectionHealth["lastProbe"]>> {
    try {
      const result = await this.options.availabilityProbe?.probe(model, signal);
      const checkedAt = result?.checkedAt ?? now;
      return { status: result?.status ?? "unknown", checkedAt, expiresAt: result?.expiresAt ?? checkedAt + this.probeTtlMs };
    } catch {
      return { status: "unknown", checkedAt: now, expiresAt: now + this.probeTtlMs };
    }
  }

  private async quota(model: ModelDescriptor, signal: AbortSignal, now: number): Promise<NonNullable<ModelSelectionHealth["quota"]> | undefined> {
    try {
      const result = await this.options.quotaReporter?.getQuota(model, signal);
      if (result === undefined) return undefined;
      const checkedAt = result.checkedAt ?? now;
      return {
        known: result.known,
        checkedAt,
        expiresAt: result.expiresAt ?? checkedAt + this.quotaTtlMs,
        ...(result.known && validHeadroom(result.headroom) ? { headroom: result.headroom } : {}),
        ...(result.known && validNonNegative(result.remainingRequests) ? { remainingRequests: result.remainingRequests } : {}),
        ...(result.known && validNonNegative(result.remainingTokens) ? { remainingTokens: result.remainingTokens } : {}),
      };
    } catch {
      return { known: false, checkedAt: now, expiresAt: now + this.quotaTtlMs };
    }
  }

  private async usageFor(model: ModelDescriptor, now: number): Promise<ModelUsage> {
    if (this.options.usageHistory === undefined) return { attempts: 0 };
    try { return await this.options.usageHistory.rollingUsage(model, now - this.rollingWindowMs); }
    catch { return { attempts: 0 }; }
  }
}

function meetsRequirements(model: ModelDescriptor, requirements: ModelRequirements): boolean {
  const capabilities = model.capabilities;
  if (requirements.streaming === true && !capabilities.streaming) return false;
  if (requirements.tools === true && !capabilities.tools) return false;
  if (requirements.parallelTools === true && !capabilities.parallelTools) return false;
  if (requirements.forcedToolChoice === true && !capabilities.forcedToolChoice) return false;
  if (requirements.vision === true && !capabilities.vision) return false;
  if (requirements.nativeTokenCounting === true && !capabilities.nativeTokenCounting) return false;
  if (requirements.reasoningState === "required" && capabilities.reasoningState !== "required") return false;
  if (requirements.minimumJsonSchema !== undefined && JSON_SCHEMA_RANK[capabilities.jsonSchema] < JSON_SCHEMA_RANK[requirements.minimumJsonSchema]) return false;
  return !(requirements.contractTested === true && model.support !== "contract-tested");
}

function effectiveAvailability(model: ModelDescriptor, health: ModelSelectionHealth, now: number): "available" | "unavailable" | "unknown" {
  if (health.lastProbe !== undefined && health.lastProbe.expiresAt > now) return health.lastProbe.status;
  return model.availability === "available" ? "available" : "unknown";
}

function isQuotaExhausted(quota: ModelSelectionHealth["quota"]): boolean {
  return quota?.known === true && (quota.headroom === 0 || quota.remainingRequests === 0 || quota.remainingTokens === 0);
}

function compareCandidates(left: Candidate, right: Candidate): number {
  const leftHeadroom = left.quota?.known === true ? left.quota.headroom : undefined;
  const rightHeadroom = right.quota?.known === true ? right.quota.headroom : undefined;
  if (leftHeadroom !== undefined && rightHeadroom !== undefined && leftHeadroom !== rightHeadroom) return rightHeadroom - leftHeadroom;
  if (left.usage.attempts !== right.usage.attempts) return left.usage.attempts - right.usage.attempts;
  if (left.usage.totalTokens !== undefined && right.usage.totalTokens !== undefined && left.usage.totalTokens !== right.usage.totalTokens) return left.usage.totalTokens - right.usage.totalTokens;
  if (left.health.selections !== right.health.selections) return left.health.selections - right.health.selections;
  if ((left.health.lastSelectedAt ?? 0) !== (right.health.lastSelectedAt ?? 0)) return (left.health.lastSelectedAt ?? 0) - (right.health.lastSelectedAt ?? 0);
  return stableOpaqueOrder(modelKey(left.model), modelKey(right.model));
}

function findDuplicateKeys(models: readonly ModelDescriptor[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const model of models) {
    const key = modelKey(model);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return duplicates;
}

function pruneState(state: ModelSelectionState, activeKeys: ReadonlySet<string>): ModelSelectionState {
  return { version: 1, models: Object.fromEntries(Object.entries(state.models).filter(([key]) => activeKeys.has(key))) };
}

function modelKey(model: Pick<ModelDescriptor, "providerId" | "id">): string { return keyFromParts(model.providerId, model.id); }
function keyFromParts(providerId: string, modelId: string): string { return JSON.stringify([providerId, modelId]); }
function validHeadroom(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function validNonNegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

/** Stable opaque ordering only breaks an otherwise fair tie; it never parses model naming. */
function stableOpaqueOrder(left: string, right: string): number {
  const leftHash = stableHash(left);
  const rightHash = stableHash(right);
  return leftHash === rightHash ? left.localeCompare(right) : leftHash - rightHash;
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function retryAfterDelay(value: ProviderOutcome["retryAfter"], now: number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

async function mapWithConcurrency<T>(items: readonly T[], maximum: number, operation: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await operation(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(maximum, items.length) }, worker));
}
