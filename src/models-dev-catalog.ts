import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export type ModelsDevWireFamily = "anthropic-messages" | "openai-responses" | "openai-chat" | "gemini-generate-content" | "ollama-native";
export type ModelModality = "text" | "audio" | "image" | "video" | "pdf";

export interface ModelsDevCost {
  readonly input: number;
  readonly output: number;
  readonly reasoning?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly inputAudio?: number;
  readonly outputAudio?: number;
  readonly contextOver200k?: ModelsDevCost;
  readonly tiers?: readonly { readonly context: number; readonly cost: ModelsDevCost }[];
}

export interface ModelsDevModel {
  readonly id: string;
  readonly name: string;
  readonly toolCall: boolean;
  readonly reasoning: boolean;
  readonly modalities: { readonly input: readonly ModelModality[]; readonly output: readonly ModelModality[] };
  readonly limits: { readonly context: number; readonly input?: number; readonly output: number };
  readonly costs?: ModelsDevCost;
  readonly deprecated: boolean;
  /** Undefined means this catalog client deliberately has no compatible protocol adapter. */
  readonly wireFamily?: ModelsDevWireFamily;
}

export interface ModelsDevProvider {
  readonly id: string;
  readonly name: string;
  readonly npm: string;
  readonly env: readonly string[];
  readonly api?: string;
  readonly docs: string;
  readonly models: ReadonlyMap<string, ModelsDevModel>;
}

export interface ModelsDevCatalog {
  readonly providers: ReadonlyMap<string, ModelsDevProvider>;
}

export interface ToolCapableCatalogModel {
  readonly provider: ModelsDevProvider;
  readonly model: ModelsDevModel;
}

export interface ModelsDevCatalogResult {
  readonly catalog: ModelsDevCatalog;
  readonly source: "memory" | "cache" | "network" | "not-modified" | "stale-cache";
  readonly stale: boolean;
  readonly fetchedAt: number;
}

export interface ModelsDevCatalogOptions {
  /** Caller-owned private cache path; no default location is imposed by this module. */
  readonly cachePath: string;
  readonly endpoint?: string;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly fetch?: CatalogFetch;
  readonly clock?: () => number;
}

export type CatalogFetch = (input: string, init?: RequestInit) => Promise<Response>;

interface CachedCatalog {
  readonly version: 1;
  readonly fetchedAt: number;
  readonly etag?: string;
  readonly payload: unknown;
}

interface MemoryCatalog {
  readonly catalog: ModelsDevCatalog;
  readonly fetchedAt: number;
  readonly etag?: string;
  readonly payload: unknown;
}

const DEFAULT_ENDPOINT = "https://models.dev/api.json";
const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

/**
 * Models.dev is catalog metadata only. This client sends neither provider
 * credentials nor caller-defined headers, and stores only catalog/ETag state.
 */
export class ModelsDevCatalogClient {
  private readonly endpoint: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly fetch: CatalogFetch;
  private readonly clock: () => number;
  private memory: MemoryCatalog | undefined;
  private refreshInFlight: Promise<{ readonly memory: MemoryCatalog; readonly source: "network" | "not-modified" }> | undefined;

  constructor(private readonly options: ModelsDevCatalogOptions) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, "ttlMs");
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, "maxPayloadBytes");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? Date.now;
  }

  async load(): Promise<ModelsDevCatalogResult> {
    const now = this.clock();
    if (this.memory !== undefined && !isStale(this.memory.fetchedAt, now, this.ttlMs)) {
      return { catalog: this.memory.catalog, source: "memory", stale: false, fetchedAt: this.memory.fetchedAt };
    }
    const cached = this.memory === undefined ? await readCache(this.options.cachePath) : this.memory;
    if (cached !== undefined && !isStale(cached.fetchedAt, now, this.ttlMs)) {
      const memory = cachedToMemory(cached);
      this.memory = memory;
      return { catalog: memory.catalog, source: "cache", stale: false, fetchedAt: memory.fetchedAt };
    }
    try {
      const refreshed = await this.refreshOnce(cached, now);
      this.memory = refreshed.memory;
      return { catalog: refreshed.memory.catalog, source: refreshed.source, stale: false, fetchedAt: refreshed.memory.fetchedAt };
    } catch (error: unknown) {
      if (cached === undefined) throw error;
      const memory = cachedToMemory(cached);
      this.memory = memory;
      return { catalog: memory.catalog, source: "stale-cache", stale: true, fetchedAt: memory.fetchedAt };
    }
  }

  private async refreshOnce(cached: CachedCatalog | MemoryCatalog | undefined, now: number): Promise<{ readonly memory: MemoryCatalog; readonly source: "network" | "not-modified" }> {
    if (this.refreshInFlight === undefined) {
      this.refreshInFlight = this.refresh(cached, now).finally(() => { this.refreshInFlight = undefined; });
    }
    return this.refreshInFlight;
  }

  private async refresh(cached: CachedCatalog | MemoryCatalog | undefined, now: number): Promise<{ readonly memory: MemoryCatalog; readonly source: "network" | "not-modified" }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("models.dev catalog request timed out")), this.timeoutMs);
    try {
      const headers = new Headers({ accept: "application/json" });
      if (cached?.etag !== undefined) headers.set("if-none-match", cached.etag);
      const response = await this.fetch(this.endpoint, { method: "GET", headers, signal: controller.signal });
      if (response.status === 304) {
        if (cached === undefined) throw new ModelsDevCatalogError("models.dev returned 304 without a cache");
        const updated: CachedCatalog = { version: 1, fetchedAt: now, ...(cached.etag === undefined ? {} : { etag: cached.etag }), payload: cached.payload };
        await writeCache(this.options.cachePath, updated);
        return { memory: cachedToMemory(updated), source: "not-modified" };
      }
      if (!response.ok) throw new ModelsDevCatalogError(`models.dev returned HTTP ${response.status}`);
      const payload = JSON.parse(await readBoundedBody(response, this.maxPayloadBytes)) as unknown;
      const catalog = parseCatalog(payload);
      const etag = response.headers.get("etag") ?? undefined;
      const stored: CachedCatalog = { version: 1, fetchedAt: now, ...(etag === undefined ? {} : { etag }), payload };
      await writeCache(this.options.cachePath, stored);
      return { memory: { catalog, fetchedAt: now, ...(etag === undefined ? {} : { etag }), payload }, source: "network" };
    } catch (error: unknown) {
      if (error instanceof ModelsDevCatalogError) throw error;
      throw new ModelsDevCatalogError("Unable to refresh models.dev catalog", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

export class ModelsDevCatalogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelsDevCatalogError";
  }
}

