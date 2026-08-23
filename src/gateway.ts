import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { decodeModelId, encodeModelId } from "./model-id.js";
import {
  type CanonicalStreamEvent,
  type Provider,
  type ProviderError,
  type ProviderModel,
  type ProviderMessageRequest,
  providerError,
} from "./provider-contract.js";
import { type AttemptOutcome, type UsageLedger } from "./usage-ledger.js";

const MESSAGE_REQUEST = z.object({
  model: z.string().min(1),
  messages: z.array(z.unknown()),
  max_tokens: z.number().int().nonnegative().optional(),
  stream: z.boolean().optional(),
}).passthrough();

const STREAMING_MESSAGE_REQUEST = MESSAGE_REQUEST.extend({
  max_tokens: z.number().int().nonnegative(),
}).passthrough();

type MessageRequest = z.output<typeof MESSAGE_REQUEST>;

export interface GatewayOptions {
  readonly token: string;
  readonly providers: readonly Provider[];
  readonly pingIntervalMs?: number;
  readonly usageLedger?: UsageLedger;
}

interface AnthropicErrorEnvelope {
  readonly type: "error";
  readonly error: { readonly type: string; readonly message: string };
}

export function createGatewayServer(options: GatewayOptions): FastifyInstance {
  if (options.token.length === 0) {
    throw new Error("Gateway bearer token must not be empty");
  }

  const providers = new Map(options.providers.map((provider) => [provider.id, provider]));
  if (providers.size !== options.providers.length) {
    throw new Error("Provider identifiers must be unique");
  }
  const pingIntervalMs = options.pingIntervalMs ?? 15_000;
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (request, reply) => {
    if (!constantTimeAuthorized(request, options.token)) {
      await reply.code(401).send(anthropicError("authentication_error", "Unauthorized"));
    }
  });

  app.head("/api/hello", async (_request, reply) => reply.code(204).send());

  app.get("/v1/models", async (request, reply) => {
    const limit = parseLimit(request.query);
    if (limit === undefined) {
      return reply.code(400).send(anthropicError("invalid_request_error", "Invalid limit"));
    }

    const allModels = options.providers.flatMap((provider) => provider.models.map((model) => ({
      type: "model" as const,
      id: encodeModelId(provider.id, model.id),
      display_name: model.displayName ?? model.id,
      created_at: model.createdAt ?? "1970-01-01T00:00:00Z",
    })));
    const data = allModels.slice(0, limit);
    return {
      data,
      has_more: data.length < allModels.length,
      first_id: data[0]?.id ?? null,
      last_id: data.at(-1)?.id ?? null,
    };
  });

  app.post("/v1/messages", async (request, reply) => {
    const parsed = STREAMING_MESSAGE_REQUEST.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(anthropicError("invalid_request_error", "Invalid message request"));
    }

    const resolved = resolveProviderRequest(parsed.data, providers);
    if (!resolved.ok) {
      return reply.code(resolved.status).send(anthropicError(resolved.errorType, resolved.message));
    }

    const requestId = `req_${randomUUID().replaceAll("-", "")}`;
    reply.raw.setHeader("request-id", requestId);
    reply.raw.setHeader("x-request-id", requestId);
    if (parsed.data.stream !== true) {
      const controller = new AbortController();
      request.raw.once("aborted", () => controller.abort());
      const context = providerContext(request, controller.signal);
      const tracker = await startAttempt(options.usageLedger, resolved.provider, resolved.model, parsed.data.model, resolved.extendedContext, resolved.request, context);
      try {
        const response = await collectResponse(
          resolved.provider,
          resolved.request,
          context,
          async (usage) => tracker.observe(usage),
        );
        await tracker.finish(tracker.hasFinalUsage ? "completed" : "partial", true);
        return response;
      } catch (error) {
        await tracker.finish(controller.signal.aborted ? "cancelled" : "failed", false, errorClass(error));
        const normalized = normalizeProviderError(error);
        return reply.code(normalized.status).send(normalized.body);
      }
    }

    reply.hijack();
    await streamResponse(reply.raw, request, resolved.provider, resolved.model, parsed.data.model, resolved.extendedContext, resolved.request, pingIntervalMs, options.usageLedger);
  });

  app.post("/v1/messages/count_tokens", async (request, reply) => {
    const parsed = MESSAGE_REQUEST.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(anthropicError("invalid_request_error", "Invalid token-count request"));
    }

    const resolved = resolveProviderRequest(parsed.data, providers);
    if (!resolved.ok) {
      return reply.code(resolved.status).send(anthropicError(resolved.errorType, resolved.message));
    }

    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    try {
      const usage = await resolved.provider.countTokens(resolved.request, providerContext(request, controller.signal));
      return { input_tokens: usage.inputTokens };
    } catch (error) {
      const normalized = normalizeProviderError(error);
      return reply.code(normalized.status).send(normalized.body);
    }
  });

  app.addHook("onClose", async () => {
    await Promise.all(options.providers.map(async (provider) => provider.close()));
  });

  return app;
}

