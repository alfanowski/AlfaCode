import { randomUUID } from "node:crypto";
import type {
  AnthropicUsage,
  CanonicalStreamEvent,
  Provider,
  ProviderMessageRequest,
  ProviderRequestContext,
  TokenCount,
} from "../../provider-contract.js";
import { readSse, unknownError, upstreamError } from "../http.js";
import type { ModelDescriptor, ProtocolStateStore } from "../foundation/types.js";

export interface AnthropicMessagesAdapterOptions {
  readonly id: string;
  readonly apiKey: string;
  readonly models: readonly ModelDescriptor[];
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Reserved for adapters requiring opaque continuation replay; no user prompts are written here. */
  readonly stateStore?: ProtocolStateStore;
}

/** Native Messages pass-through: it retains Anthropic blocks and SSE semantics without lossy translation. */
export class AnthropicMessagesAdapter implements Provider {
  public readonly models;
  private readonly endpoint: string;
  private readonly requestFetch: typeof fetch;

  public constructor(private readonly options: AnthropicMessagesAdapterOptions) {
    this.models = options.models.map((model) => ({ id: model.id, displayName: model.displayName }));
    this.endpoint = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    this.requestFetch = options.fetch ?? fetch;
  }

  public get id(): string { return this.options.id; }

  public async *streamMessage(request: ProviderMessageRequest, context: ProviderRequestContext): AsyncGenerator<CanonicalStreamEvent> {
    let response: Response;
    try {
      response = await this.requestFetch(`${this.endpoint}/messages`, {
        method: "POST",
        signal: context.signal,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ ...request, stream: true }),
      });
      if (!response.ok) throw upstreamError(response.status, await response.text(), this.options.apiKey);
      let sawStart = false;
      for await (const frame of readSse(response)) {
        if (frame.event === "ping") continue;
        const payload = parsePayload(frame.data, this.options.apiKey);
        if (payload.type === "error") throw upstreamError(payload.error?.status ?? 500, payload.error?.message ?? "Anthropic stream error", this.options.apiKey);
        const event = toCanonicalEvent(payload);
        if (!event) continue;
        sawStart ||= event.type === "message_start";
        yield event;
      }
      if (!sawStart) throw new Error("Anthropic stream ended before message_start");
    } catch (error: unknown) {
      throw unknownError(error, this.options.apiKey);
    }
  }

  public async countTokens(request: ProviderMessageRequest, context: ProviderRequestContext): Promise<TokenCount> {
    try {
      const response = await this.requestFetch(`${this.endpoint}/messages/count_tokens`, {
        method: "POST",
        signal: context.signal,
        headers: { "content-type": "application/json", "x-api-key": this.options.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw upstreamError(response.status, await response.text(), this.options.apiKey);
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.input_tokens !== "number") throw new Error("Anthropic count_tokens response is invalid");
      return { inputTokens: body.input_tokens, source: "provider", exact: true };
    } catch (error: unknown) {
      throw unknownError(error, this.options.apiKey);
    }
  }

  public async close(): Promise<void> {
    await this.options.stateStore?.close?.();
  }
}

type WirePayload = Record<string, unknown> & { type?: string; error?: { type?: string; message?: string; status?: number } };

function parsePayload(data: string, secret: string): WirePayload {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch (error: unknown) {
    throw unknownError(new Error(`Invalid Anthropic SSE payload: ${error instanceof Error ? error.message : String(error)}`), secret);
  }
}

function toCanonicalEvent(payload: WirePayload): CanonicalStreamEvent | undefined {
  switch (payload.type) {
    case "message_start": {
      const message = asRecord(payload.message);
      return {
        type: "message_start",
        message: {
          id: stringValue(message.id) ?? `msg_alfacode_${randomUUID().replaceAll("-", "")}`,
          type: "message",
          role: "assistant",
          model: stringValue(message.model) ?? "unknown",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: usage(asRecord(message.usage)),
        },
      };
    }
    case "content_block_start": {
      const block = asRecord(payload.content_block);
      const type = stringValue(block.type);
      const index = numberValue(payload.index);
      if (index === undefined || (type !== "text" && type !== "tool_use" && type !== "thinking")) return undefined;
      if (type === "text") return { type: "content_block_start", index, content_block: { type, text: stringValue(block.text) ?? "" } };
      if (type === "tool_use") return { type: "content_block_start", index, content_block: { type, id: stringValue(block.id) ?? "", name: stringValue(block.name) ?? "", input: recordValue(block.input) } };
      const signature = stringValue(block.signature);
      return { type: "content_block_start", index, content_block: { type, thinking: stringValue(block.thinking) ?? "", ...(signature === undefined ? {} : { signature }) } };
    }
    case "content_block_delta": {
      const delta = asRecord(payload.delta);
      const kind = stringValue(delta.type);
      const index = numberValue(payload.index);
      if (index === undefined || !kind) return undefined;
      if (kind === "text_delta") return { type: "content_block_delta", index, delta: { type: kind, text: stringValue(delta.text) ?? "" } };
      if (kind === "input_json_delta") return { type: "content_block_delta", index, delta: { type: kind, partial_json: stringValue(delta.partial_json) ?? "" } };
      if (kind === "thinking_delta") return { type: "content_block_delta", index, delta: { type: kind, thinking: stringValue(delta.thinking) ?? "" } };
      if (kind === "signature_delta") return { type: "content_block_delta", index, delta: { type: kind, signature: stringValue(delta.signature) ?? "" } };
      return undefined;
    }
    case "content_block_stop": {
      const index = numberValue(payload.index);
      return index === undefined ? undefined : { type: "content_block_stop", index };
    }
    case "message_delta": return { type: "message_delta", delta: { stop_reason: stringValue(asRecord(payload.delta).stop_reason) ?? null, stop_sequence: stringValue(asRecord(payload.delta).stop_sequence) ?? null }, usage: usage(asRecord(payload.usage)) };
    case "message_stop": return { type: "message_stop" };
    default: return undefined;
  }
}

function usage(value: Record<string, unknown>): AnthropicUsage {
  const cacheCreation = numberValue(value.cache_creation_input_tokens);
  const cacheRead = numberValue(value.cache_read_input_tokens);
  return {
    input_tokens: numberValue(value.input_tokens) ?? 0,
    output_tokens: numberValue(value.output_tokens) ?? 0,
    ...(cacheCreation === undefined ? {} : { cache_creation_input_tokens: cacheCreation }),
    ...(cacheRead === undefined ? {} : { cache_read_input_tokens: cacheRead }),
  };
}
function asRecord(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function recordValue(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
