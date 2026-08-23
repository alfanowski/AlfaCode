import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { listenLocalGateway } from "./gateway.js";
import { encodeModelId } from "./model-id.js";
import type {
  AnthropicUsage,
  CanonicalStreamEvent,
  Provider,
  ProviderError,
  ProviderModel,
  ProviderMessageRequest,
  ProviderRequestContext,
  TokenCount,
} from "./provider-contract.js";
import { UsageLedger } from "./usage-ledger.js";
import type { AlfaCodeConfig, ProviderRecord } from "./config.js";
import { SecretResolver } from "./secrets.js";
import { GoogleProvider } from "./providers/google/provider.js";
import { AnthropicMessagesAdapter } from "./providers/anthropic/messages.js";
import { OpenAIChatAdapter, OpenAIResponsesAdapter } from "./providers/openai/index.js";
import { CompositeProvider } from "./providers/composite.js";
import { discoverZenModels } from "./providers/zen/catalog.js";
import { CAPABILITIES, type ModelDescriptor, type WireProtocol } from "./providers/foundation/types.js";
import { AutomaticModelSelector, LedgerModelUsageHistory } from "./model-selection.js";
import { FileModelSelectionStateStore } from "./model-selection-state.js";
import type {
  AnthropicRequest as GoogleRequest,
  CanonicalStreamEvent as GoogleEvent,
  ProviderModel as GoogleModel,
} from "./providers/google/types.js";

export interface RuntimeHandle {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly defaultModelId?: string;
  readonly modelCandidates: readonly ModelDescriptor[];
  readonly contextWindowTokens?: number;
  readonly secretEnvironmentNames?: readonly string[];
  readonly warnings?: readonly string[];
  close(): Promise<void>;
}

export interface StartRuntimeInput {
  readonly provider: ProviderRecord;
  readonly config: AlfaCodeConfig;
  readonly purpose?: "launch" | "discovery";
}

export interface RuntimeDependencies {
  readonly secrets?: SecretResolver;
  readonly homeDirectory?: string;
  readonly createGoogle?: (options: ConstructorParameters<typeof GoogleProvider>[0]) => GoogleProvider;
  readonly usageLedger?: UsageLedger;
  readonly fetch?: typeof fetch;
  /** Optional account-independent catalog evidence (for example models.dev). */
  readonly modelMetadata?: DynamicModelMetadataResolver;
  readonly modelSelector?: AutomaticModelSelector;
}

export interface DynamicModelMetadataResolver {
  resolve(input: { providerId: string; modelId: string; wireProtocol: Exclude<WireProtocol, "unsupported"> }): Promise<DynamicModelMetadata | undefined>;
}

export interface DynamicModelMetadata {
  readonly displayName?: string;
  readonly capabilities: ModelDescriptor["capabilities"];
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly support?: ModelDescriptor["support"];
}

interface GoogleAdapter {
  listModels(): Promise<GoogleModel[]>;
  stream(request: GoogleRequest, context: { session: string; agent: string; signal?: AbortSignal }): AsyncIterable<GoogleEvent>;
  countTokens(request: GoogleRequest, model: string, context: { session: string; agent: string; signal?: AbortSignal }): Promise<number>;
  close(): Promise<void>;
}

interface ConfiguredProvider {
  readonly provider: Provider;
  readonly descriptors: readonly ModelDescriptor[];
}

/** A catalog entry can name its wire protocol without becoming a new runtime switch case. */
export interface DynamicWireProviderDescriptor {
  readonly id: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly wireProtocol: Exclude<WireProtocol, "unsupported" | "ollama-native">;
  readonly models: readonly ModelDescriptor[];
}