/** Deterministic query only; it is intentionally not a model-selection policy. */
export function toolCapableNonDeprecatedModels(catalog: ModelsDevCatalog): readonly ToolCapableCatalogModel[] {
  const result: ToolCapableCatalogModel[] = [];
  for (const provider of catalog.providers.values()) {
    for (const model of provider.models.values()) {
      if (model.toolCall && !model.deprecated && model.wireFamily !== undefined) result.push({ provider, model });
    }
  }
  return result.sort((left, right) => opaqueKey(left).localeCompare(opaqueKey(right)));
}

const JsonValue: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValue), z.record(z.string(), JsonValue)]));
const Modality = z.enum(["text", "audio", "image", "video", "pdf"]);
const Limit = z.object({ context: z.number().finite().nonnegative(), input: z.number().finite().nonnegative().optional(), output: z.number().finite().nonnegative() }).strict();
const Cost = z.object({
  input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(), reasoning: z.number().finite().nonnegative().optional(),
  cache_read: z.number().finite().nonnegative().optional(), cache_write: z.number().finite().nonnegative().optional(),
  input_audio: z.number().finite().nonnegative().optional(), output_audio: z.number().finite().nonnegative().optional(),
}).strict();
const OutputCost = Cost.extend({ context_over_200k: Cost.optional(), tiers: z.array(Cost.extend({ tier: z.object({ type: z.literal("context"), size: z.number().finite().nonnegative() }).strict() }).strict()).optional() }).strict();
const ProviderOverride = z.object({ npm: z.string().optional(), api: z.string().optional(), shape: z.enum(["responses", "completions"]).optional(), body: z.record(z.string(), JsonValue).optional(), headers: z.record(z.string(), z.string()).optional() }).strict();
const ReasoningOption = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle") }).strict(),
  z.object({ type: z.literal("effort"), values: z.array(z.union([z.null(), z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"])])) }).strict(),
  z.object({ type: z.literal("budget_tokens"), min: z.number().finite().optional(), max: z.number().finite().nonnegative().optional() }).strict(),
]);
const Model = z.object({
  id: z.string().min(1), name: z.string().min(1), description: z.string().min(1), family: z.string().optional(), attachment: z.boolean(), reasoning: z.boolean(),
  reasoning_options: z.array(ReasoningOption).optional(), tool_call: z.boolean(), interleaved: z.union([z.literal(true), z.object({ field: z.enum(["reasoning_content", "reasoning_details"]) }).strict()]).optional(),
  structured_output: z.boolean().optional(), temperature: z.boolean().optional(), knowledge: z.string().optional(), release_date: z.string().min(1), last_updated: z.string().min(1),
  modalities: z.object({ input: z.array(Modality), output: z.array(Modality) }).strict(), open_weights: z.boolean(), limit: Limit, status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  experimental: z.object({ modes: z.record(z.string(), z.object({ cost: Cost.optional(), provider: z.object({ body: z.record(z.string(), JsonValue).optional(), headers: z.record(z.string(), z.string()).optional() }).strict().optional() }).strict()).optional() }).strict().optional(),
  provider: ProviderOverride.optional(), cost: OutputCost.optional(),
}).strict();
const Provider = z.object({ id: z.string().min(1), env: z.array(z.string().min(1)).min(1), npm: z.string().min(1), api: z.string().min(1).optional(), name: z.string().min(1), doc: z.string().min(1), models: z.record(z.string(), Model) }).strict().superRefine((provider, context) => {
  for (const [id, model] of Object.entries(provider.models)) if (id !== model.id) context.addIssue({ code: "custom", message: "Model key must equal model id", path: ["models", id, "id"] });
});
const Catalog = z.record(z.string(), Provider).superRefine((catalog, context) => {
  for (const [id, provider] of Object.entries(catalog)) if (id !== provider.id) context.addIssue({ code: "custom", message: "Provider key must equal provider id", path: [id, "id"] });
});

function parseCatalog(payload: unknown): ModelsDevCatalog {
  const parsed = Catalog.safeParse(payload);
  if (!parsed.success) throw new ModelsDevCatalogError("models.dev catalog failed strict validation", { cause: parsed.error });
  const providers = new Map<string, ModelsDevProvider>();
  for (const [id, value] of Object.entries(parsed.data)) {
    const models = new Map<string, ModelsDevModel>();
    for (const [modelId, model] of Object.entries(value.models)) {
      const wireFamily = classifyWireFamily(value.npm, model.provider?.npm, model.provider?.shape);
      models.set(modelId, {
        id: model.id, name: model.name, toolCall: model.tool_call, reasoning: model.reasoning,
        modalities: model.modalities, limits: { context: model.limit.context, output: model.limit.output, ...(model.limit.input === undefined ? {} : { input: model.limit.input }) }, ...(model.cost === undefined ? {} : { costs: toCost(model.cost) }),
        deprecated: model.status === "deprecated", ...(wireFamily === undefined ? {} : { wireFamily }),
      });
    }
    providers.set(id, { id: value.id, name: value.name, npm: value.npm, env: value.env, ...(value.api === undefined ? {} : { api: value.api }), docs: value.doc, models });
  }
  return { providers };
}

function classifyWireFamily(providerNpm: string, modelNpm: string | undefined, shape: "responses" | "completions" | undefined): ModelsDevWireFamily | undefined {
  if (shape === "responses") return "openai-responses";
  if (shape === "completions") return "openai-chat";
  const npm = modelNpm ?? providerNpm;
  switch (npm) {
    case "@ai-sdk/anthropic": return "anthropic-messages";
    case "@ai-sdk/google": return "gemini-generate-content";
    case "ollama-ai-provider": return "ollama-native";
    case "@ai-sdk/openai":
    case "@ai-sdk/openai-compatible":
    case "@openrouter/ai-sdk-provider":
    case "merge-gateway-ai-sdk-provider": return "openai-chat";
    default: return undefined;
  }
}

function toCost(cost: z.infer<typeof OutputCost>): ModelsDevCost {
  return {
    input: cost.input, output: cost.output,
    ...(cost.reasoning === undefined ? {} : { reasoning: cost.reasoning }), ...(cost.cache_read === undefined ? {} : { cacheRead: cost.cache_read }),
    ...(cost.cache_write === undefined ? {} : { cacheWrite: cost.cache_write }), ...(cost.input_audio === undefined ? {} : { inputAudio: cost.input_audio }),
    ...(cost.output_audio === undefined ? {} : { outputAudio: cost.output_audio }), ...(cost.context_over_200k === undefined ? {} : { contextOver200k: toCost(cost.context_over_200k) }),
    ...(cost.tiers === undefined ? {} : { tiers: cost.tiers.map((tier) => ({ context: tier.tier.size, cost: toCost(tier) })) }),
  };
}

function cachedToMemory(cached: CachedCatalog | MemoryCatalog): MemoryCatalog {
  if ("catalog" in cached) return cached;
  return { catalog: parseCatalog(cached.payload), fetchedAt: cached.fetchedAt, ...(cached.etag === undefined ? {} : { etag: cached.etag }), payload: cached.payload };
}

function isStale(fetchedAt: number, now: number, ttlMs: number): boolean { return now - fetchedAt >= ttlMs; }
function opaqueKey(value: ToolCapableCatalogModel): string { return JSON.stringify([value.provider.id, value.model.id]); }
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

async function readCache(path: string): Promise<CachedCatalog | undefined> {
  try {
    const directoryInfo = await lstat(dirname(path));
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) !== 0) throw new ModelsDevCatalogError("models.dev cache directory must be private");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new ModelsDevCatalogError("models.dev cache is unsafe");
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1 || !Number.isSafeInteger((parsed as { fetchedAt?: unknown }).fetchedAt) || !("payload" in parsed)) throw new ModelsDevCatalogError("models.dev cache is invalid");
    const cache = parsed as CachedCatalog;
    return cache;
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeCache(path: string, cache: CachedCatalog): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) !== 0) throw new ModelsDevCatalogError("models.dev cache directory must be private");
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(cache), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readBoundedBody(response: Response, maximum: number): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && Number.isSafeInteger(Number(length)) && Number(length) > maximum) throw new ModelsDevCatalogError("models.dev payload exceeds configured limit");
  if (response.body === null) throw new ModelsDevCatalogError("models.dev response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new ModelsDevCatalogError("models.dev payload exceeds configured limit");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks, size));
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return combined;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