async function collectResponse(
  provider: Provider,
  providerRequest: ProviderMessageRequest,
  context: ReturnType<typeof providerContext>,
  onUsage: (usage: import("./provider-contract.js").UsageSnapshot) => Promise<void>,
): Promise<Record<string, unknown>> {
  let id: string | undefined;
  let model = providerRequest.model;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason: string | null = null;
  let stopSequence: string | null = null;
  const blocks = new Map<number, {
    block: Record<string, unknown>;
    inputJson: string;
  }>();

  for await (const event of provider.streamMessage(providerRequest, context)) {
    if (event.type === "usage") {
      await onUsage(event.usage);
      continue;
    }
    if (event.type === "message_start") {
      id = event.message.id;
      model = event.message.model;
      usage = event.message.usage;
      continue;
    }
    if (event.type === "content_block_start") {
      blocks.set(event.index, { block: { ...event.content_block }, inputJson: "" });
      continue;
    }
    if (event.type === "content_block_delta") {
      const current = blocks.get(event.index);
      if (current === undefined) throw new Error(`Provider emitted a delta for unopened block ${event.index}`);
      if (event.delta.type === "text_delta") {
        current.block.text = `${typeof current.block.text === "string" ? current.block.text : ""}${event.delta.text}`;
      } else if (event.delta.type === "thinking_delta") {
        current.block.thinking = `${typeof current.block.thinking === "string" ? current.block.thinking : ""}${event.delta.thinking}`;
      } else if (event.delta.type === "signature_delta") {
        current.block.signature = `${typeof current.block.signature === "string" ? current.block.signature : ""}${event.delta.signature}`;
      } else {
        current.inputJson += event.delta.partial_json;
      }
      continue;
    }
    if (event.type === "content_block_stop") {
      const current = blocks.get(event.index);
      if (current?.block.type === "tool_use" && current.inputJson.length > 0) {
        try {
          current.block.input = JSON.parse(current.inputJson) as unknown;
        } catch {
          throw { kind: "api", message: "Upstream provider returned malformed tool input" } satisfies ProviderError;
        }
      }
      continue;
    }
    if (event.type === "message_delta") {
      usage = event.usage;
      stopReason = event.delta.stop_reason ?? stopReason;
      stopSequence = event.delta.stop_sequence ?? stopSequence;
    }
  }

  if (id === undefined) {
    throw { kind: "api", message: "Upstream provider returned an empty response" } satisfies ProviderError;
  }
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [...blocks.entries()].sort(([left], [right]) => left - right).map(([, value]) => value.block),
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    usage,
  };
}

/** The only production listen helper: loopback and an OS-assigned port are intentional. */
export async function listenLocalGateway(options: GatewayOptions): Promise<{ app: FastifyInstance; address: string }> {
  const app = createGatewayServer(options);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, address };
}

