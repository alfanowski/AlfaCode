import { getEventListeners, once } from "node:events";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer, listenLocalGateway } from "../src/gateway.js";
import { decodeModelId, encodeModelId } from "../src/model-id.js";
import type { CanonicalStreamEvent, Provider } from "../src/provider-contract.js";
import { UsageLedger } from "../src/usage-ledger.js";

const modelId = encodeModelId("mock", "claude-test");
const events: readonly CanonicalStreamEvent[] = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 3, output_tokens: 1 } },
  { type: "message_stop" },
];

function fakeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "mock",
    models: [{ id: "claude-test", displayName: "Claude Test" }],
    async *streamMessage() {
      yield* events;
    },
    async countTokens() {
      return { inputTokens: 12, source: "provider" as const, exact: true };
    },
    close() {},
    ...overrides,
  };
}

const openApps: ReturnType<typeof createGatewayServer>[] = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

function app(provider = fakeProvider()) {
  const server = createGatewayServer({ token: "test-token", providers: [provider], pingIntervalMs: 50 });
  openApps.push(server);
  return server;
}

function authorizedHeaders() {
  return { authorization: "Bearer test-token" };
}

function systemText(request: unknown): string {
  if (typeof request !== "object" || request === null || !("system" in request)) return "";
  const system = request.system;
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.flatMap((block) => typeof block === "object" && block !== null && "text" in block && typeof block.text === "string" ? [block.text] : []).join("\n");
}

