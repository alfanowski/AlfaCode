/**
 * The provider boundary intentionally has no Fastify or Anthropic SDK types.
 * Providers produce the canonical event sequence below and the gateway owns
 * translating it to the wire format.
 */

export type AnthropicContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | { readonly type: "thinking"; readonly thinking: string; readonly signature?: string };

export type AnthropicContentDelta =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "input_json_delta"; readonly partial_json: string }
  | { readonly type: "thinking_delta"; readonly thinking: string }
  | { readonly type: "signature_delta"; readonly signature: string };

export interface AnthropicUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

export interface AnthropicMessageStart {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly model: string;
  readonly content: readonly [];
  readonly stop_reason: null;
  readonly stop_sequence: null;
  readonly usage: AnthropicUsage;
}

/** Every event maps one-to-one to an Anthropic SSE event of the same name. */
export type CanonicalStreamEvent =
  | { readonly type: "message_start"; readonly message: AnthropicMessageStart }
  | {
      readonly type: "content_block_start";
      readonly index: number;
      readonly content_block: AnthropicContentBlock;
    }
  | { readonly type: "content_block_delta"; readonly index: number; readonly delta: AnthropicContentDelta }
  | { readonly type: "content_block_stop"; readonly index: number }
  | {
      readonly type: "message_delta";
      readonly delta: { readonly stop_reason?: string | null; readonly stop_sequence?: string | null };
      readonly usage: AnthropicUsage;
    }
  | { readonly type: "message_stop" };

export interface ProviderModel {
  /** The provider-native model name, without the alfacode-anthropic prefix. */
  readonly id: string;
  readonly displayName?: string;
  readonly createdAt?: string;
}

/** Unknown request properties are preserved deliberately for provider-specific options. */
export interface ProviderMessageRequest {
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly max_tokens?: number | undefined;
  readonly stream?: boolean | undefined;
  readonly [key: string]: unknown;
}

export interface ProviderRequestContext {
  /** Aborts immediately when the downstream Anthropic client disconnects. */
  readonly signal: AbortSignal;
  /** Claude Code session identifiers keep provider-side tool state isolated. */
  readonly session: string;
  readonly agent: string;
}

export interface ProviderError {
  readonly kind:
    | "authentication"
    | "permission"
    | "not_found"
    | "rate_limit"
    | "overloaded"
    | "invalid_request"
    | "api";
  readonly message: string;
  readonly statusCode?: number;
}

export interface Provider {
  readonly id: string;
  /** This catalog is prewarmed at provider construction; listing must not make network calls. */
  readonly models: readonly ProviderModel[];
  streamMessage(
    request: ProviderMessageRequest,
    context: ProviderRequestContext,
  ): AsyncIterable<CanonicalStreamEvent>;
  countTokens(request: ProviderMessageRequest, context: ProviderRequestContext): Promise<AnthropicUsage>;
  close(): Promise<void> | void;
}

export function providerError(error: unknown): ProviderError | undefined {
  if (typeof error !== "object" || error === null || !("kind" in error) || !("message" in error)) {
    return undefined;
  }

  const candidate = error as Partial<ProviderError>;
  const allowedKinds = new Set<ProviderError["kind"]>([
    "authentication",
    "permission",
    "not_found",
    "rate_limit",
    "overloaded",
    "invalid_request",
    "api",
  ]);
  return typeof candidate.kind === "string" && allowedKinds.has(candidate.kind as ProviderError["kind"])
    && typeof candidate.message === "string"
    ? (candidate as ProviderError)
    : undefined;
}