const GOOGLE_PROBE_TTL_MS = 10 * 60 * 1000;
const googleProbeCache = new Map<string, { expiresAt: number; availability: ModelDescriptor["availability"]; reason?: string }>();
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const modelDiscoveryCache = new Map<string, { expiresAt: number; models: readonly DiscoveredModel[] }>();
const modelProbeCache = new Map<string, { expiresAt: number; availability: ModelDescriptor["availability"]; reason?: string }>();
interface DiscoveredModel { readonly id: string; readonly displayName: string; readonly contextWindow?: number; readonly maxOutputTokens?: number; }

/** Runtime-facing dynamic factory. Catalogs are prewarmed here; no caller gets a guessed model default. */
export async function createConfiguredProvider(record: ProviderRecord, apiKey: string, dependencies: RuntimeDependencies, homeDirectory: string): Promise<ConfiguredProvider> {
  const baseUrl = stringOption(record.options, "baseUrl");
  if (record.type === "google" || record.type === "google-ai-studio") {
    const google = (dependencies.createGoogle ?? ((options) => new GoogleProvider(options)))({ apiKey, ...(baseUrl === undefined ? {} : { baseUrl }), statePath: join(homeDirectory, ".alfacode", "state", `${record.id}-google-tools.json`) });
    try {
      const models = await google.listModels();
      const descriptors = await probeGoogleModels(record.id, apiKey, google, models, dependencies.modelMetadata);
      return { provider: new GoogleGatewayProvider(record.id, google, models.filter((model) => descriptors.some((descriptor) => descriptor.id === model.id && descriptor.availability === "available" && descriptor.capabilities.tools))), descriptors };
    } catch (error) {
      await google.close();
      throw error;
    }
  }
  if (record.type === "anthropic") {
    const descriptors = await discoverConfiguredModels(record, apiKey, "anthropic-messages", baseUrl ?? "https://api.anthropic.com/v1", dependencies);
    return { provider: createWireProvider({ id: record.id, apiKey, baseUrl: baseUrl ?? "https://api.anthropic.com/v1", wireProtocol: "anthropic-messages", models: descriptors }, dependencies, homeDirectory), descriptors };
  }
  if (record.type === "openai-compatible") {
    if (baseUrl === undefined) throw new Error(`Provider '${record.id}' requires options.baseUrl`);
    const descriptors = await discoverConfiguredModels(record, apiKey, "openai-chat", baseUrl, dependencies);
    return { provider: createWireProvider({ id: record.id, apiKey, baseUrl, wireProtocol: "openai-chat", models: descriptors }, dependencies, homeDirectory), descriptors };
  }
  if (record.type === "opencode-zen" || record.type === "zen") {
    const zenBase = baseUrl ?? "https://opencode.ai/zen/v1";
    const descriptors = await discoverZenModels({ apiKey, baseUrl: zenBase, ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }) });
    const entries = descriptors.map((descriptor) => {
      const models = [descriptor];
      if (descriptor.wireProtocol !== "unsupported" && descriptor.wireProtocol !== "ollama-native") return { descriptor, provider: createWireProvider({ id: record.id, apiKey, baseUrl: zenBase, wireProtocol: descriptor.wireProtocol, models }, dependencies, homeDirectory) };
      return { descriptor };
    });
    return { provider: new CompositeProvider(record.id, entries), descriptors };
  }
  const wireProtocol = wireProtocolOption(record.options);
  if (baseUrl !== undefined && wireProtocol !== undefined) {
    const descriptors = await discoverConfiguredModels(record, apiKey, wireProtocol, baseUrl, dependencies);
    return { provider: createWireProvider({ id: record.id, apiKey, baseUrl, wireProtocol, models: descriptors }, dependencies, homeDirectory), descriptors };
  }
  throw new Error(`Unsupported provider type: ${record.type}`);
}

/**
 * Composable protocol factory for dynamic catalogs (including models.dev
 * descriptors). The caller supplies a known wire contract; unknown protocols
 * stay unavailable instead of being routed optimistically.
 */
