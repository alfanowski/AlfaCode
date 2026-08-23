import { describe, expect, it } from "vitest";
import { AnthropicMessagesAdapter } from "../../src/providers/anthropic/index.js";
import type { ModelDescriptor } from "../../src/providers/foundation/index.js";
import type { ProviderMessageRequest } from "../../src/provider-contract.js";

const models: readonly ModelDescriptor[] = [{ providerId: "anthropic", id: "claude-test", displayName: "Claude Test", wireProtocol: "anthropic-messages", capabilities: { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: true, reasoningState: "optional", nativeTokenCounting: true, jsonSchema: "full" }, availability: "available", support: "contract-tested" }];
const request: ProviderMessageRequest = { model: "claude-test", max_tokens: 100, messages: [{ role: "user", content: "hello" }] };

describe("Anthropic Messages adapter", () => {
  it("passes through split SSE tool events without translating blocks", async () => {
    let signal: AbortSignal | null | undefined;
    const adapter = new AnthropicMessagesAdapter({
      id: "anthropic",
      apiKey: "anth-secret",
      models,
      baseUrl: "https://anth.example/v1",
      fetch: async (_input, init) => {
        signal = init?.signal;
        return sse([
          "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"claude-test\",\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n",
          "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool1\",\"name\":\"weather\",\"input\":{}}}\n\n",
          "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"city\\\":\\\"Rome\\\"}\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
          "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        ]);
      },
    });
    const controller = new AbortController();
    const events = await collect(adapter.streamMessage(request, { signal: controller.signal, session: "s", agent: "a" }));
    expect(signal).toBe(controller.signal);
    expect(events.map((event) => event.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(events[2]).toEqual({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":"Rome"}' } });
  });

  it("maps auth failures without leaking the key", async () => {
    const adapter = new AnthropicMessagesAdapter({ id: "anthropic", apiKey: "anth-secret", models, fetch: async () => new Response("bad key anth-secret", { status: 401 }) });
    await expect(collect(adapter.streamMessage(request, context()))).rejects.toMatchObject({ kind: "authentication", statusCode: 401 });
    await expect(collect(adapter.streamMessage(request, context()))).rejects.not.toThrow("anth-secret");
  });
});

function sse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
}
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of stream) values.push(value); return values; }
function context() { return { signal: new AbortController().signal, session: "s", agent: "a" }; }