describe("Anthropic gateway", () => {
  it("rejects absent, malformed, and invalid credentials without exposing details", async () => {
    for (const headers of [{}, { authorization: "Basic test-token" }, { "x-api-key": "wrong" }]) {
      const response = await app().inject({ method: "GET", url: "/v1/models", headers });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ type: "error", error: { type: "authentication_error", message: "Unauthorized" } });
    }

    const response = await app().inject({ method: "HEAD", url: "/api/hello", headers: { "x-api-key": "test-token" } });
    expect(response.statusCode).toBe(204);
  });

  it("listens only on a loopback ephemeral address", async () => {
    const { app: server, address } = await listenLocalGateway({ token: "test-token", providers: [fakeProvider()] });
    try {
      expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await server.close();
    }
  });

  it("lists prewarmed models without provider activity", async () => {
    const response = await app().inject({ method: "GET", url: "/v1/models?limit=1000", headers: authorizedHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [{ id: modelId, type: "model", display_name: "Claude Test" }],
      has_more: false,
    });
  });

  it("round-trips routed model IDs and rejects malformed IDs", () => {
    expect(decodeModelId(encodeModelId("provider_1", "vendor/model:1"))).toEqual({
      providerId: "provider_1",
      upstreamModel: "vendor/model:1",
      extendedContext: false,
    });
    expect(decodeModelId(`${encodeModelId("provider_1", "vendor/model:1")}[1m]`)).toEqual({
      providerId: "provider_1",
      upstreamModel: "vendor/model:1",
      extendedContext: true,
    });
    expect(decodeModelId("claude-test")).toBeUndefined();
    expect(decodeModelId("alfacode-anthropic/a/%ZZ")).toBeUndefined();
  });

  it("records final cumulative usage without emitting a private SSE event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alfacode-gateway-usage-"));
    const ledger = await UsageLedger.open(directory);
    const provider = fakeProvider({
      async *streamMessage() {
        yield events[0]!;
        yield { type: "usage", usage: { semantics: "cumulative", stage: "interim", source: "provider", inputTokens: 2, outputTokens: 1 } };
        yield { type: "usage", usage: { semantics: "cumulative", stage: "final", source: "provider", inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
        yield events[5]!;
      },
    });
    const server = createGatewayServer({ token: "test-token", providers: [provider], usageLedger: ledger });
    try {
      const response = await server.inject({ method: "POST", url: "/v1/messages", headers: { ...authorizedHeaders(), "x-claude-code-session-id": "session-private", "x-claude-code-agent-id": "subagent" }, payload: { model: modelId, messages: [], max_tokens: 10, stream: true } });
      expect(response.body).not.toContain("event: usage");
      expect((await ledger.query({ session: "session-private" })).attempts[0]).toMatchObject({ outcome: "completed", usageCompleteness: "final", inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    } finally {
      await server.close();
      await ledger.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records failed-before-output and partial-after-output attempts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alfacode-gateway-failures-"));
    const ledger = await UsageLedger.open(directory);
    const before = createGatewayServer({ token: "test-token", providers: [fakeProvider({
      async *streamMessage() { throw { kind: "api", message: "upstream failed" }; },
    })], usageLedger: ledger });
    const after = createGatewayServer({ token: "test-token", providers: [fakeProvider({
      async *streamMessage() { yield events[0]!; throw { kind: "api", message: "upstream failed" }; },
    })], usageLedger: ledger });
    try {
      const payload = { model: modelId, messages: [], max_tokens: 10, stream: true };
      expect((await before.inject({ method: "POST", url: "/v1/messages", headers: authorizedHeaders(), payload })).statusCode).toBe(500);
      const streamed = await after.inject({ method: "POST", url: "/v1/messages", headers: authorizedHeaders(), payload });
      expect(streamed.body).toContain("event: error");
      expect((await ledger.query()).attempts.map((attempt) => attempt.outcome).sort()).toEqual(["failed", "partial"]);
    } finally {
      await before.close();
      await after.close();
      await ledger.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("feeds live availability failures back to automatic selection", async () => {
    const outcomes: Array<{ providerId: string; modelId: string; statusCode: number; retryAfter?: string | number }> = [];
    const server = createGatewayServer({
      token: "test-token",
      providers: [fakeProvider({ async *streamMessage() { throw { kind: "rate_limit", message: "busy", statusCode: 429, retryAfter: 14_125 }; } })],
      onProviderOutcome: async (outcome) => { outcomes.push(outcome); },
    });
    try {
      const response = await server.inject({ method: "POST", url: "/v1/messages", headers: authorizedHeaders(), payload: { model: modelId, messages: [], max_tokens: 10, stream: true } });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("15");
      expect(outcomes).toEqual([{ providerId: "mock", modelId: "claude-test", statusCode: 429, retryAfter: 14_125 }]);
    } finally { await server.close(); }
  });

  it("fails over on an overloaded model before output even after keepalive pings", async () => {
    const exhausted = fakeProvider({ id: "exhausted", models: [{ id: "model-a" }], async *streamMessage() { await new Promise((resolve) => setTimeout(resolve, 10)); throw { kind: "overloaded", message: "busy", statusCode: 503 }; } });
    let receivedByFallback: unknown;
    const healthy = fakeProvider({ id: "healthy", models: [{ id: "model-b" }], async *streamMessage(request) { receivedByFallback = request; yield* events; } });
    const failures: string[] = [];
    const server = createGatewayServer({
      token: "test-token", providers: [exhausted, healthy], pingIntervalMs: 1,
      onProviderOutcome: async (failure) => { failures.push(`${failure.providerId}/${failure.modelId}`); },
      selectFallback: async () => ({ provider: healthy, model: healthy.models[0]! }),
    });
    try {
      const response = await server.inject({ method: "POST", url: "/v1/messages", headers: authorizedHeaders(), payload: { model: encodeModelId("exhausted", "model-a"), messages: [], max_tokens: 10, stream: true } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("event: ping");
      expect(response.body).toContain('"text":"hello"');
      expect(response.body).toContain(`"model":"${encodeModelId("healthy", "model-b")}"`);
      expect(failures).toEqual(["exhausted/model-a"]);
      expect(systemText(receivedByFallback)).toContain('Active provider ID: "healthy"');
      expect(systemText(receivedByFallback)).toContain('Active model ID: "model-b"');
      expect(systemText(receivedByFallback)).not.toContain('Active model ID: "model-a"');
    } finally { await server.close(); }
  });

  it("fails over non-streaming retries without returning a streamed response", async () => {
    const exhausted = fakeProvider({ id: "exhausted", models: [{ id: "model-a" }], async *streamMessage() { throw { kind: "overloaded", message: "busy", statusCode: 503 }; } });
    const healthy = fakeProvider({ id: "healthy", models: [{ id: "model-b" }] });
    const server = createGatewayServer({
      token: "test-token", providers: [exhausted, healthy],
      selectFallback: async () => ({ provider: healthy, model: healthy.models[0]! }),
    });
    try {
      const response = await server.inject({ method: "POST", url: "/v1/messages", headers: authorizedHeaders(), payload: { model: encodeModelId("exhausted", "model-a"), messages: [], max_tokens: 10, stream: false } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toMatchObject({ model: encodeModelId("healthy", "model-b"), content: [{ text: "hello" }] });
    } finally { await server.close(); }
  });

  it("forwards unknown fields and translates canonical events in exact SSE order", async () => {
    let received: unknown;
    const response = await app(fakeProvider({
      async *streamMessage(request) {
        received = request;
        yield* events;
      },
    })).inject({
      method: "POST",
      url: "/v1/messages?beta=true",
      headers: authorizedHeaders(),
      payload: { model: modelId, messages: [{ role: "user", content: "hi" }], system: "Original system", max_tokens: 10, stream: true, experimental: { x: 1 } },
    });

    expect(response.statusCode).toBe(200);
    expect(received).toMatchObject({ model: "claude-test", experimental: { x: 1 } });
    expect(systemText(received)).toContain("Original system");
    expect(systemText(received)).toContain("AlfaCode is the terminal tool");
    expect(systemText(received)).toContain("Never claim 'AlfaCode' is your own identity");
    expect(systemText(received)).toContain('Active provider ID: "mock"');
    expect(systemText(received)).toContain('Active model ID: "claude-test"');
    expect(response.body.match(/^event: .+$/gm)).toEqual([
      "event: message_start",
      "event: content_block_start",
      "event: content_block_delta",
      "event: content_block_stop",
      "event: message_delta",
      "event: message_stop",
    ]);
    expect(response.body).toContain('data: {"type":"message_stop"}');
    expect(response.headers["request-id"]).toMatch(/^req_[a-f0-9]+$/);
  });

  it("returns a JSON message for non-streaming requests and assembles tool input", async () => {
    const toolEvents: readonly CanonicalStreamEvent[] = [
      events[0]!,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_1", name: "Read", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'path":"README.md"}' } },
      { type: "content_block_stop", index: 1 },
      events[4]!,
      events[5]!,
    ];
    const response = await app(fakeProvider({
      async *streamMessage() {
        yield* toolEvents;
      },
    })).inject({
      method: "POST",
      url: "/v1/messages",
      headers: authorizedHeaders(),
      payload: { model: modelId, messages: [], max_tokens: 10, stream: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "hi there" },
        { type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "README.md" } },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });

  it("returns Anthropic-shaped validation and token-count responses", async () => {
    const invalid = await app().inject({
      method: "POST",
      url: "/v1/messages",
      headers: authorizedHeaders(),
      payload: { messages: [] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "Invalid message request" } });

    const counted = await app().inject({
      method: "POST",
      url: "/v1/messages/count_tokens",
      headers: authorizedHeaders(),
      payload: { model: modelId, messages: [{ role: "user", content: "hi" }] },
    });
    expect(counted.statusCode).toBe(200);
    expect(counted.json()).toEqual({ input_tokens: 12 });
  });

  it("aborts the provider when a streaming client disconnects", async () => {
    let aborted = false;
    const provider = fakeProvider({
      async *streamMessage(_request, context) {
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        aborted = context.signal.aborted;
      },
    });
    const { app: server, address } = await listenLocalGateway({ token: "test-token", providers: [provider], pingIntervalMs: 5 });
    try {
      const url = new URL("/v1/messages", address);
      const req = httpRequest(url, {
        method: "POST",
        headers: { ...authorizedHeaders(), "content-type": "application/json" },
      });
      req.end(JSON.stringify({ model: modelId, messages: [], max_tokens: 1, stream: true }));
      await once(req, "response");
      req.destroy();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(aborted).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("removes per-chunk abort listeners after successful streaming", async () => {
    let signal: AbortSignal | undefined;
    const response = await app(fakeProvider({
      async *streamMessage(_request, context) {
        signal = context.signal;
        for (let index = 0; index < 25; index += 1) yield events[2]!;
      },
    })).inject({
      method: "POST",
      url: "/v1/messages",
      headers: authorizedHeaders(),
      payload: { model: modelId, messages: [], max_tokens: 1, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(signal).toBeDefined();
    expect(getEventListeners(signal!, "abort")).toHaveLength(0);
  });
});