export function createWireProvider(descriptor: DynamicWireProviderDescriptor, dependencies: RuntimeDependencies, homeDirectory: string): Provider {
  const callable = descriptor.models.filter((model) => model.availability === "available" && model.capabilities.tools);
  const common = { id: descriptor.id, apiKey: descriptor.apiKey, models: callable, baseUrl: descriptor.baseUrl, ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }) };
  if (descriptor.wireProtocol === "anthropic-messages") return new AnthropicMessagesAdapter(common);
  if (descriptor.wireProtocol === "openai-chat") return new OpenAIChatAdapter(common);
  if (descriptor.wireProtocol === "openai-responses") return new OpenAIResponsesAdapter(common);
  const google = (dependencies.createGoogle ?? ((options) => new GoogleProvider(options)))({ apiKey: descriptor.apiKey, baseUrl: descriptor.baseUrl, statePath: join(homeDirectory, ".alfacode", "state", `${descriptor.id}-google-tools.json`) });
  return new GoogleGatewayProvider(descriptor.id, google, callable.map(toGoogleModel));
}

async function discoverConfiguredModels(record: ProviderRecord, apiKey: string, wireProtocol: Exclude<WireProtocol, "unsupported" | "ollama-native">, baseUrl: string, dependencies: RuntimeDependencies): Promise<ModelDescriptor[]> {
  let listed: readonly DiscoveredModel[];
  try { listed = await discoverAccountModels(record.id, apiKey, baseUrl, wireProtocol, dependencies.fetch); }
  catch (error: unknown) {
    throw new Error(`Model discovery for '${record.id}' failed: ${redactProbeReason(error instanceof Error ? error.message : String(error))}`);
  }
  return Promise.all(listed.map(async (model) => {
    const descriptor = await descriptorFromDiscovery(record.id, model, wireProtocol, dependencies.modelMetadata);
    const probe = await probeProtocolModel(record.id, apiKey, baseUrl, model.id, wireProtocol, dependencies.fetch);
    if (probe.availability === "available") return descriptor;
    return { ...descriptor, availability: probe.availability, ...(probe.reason === undefined ? {} : { unavailableReason: probe.reason }) };
  }));
}

async function discoverAccountModels(providerId: string, apiKey: string, baseUrl: string, wireProtocol: "anthropic-messages" | "openai-chat" | "openai-responses" | "gemini-generate-content", requestFetch: typeof fetch | undefined): Promise<readonly DiscoveredModel[]> {
  const key = `${providerId}:${baseUrl}:${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}:${wireProtocol}`;
  const cached = modelDiscoveryCache.get(key); if (cached?.expiresAt && cached.expiresAt > Date.now()) return cached.models;
  try {
    const headers = wireProtocol === "anthropic-messages" ? { accept: "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { accept: "application/json", Authorization: `Bearer ${apiKey}` };
    const response = await (requestFetch ?? fetch)(`${baseUrl.replace(/\/$/, "")}/models`, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const payload: unknown = await response.json(); const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : undefined;
    if (!data) throw new Error("invalid model discovery response");
    const models = data.flatMap((value): DiscoveredModel[] => {
      if (!isRecord(value) || typeof value.id !== "string" || !value.id) return [];
      const displayName = typeof value.display_name === "string" ? value.display_name : typeof value.name === "string" ? value.name : value.id;
      return [{ id: value.id, displayName, ...(typeof value.context_window === "number" ? { contextWindow: value.context_window } : {}), ...(typeof value.max_output_tokens === "number" ? { maxOutputTokens: value.max_output_tokens } : {}) }];
    });
    if (!models.length) throw new Error("model discovery returned no valid models");
    modelDiscoveryCache.set(key, { expiresAt: Date.now() + DISCOVERY_TTL_MS, models });
    return models;
  } catch (error) {
    if (cached) return cached.models;
    throw error;
  }
}

/** Uses non-inference endpoints only; this verifies account visibility without paid generation. */
async function probeProtocolModel(providerId: string, apiKey: string, baseUrl: string, modelId: string, wireProtocol: "anthropic-messages" | "openai-chat" | "openai-responses" | "gemini-generate-content", requestFetch: typeof fetch | undefined): Promise<{ availability: ModelDescriptor["availability"]; reason?: string }> {
  const key = `${providerId}:${baseUrl}:${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}:${wireProtocol}:${modelId}`;
  const cached = modelProbeCache.get(key); if (cached && cached.expiresAt > Date.now()) return cached;
  try {
    const root = baseUrl.replace(/\/$/, "");
    const isAnthropic = wireProtocol === "anthropic-messages";
    const response = await (requestFetch ?? fetch)(isAnthropic ? `${root}/messages/count_tokens` : `${root}/models/${encodeURIComponent(modelId)}`, isAnthropic
      ? { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "" }] }) }
      : { headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" } });
    const availability: ModelDescriptor["availability"] = response.ok ? "available" : response.status === 404 || response.status === 410 ? "deprecated" : response.status === 401 || response.status === 403 ? "account-validation-required" : "unknown";
    const result = { expiresAt: Date.now() + DISCOVERY_TTL_MS, availability, ...(availability === "available" ? {} : { reason: redactProbeReason(`non-inference model probe returned HTTP ${response.status}`) }) };
    modelProbeCache.set(key, result); return result;
  } catch (error: unknown) {
    const result = { expiresAt: Date.now() + DISCOVERY_TTL_MS, availability: "unknown" as const, reason: redactProbeReason(error instanceof Error ? error.message : String(error)) };
    modelProbeCache.set(key, result); return result;
  }
}

