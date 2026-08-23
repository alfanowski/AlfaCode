import { randomBytes, randomUUID } from "node:crypto";
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
import type {
  AnthropicRequest as GoogleRequest,
  CanonicalStreamEvent as GoogleEvent,
  ProviderModel as GoogleModel,
} from "./providers/google/types.js";

export interface RuntimeHandle {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly defaultModelId?: string;
  readonly contextWindowTokens?: number;
  readonly secretEnvironmentNames?: readonly string[];
  close(): Promise<void>;
}

export interface StartRuntimeInput {
  readonly provider: ProviderRecord;
  readonly config: AlfaCodeConfig;
}

export interface RuntimeDependencies {
  readonly secrets?: SecretResolver;
  readonly homeDirectory?: string;
  readonly createGoogle?: (options: ConstructorParameters<typeof GoogleProvider>[0]) => GoogleProvider;
  readonly usageLedger?: UsageLedger;
}

interface GoogleAdapter {
  listModels(): Promise<GoogleModel[]>;
  stream(request: GoogleRequest, context: { session: string; agent: string; signal?: AbortSignal }): AsyncIterable<GoogleEvent>;
  countTokens(request: GoogleRequest, model: string, context: { session: string; agent: string; signal?: AbortSignal }): Promise<number>;
  close(): Promise<void>;
}

/** Prewarms every configured catalog before exposing one loopback-only Anthropic endpoint. */
export async function startRuntime(input: StartRuntimeInput, dependencies: RuntimeDependencies = {}): Promise<RuntimeHandle> {
  const secrets = dependencies.secrets ?? new SecretResolver();
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const providers: Provider[] = [];
  const ledger = dependencies.usageLedger ?? await UsageLedger.open(join(homeDirectory, ".alfacode", "usage"));

  try {
    for (const record of input.config.providers) {
      if (record.type !== "google") throw new Error(`Unsupported provider type: ${record.type}`);
      if (record.apiKey === undefined) throw new Error(`Provider '${record.id}' has no API key reference`);
      const apiKey = await secrets.resolve(record.apiKey);
      if (apiKey === undefined || apiKey.length === 0) throw new Error(`API key unavailable for provider '${record.id}'`);
      const google = (dependencies.createGoogle ?? ((options) => new GoogleProvider(options)))({
        apiKey,
        statePath: join(homeDirectory, ".alfacode", "state", `${record.id}-google-tools.json`),
      });
      const models = await google.listModels();
      if (models.length === 0) throw new Error(`Provider '${record.id}' returned no Generate Content models`);
      providers.push(new GoogleGatewayProvider(record.id, google, models));
    }

    const selectedProvider = providers.find((provider) => provider.id === input.provider.id);
    if (selectedProvider === undefined) throw new Error(`Default provider '${input.provider.id}' is unavailable`);
    const preferredModel = typeof input.provider.options?.defaultModel === "string"
      ? input.provider.options.defaultModel
      : undefined;
    const selectedModel = selectedProvider.models.find((model) => model.id === preferredModel) ?? selectedProvider.models[0];
    if (selectedModel === undefined) throw new Error(`Default provider '${input.provider.id}' returned no models`);

    const authToken = randomBytes(32).toString("base64url");
    for (const provider of providers) {
      for (const model of provider.models) {
        await ledger.registerModel(provider.id, encodeModelId(provider.id, model.id), model);
      }
    }
    const gateway = await listenLocalGateway({ token: authToken, providers, usageLedger: ledger });
    const contextWindows = providers.flatMap((provider) => provider instanceof GoogleGatewayProvider
      ? provider.googleModels
        .map((model) => model.contextWindow)
        .filter((window): window is number => window !== undefined)
      : []);
    const contextWindowTokens = contextWindows.length === 0 ? undefined : Math.min(...contextWindows);
    return {
      baseUrl: gateway.address,
      authToken,
      defaultModelId: encodeModelId(selectedProvider.id, selectedModel.id),
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
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
