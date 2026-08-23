import { getEventListeners, once } from "node:events";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayServer, listenLocalGateway } from "../src/gateway.js";
import { decodeModelId, encodeModelId } from "../src/model-id.js";
import type { CanonicalStreamEvent, Provider } from "../src/provider-contract.js";

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
      return { input_tokens: 12, output_tokens: 0 };
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
    });
    expect(decodeModelId("claude-test")).toBeUndefined();
    expect(decodeModelId("polycode-anthropic/a/%ZZ")).toBeUndefined();
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
      payload: { model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 10, experimental: { x: 1 } },
    });

    expect(response.statusCode).toBe(200);
    expect(received).toMatchObject({ model: "claude-test", experimental: { x: 1 } });
    expect(response.body.match(/^event: .+$/gm)).toEqual([
      "event: message_start",
      "event: content_block_start",
      "event: content_block_delta",
      "event: content_block_stop",
      "event: message_delta",
      "event: message_stop",
    ]);
    expect(response.body).toContain('data: {"type":"message_stop"}');
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
      req.end(JSON.stringify({ model: modelId, messages: [], max_tokens: 1 }));
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
      payload: { model: modelId, messages: [], max_tokens: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(signal).toBeDefined();
    expect(getEventListeners(signal!, "abort")).toHaveLength(0);
  });
});