async function probeGoogleModels(providerId: string, apiKey: string, google: GoogleAdapter, models: readonly GoogleModel[], metadataResolver: DynamicModelMetadataResolver | undefined): Promise<ModelDescriptor[]> {
  const results = new Array<ModelDescriptor>(models.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, models.length) }, async () => {
    while (cursor < models.length) {
      const index = cursor; cursor += 1;
      const model = models[index]; if (!model) continue;
      const key = `${providerId}:${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}:${model.id}`; const cached = googleProbeCache.get(key); const now = Date.now();
      let result = cached && cached.expiresAt > now ? cached : undefined;
      if (!result) {
        try { await google.countTokens({ model: model.id, messages: [{ role: "user", content: "" }] }, model.id, { session: "__probe__", agent: "__probe__" }); result = { expiresAt: now + GOOGLE_PROBE_TTL_MS, availability: "available" as const }; }
        catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          const status = errorStatus(error);
          const availability = status === 404 || status === 410 ? "deprecated" as const
            : status === 401 || status === 403 ? "account-validation-required" as const
            : "unknown" as const;
          result = { expiresAt: now + GOOGLE_PROBE_TTL_MS, availability, reason: redactProbeReason(message) };
        }
        googleProbeCache.set(key, result);
      }
      const metadata = await metadataResolver?.resolve({ providerId, modelId: model.id, wireProtocol: "gemini-generate-content" });
      const verified = result.availability === "available" && metadata?.capabilities.tools === true;
      results[index] = { providerId, id: model.id, displayName: metadata?.displayName ?? model.displayName, wireProtocol: "gemini-generate-content", capabilities: metadata?.capabilities ?? unverifiedCapabilities("gemini-generate-content"), availability: verified ? "available" : result.availability === "available" ? "unknown" : result.availability, ...(!verified && result.availability === "available" ? { unavailableReason: "Tool capability is unverified for this account model" } : result.reason === undefined ? {} : { unavailableReason: result.reason }), ...(metadata?.contextWindow === undefined ? model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow } : { contextWindow: metadata.contextWindow }), ...(metadata?.maxOutputTokens === undefined ? model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens } : { maxOutputTokens: metadata.maxOutputTokens }), support: metadata?.support ?? "best-effort" };
    }
  });
  await Promise.all(workers);
  return results;
}

