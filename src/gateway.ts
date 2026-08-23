import { timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { decodeModelId, encodeModelId } from "./model-id.js";
import {
  type CanonicalStreamEvent,
  type Provider,
  type ProviderError,
  type ProviderMessageRequest,
  providerError,
} from "./provider-contract.js";

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

    reply.hijack();
    await streamResponse(reply.raw, request, resolved.provider, resolved.request, pingIntervalMs);
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
      return { input_tokens: usage.input_tokens };
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
  | { readonly ok: true; readonly provider: Provider; readonly request: ProviderMessageRequest }
  | { readonly ok: false; readonly status: number; readonly errorType: string; readonly message: string } {
  const decoded = decodeModelId(request.model);
  if (decoded === undefined) {
    return { ok: false, status: 400, errorType: "invalid_request_error", message: "Invalid model identifier" };
  }
  const provider = providers.get(decoded.providerId);
  if (provider === undefined || !provider.models.some((model) => model.id === decoded.upstreamModel)) {
    return { ok: false, status: 404, errorType: "not_found_error", message: "Model not found" };
  }

  return { ok: true, provider, request: { ...request, model: decoded.upstreamModel } };
}

async function streamResponse(
  response: ServerResponse,
  request: FastifyRequest,
  provider: Provider,
  providerRequest: ProviderMessageRequest,
  pingIntervalMs: number,
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
  let outputStarted = false;
  let pendingNext: Promise<IteratorResult<CanonicalStreamEvent>> | undefined;
  const iterator = provider.streamMessage(providerRequest, providerContext(request, controller.signal))[Symbol.asyncIterator]();
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
        break;
      }
      outputStarted = true;
      await write(response, serializeEvent(next.value), controller.signal);
    }
  } catch (error) {
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
  }

}

function providerContext(request: FastifyRequest, signal: AbortSignal) {
  return {
    signal,
    session: headerValue(request.headers["x-claude-code-session-id"]) ?? "default",
    agent: headerValue(request.headers["x-claude-code-agent-id"]) ?? "main",
  };
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
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Client disconnected")), { once: true });
  });
  try {
    return await Promise.race([next, ping, aborted]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
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