function constantTimeAuthorized(request: FastifyRequest, expectedToken: string): boolean {
  const authorization = headerValue(request.headers.authorization);
  const apiKey = headerValue(request.headers["x-api-key"]);
  const candidate = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : apiKey;
  if (candidate === undefined || candidate.length === 0) {
    return false;
  }

  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(candidate);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function headerValue(header: string | string[] | undefined): string | undefined {
  return typeof header === "string" ? header : undefined;
}

function parseLimit(query: unknown): number | undefined {
  if (typeof query !== "object" || query === null || !("limit" in query) || query.limit === undefined) {
    return 1000;
  }
  const value = query.limit;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 1000) : undefined;
}

function resolveProviderRequest(
  request: MessageRequest,
  providers: ReadonlyMap<string, Provider>,
):
  | { readonly ok: true; readonly provider: Provider; readonly model: ProviderModel; readonly extendedContext: boolean; readonly request: ProviderMessageRequest }
  | { readonly ok: false; readonly status: number; readonly errorType: string; readonly message: string } {
  const decoded = decodeModelId(request.model);
  if (decoded === undefined) {
    return { ok: false, status: 400, errorType: "invalid_request_error", message: "Invalid model identifier" };
  }
  const provider = providers.get(decoded.providerId);
  const model = provider?.models.find((candidate) => candidate.id === decoded.upstreamModel);
  if (provider === undefined || model === undefined) {
    return { ok: false, status: 404, errorType: "not_found_error", message: "Model not found" };
  }

  return { ok: true, provider, model, extendedContext: decoded.extendedContext, request: { ...request, model: decoded.upstreamModel } };
}

async function streamResponse(
  response: ServerResponse,
  request: FastifyRequest,
  provider: Provider,
  providerModel: ProviderModel,
  routeModelId: string,
  extendedContext: boolean,
  providerRequest: ProviderMessageRequest,
  pingIntervalMs: number,
  ledger: UsageLedger | undefined,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  response.once("close", abort);

  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  const context = providerContext(request, controller.signal);
  const tracker = await startAttempt(ledger, provider, providerModel, routeModelId, extendedContext, providerRequest, context);
  let outputStarted = false;
  let outcome: AttemptOutcome = "partial";
  let failureClass: string | undefined;
  let pendingNext: Promise<IteratorResult<CanonicalStreamEvent>> | undefined;
  const iterator = provider.streamMessage(providerRequest, context)[Symbol.asyncIterator]();
  try {
    while (!controller.signal.aborted) {
      pendingNext ??= iterator.next();
      const next = await nextOrPing(pendingNext, pingIntervalMs, controller.signal);
      if (next === "ping") {
        outputStarted = true;
        await write(response, sse("ping", { type: "ping" }), controller.signal);
        continue;
      }
      pendingNext = undefined;
      if (next.done) {
        outcome = tracker.hasFinalUsage ? "completed" : "partial";
        break;
      }
      if (next.value.type === "usage") {
        await tracker.observe(next.value.usage);
        continue;
      }
      outputStarted = true;
      await write(response, serializeEvent(next.value), controller.signal);
    }
  } catch (error) {
    failureClass = errorClass(error);
    outcome = controller.signal.aborted ? "cancelled" : outputStarted ? "partial" : "failed";
    if (!controller.signal.aborted) {
      const normalized = normalizeProviderError(error);
      if (!outputStarted) {
        response.statusCode = normalized.status;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify(normalized.body));
      } else {
        // Anthropic sends in-band errors once an SSE response has begun.
        await write(response, sse("error", normalized.body), controller.signal).catch(() => undefined);
      }
    }
  } finally {
    request.raw.removeListener("aborted", abort);
    response.removeListener("close", abort);
    await iterator.return?.().catch(() => undefined);
    if (!response.writableEnded) {
      response.end();
    }
    await tracker.finish(controller.signal.aborted ? "cancelled" : outcome, outputStarted, failureClass);
  }

}