async function descriptorFromDiscovery(providerId: string, model: DiscoveredModel, wireProtocol: Exclude<WireProtocol, "unsupported" | "ollama-native">, metadataResolver: DynamicModelMetadataResolver | undefined): Promise<ModelDescriptor> {
  const metadata = await metadataResolver?.resolve({ providerId, modelId: model.id, wireProtocol });
  const verified = metadata?.capabilities.tools === true;
  return { providerId, id: model.id, displayName: metadata?.displayName ?? model.displayName, wireProtocol, capabilities: metadata?.capabilities ?? unverifiedCapabilities(wireProtocol), availability: verified ? "available" : "unknown", ...(!verified ? { unavailableReason: "Tool capability is unverified" } : {}), ...(metadata?.contextWindow === undefined ? model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow } : { contextWindow: metadata.contextWindow }), ...(metadata?.maxOutputTokens === undefined ? model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens } : { maxOutputTokens: metadata.maxOutputTokens }), support: metadata?.support ?? "best-effort" };
}

function unverifiedCapabilities(protocol: Exclude<WireProtocol, "unsupported" | "ollama-native">): ModelDescriptor["capabilities"] { return { ...CAPABILITIES[protocol], tools: false, parallelTools: false, forcedToolChoice: false }; }

function toGoogleModel(descriptor: ModelDescriptor): GoogleModel { return { id: descriptor.id, displayName: descriptor.displayName, ...(descriptor.contextWindow === undefined ? {} : { contextWindow: descriptor.contextWindow }), ...(descriptor.maxOutputTokens === undefined ? {} : { maxOutputTokens: descriptor.maxOutputTokens }) }; }
function stringOption(options: ProviderRecord["options"], key: string): string | undefined { return typeof options?.[key] === "string" ? options[key] as string : undefined; }
function wireProtocolOption(options: ProviderRecord["options"]): Exclude<WireProtocol, "unsupported" | "ollama-native"> | undefined {
  const value = stringOption(options, "wireProtocol") ?? stringOption(options, "protocol");
  return value === "anthropic-messages" || value === "openai-chat" || value === "openai-responses" || value === "gemini-generate-content" ? value : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const value = error.status ?? error.statusCode ?? error.code;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
function redactProbeReason(value: string): string { return value.replace(/(?:AIza|api[_-]?key[=:]\s*)[^\s'"&]+/gi, "[REDACTED]").slice(0, 256); }

/** Prewarms every configured catalog before exposing one loopback-only Anthropic endpoint. */
export async function startRuntime(input: StartRuntimeInput, dependencies: RuntimeDependencies = {}): Promise<RuntimeHandle> {
  const secrets = dependencies.secrets ?? new SecretResolver();
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const providers: Provider[] = [];
  const ledger = dependencies.usageLedger ?? await UsageLedger.open(join(homeDirectory, ".alfacode", "usage"));

  try {
    const candidates: ModelDescriptor[] = [];
    const warnings: string[] = [];
    for (const record of input.config.providers) {
      try {
        if (record.apiKey === undefined) throw new Error("no API key reference");
        const apiKey = await secrets.resolve(record.apiKey);
        if (apiKey === undefined || apiKey.length === 0) throw new Error("API key unavailable");
        const built = await createConfiguredProvider(record, apiKey, dependencies, homeDirectory);
        providers.push(built.provider);
        candidates.push(...built.descriptors);
      } catch (error: unknown) {
        warnings.push(`Provider '${record.id}' unavailable: ${redactProbeReason(error instanceof Error ? error.message : String(error))}`);
      }
    }

    const pinnedModel = typeof input.provider.options?.defaultModel === "string"
      ? candidates.find((model) => model.providerId === input.provider.id && model.id === input.provider.options?.defaultModel
        && model.availability === "available" && model.capabilities.tools)
      : undefined;
    let selectedModel: ModelDescriptor | undefined;
    let activeSelector: AutomaticModelSelector | undefined;
    if (input.purpose !== "discovery") {
      const selector = dependencies.modelSelector ?? new AutomaticModelSelector({
        usageHistory: new LedgerModelUsageHistory(ledger),
        stateStore: new FileModelSelectionStateStore(join(homeDirectory, ".alfacode", "state", "model-selection.json")),
      });
      activeSelector = selector;
      selectedModel = pinnedModel ?? (await selector.select(candidates, { streaming: true, tools: true })).selected;
      if (selectedModel === undefined) throw new Error(`No dynamically discovered model is currently available with verified tool support${warnings.length === 0 ? "" : `. ${warnings.join("; ")}`}`);
    }

    const authToken = randomBytes(32).toString("base64url");
    for (const provider of providers) {
      for (const model of provider.models) {
        await ledger.registerModel(provider.id, encodeModelId(provider.id, model.id), model);
      }
    }
    const gateway = await listenLocalGateway({
      token: authToken,
      providers,
      usageLedger: ledger,
      ...(activeSelector === undefined ? {} : { onProviderOutcome: (outcome: { providerId: string; modelId: string; statusCode: 404 | 429 }) => activeSelector.recordOutcome(outcome) }),
    });
    return {
      baseUrl: gateway.address,
      authToken,
      ...(selectedModel === undefined ? {} : { defaultModelId: encodeModelId(selectedModel.providerId, selectedModel.id) }),
      modelCandidates: candidates,
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(selectedModel?.contextWindow === undefined ? {} : { contextWindowTokens: selectedModel.contextWindow }),
      secretEnvironmentNames: input.config.providers.flatMap((record) => record.apiKey?.kind === "env" ? [record.apiKey.name] : []),
      close: async () => {
        await gateway.app.close();
        await ledger.close();
      },
    };
  } catch (error) {
    await Promise.allSettled(providers.map(async (provider) => provider.close()));
    await ledger.close();
    throw error;
  }
}

export class GoogleGatewayProvider implements Provider {
  public readonly models: readonly ProviderModel[];

  public constructor(
    public readonly id: string,
    private readonly upstream: GoogleAdapter,
    public readonly googleModels: readonly GoogleModel[],
  ) {
    this.models = googleModels.map((model) => ({
      id: model.id,
      displayName: `[${id}] ${model.displayName}`,
      limits: {
        ...(model.contextWindow === undefined ? {} : { maxInputTokens: model.contextWindow }),
        ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
        contextIncludesOutput: false,
      },
      capabilities: { tokenCounting: "exact" as const, usageReporting: "final" as const },
    }));
  }

  public async *streamMessage(request: ProviderMessageRequest, context: ProviderRequestContext): AsyncIterable<CanonicalStreamEvent> {
    const model = encodeModelId(this.id, request.model);
    let index = 0;
    let openBlock: { index: number; type: "text" | "thinking" } | undefined;
    let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
    let stopReason = "end_turn";

    yield {
      type: "message_start",
      message: {
        id: `msg_alfacode_${randomUUID().replaceAll("-", "")}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    };

    for await (const event of this.upstream.stream(toGoogleRequest(request), {
      session: context.session,
      agent: context.agent,
      signal: context.signal,
    })) {
      if (event.type === "warning") continue;
      if (event.type === "error") throw googleProviderError(event);
      if (event.type === "usage") {
        usage = {
          input_tokens: event.input_tokens,
          output_tokens: event.output_tokens,
          ...(event.cached_input_tokens === undefined ? {} : { cache_read_input_tokens: event.cached_input_tokens }),
          ...(event.cache_write_tokens === undefined ? {} : { cache_creation_input_tokens: event.cache_write_tokens }),
        };
        yield {
          type: "usage",
          usage: {
            semantics: "cumulative", stage: "final", source: "provider",
            inputTokens: event.input_tokens, outputTokens: event.output_tokens,
            ...(event.cached_input_tokens === undefined ? {} : { cachedInputTokens: event.cached_input_tokens }),
            ...(event.cache_write_tokens === undefined ? {} : { cacheWriteTokens: event.cache_write_tokens }),
            ...(event.reasoning_tokens === undefined ? {} : { reasoningTokens: event.reasoning_tokens }),
            ...(event.tool_tokens === undefined ? {} : { toolTokens: event.tool_tokens }),
            ...(event.total_tokens === undefined ? {} : { totalTokens: event.total_tokens }),
          },
        };
        continue;
      }
      if (event.type === "message_delta") {
        stopReason = event.stop_reason;
        continue;
      }
      if (event.type === "thinking_delta") {
        if (openBlock?.type !== "thinking") {
          if (openBlock !== undefined) {
            yield { type: "content_block_stop", index: openBlock.index };
            index += 1;
          }
          openBlock = { index, type: "thinking" };
          yield { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } };
        }
        if (event.thinking) {
          yield { type: "content_block_delta", index: openBlock.index, delta: { type: "thinking_delta", thinking: event.thinking } };
        }
        if (event.signature) {
          yield { type: "content_block_delta", index: openBlock.index, delta: { type: "signature_delta", signature: event.signature } };
        }
        continue;
      }
      if (event.type === "text_delta") {
        if (openBlock?.type !== "text") {
          if (openBlock !== undefined) {
            yield { type: "content_block_stop", index: openBlock.index };
            index += 1;
          }
          openBlock = { index, type: "text" };
          yield { type: "content_block_start", index, content_block: { type: "text", text: "" } };
        }
        yield { type: "content_block_delta", index: openBlock.index, delta: { type: "text_delta", text: event.text } };
        continue;
      }
      if (event.type === "tool_use") {
        if (openBlock !== undefined) {
          yield { type: "content_block_stop", index: openBlock.index };
          index += 1;
          openBlock = undefined;
        }
        const toolIndex = index;
        yield { type: "content_block_start", index: toolIndex, content_block: { type: "tool_use", id: event.id, name: event.name, input: {} } };
        yield { type: "content_block_delta", index: toolIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(event.input) } };
        yield { type: "content_block_stop", index: toolIndex };
        index += 1;
      }
    }
    if (openBlock !== undefined) yield { type: "content_block_stop", index: openBlock.index };
    yield { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage };
    yield { type: "message_stop" };
  }

  public async countTokens(request: ProviderMessageRequest, context: ProviderRequestContext): Promise<TokenCount> {
    const inputTokens = await this.upstream.countTokens(toGoogleRequest(request), request.model, {
      session: context.session,
      agent: context.agent,
      signal: context.signal,
    });
    return { inputTokens, source: "provider", exact: true };
  }

  public close(): Promise<void> {
    return this.upstream.close();
  }
}

function toGoogleRequest(request: ProviderMessageRequest): GoogleRequest {
  return request as unknown as GoogleRequest;
}

function googleProviderError(event: Extract<GoogleEvent, { type: "error" }>): ProviderError {
  const status = event.error.statusCode;
  if (status === 429) return { kind: "rate_limit", message: event.error.message, statusCode: status };
  if (status === 401) return { kind: "authentication", message: event.error.message, statusCode: status };
  if (status === 403) return { kind: "permission", message: event.error.message, statusCode: status };
  if (status === 404 || status === 410) return { kind: "not_found", message: event.error.message, statusCode: status };
  if (status === 400 || status === 422) return { kind: "invalid_request", message: event.error.message, statusCode: status };
  const text = `${event.error.type} ${event.error.message}`.toLowerCase();
  const kind: ProviderError["kind"] = text.includes("429") || text.includes("rate")
    ? "rate_limit"
    : text.includes("401") || text.includes("api key") || text.includes("unauth")
      ? "authentication"
      : text.includes("403") || text.includes("permission")
        ? "permission"
        : text.includes("404") || text.includes("not found")
          ? "not_found"
          : text.includes("invalid") || text.includes("400")
            ? "invalid_request"
            : "api";
  return { kind, message: event.error.message };
}