function providerContext(request: FastifyRequest, signal: AbortSignal): import("./provider-contract.js").ProviderRequestContext {
  const parentAgent = headerValue(request.headers["x-claude-code-parent-agent-id"]);
  return {
    signal,
    session: headerValue(request.headers["x-claude-code-session-id"]) ?? "default",
    agent: headerValue(request.headers["x-claude-code-agent-id"]) ?? "main",
    ...(parentAgent === undefined ? {} : { parentAgent }),
  };
}

interface AttemptTracker {
  readonly hasFinalUsage: boolean;
  observe(usage: import("./provider-contract.js").UsageSnapshot): Promise<void>;
  finish(outcome: AttemptOutcome, responseStarted: boolean, errorClass?: string): Promise<void>;
}

async function startAttempt(
  ledger: UsageLedger | undefined,
  provider: Provider,
  model: ProviderModel,
  routeModelId: string,
  extendedContext: boolean,
  request: ProviderMessageRequest,
  context: ReturnType<typeof providerContext>,
): Promise<AttemptTracker> {
  if (ledger === undefined) {
    return { hasFinalUsage: false, observe: async () => undefined, finish: async () => undefined };
  }
  const attempt = await ledger.start({
    session: context.session, agent: context.agent, ...(context.parentAgent === undefined ? {} : { parentAgent: context.parentAgent }),
    providerId: provider.id, routeModelId, upstreamModel: model.id, model, extendedContext,
    ...(request.max_tokens === undefined ? {} : { requestedOutputTokens: request.max_tokens }),
  });
  let hasFinalUsage = false;
  return {
    get hasFinalUsage() { return hasFinalUsage; },
    observe: async (usage) => {
      if (usage.stage === "final") hasFinalUsage = true;
      await ledger.observe(attempt, usage);
    },
    finish: async (outcome, responseStarted, error) => ledger.finish(attempt, outcome, responseStarted, error),
  };
}

function errorClass(error: unknown): string {
  const known = providerError(error);
  return known?.kind ?? "api";
}

async function nextOrPing<T>(
  next: Promise<IteratorResult<T>>,
  intervalMs: number,
  signal: AbortSignal,
): Promise<IteratorResult<T> | "ping"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const ping = new Promise<"ping">((resolve) => {
    timeout = setTimeout(() => resolve("ping"), intervalMs);
  });
  let rejectAbort: ((error: Error) => void) | undefined;
  const onAbort = () => rejectAbort?.(new Error("Client disconnected"));
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    if (signal.aborted) reject(new Error("Client disconnected"));
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([next, ping, aborted]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    signal.removeEventListener("abort", onAbort);
  }
}

function serializeEvent(event: CanonicalStreamEvent): string {
  const { type, ...data } = event;
  return sse(type, { type, ...data });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function write(response: ServerResponse, chunk: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || response.destroyed) {
    throw new Error("Client disconnected");
  }
  if (response.write(chunk)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => finish(resolve);
    const onClose = () => finish(() => reject(new Error("Client disconnected")));
    const onAbort = () => finish(() => reject(new Error("Client disconnected")));
    const finish = (callback: () => void) => {
      response.removeListener("drain", onDrain);
      response.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function anthropicError(type: string, message: string): AnthropicErrorEnvelope {
  return { type: "error", error: { type, message } };
}

function normalizeProviderError(error: unknown): { readonly status: number; readonly body: AnthropicErrorEnvelope } {
  const known = providerError(error);
  const failure: ProviderError = known ?? { kind: "api", message: "Upstream provider failed" };
  const mapping: Record<ProviderError["kind"], readonly [number, string]> = {
    authentication: [401, "authentication_error"],
    permission: [403, "permission_error"],
    not_found: [404, "not_found_error"],
    rate_limit: [429, "rate_limit_error"],
    overloaded: [529, "overloaded_error"],
    invalid_request: [400, "invalid_request_error"],
    api: [500, "api_error"],
  };
  const [defaultStatus, errorType] = mapping[failure.kind];
  const status = failure.statusCode !== undefined && failure.statusCode >= 400 && failure.statusCode <= 599
    ? failure.statusCode
    : defaultStatus;
  return { status, body: anthropicError(errorType, failure.message) };
}
