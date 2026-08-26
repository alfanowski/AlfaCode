import { describe, expect, it } from "vitest";
import { OpenAIResponsesAdapter } from "../../src/providers/openai/index.js";
import { MemoryProtocolStateStore, type ModelDescriptor } from "../../src/providers/foundation/index.js";

const models: readonly ModelDescriptor[] = [{ providerId: "responses", id: "model-r", displayName: "Model R", wireProtocol: "openai-responses", capabilities: { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: true, reasoningState: "required", nativeTokenCounting: true, jsonSchema: "full" }, availability: "available", support: "best-effort" }];

describe("OpenAI Responses adapter", () => {
  it("maps tool inputs, completes function calls, and replays opaque output only for results", async () => {
    const bodies: unknown[] = [];
    const redirects: Array<RequestRedirect | undefined> = [];
    const stateStore = new MemoryProtocolStateStore();
    const adapter = new OpenAIResponsesAdapter({
      id: "responses", apiKey: "responses-secret", models, baseUrl: "https://responses.example/v1", stateStore,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        redirects.push(init?.redirect);
        return sse(bodies.length === 1 ? [
          "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp-1\"}}\n\n",
          "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call-1\",\"name\":\"weather\",\"arguments\":\"\"}}\n\n",
          "data: {\"type\":\"response.function_call_arguments.delta\",\"call_id\":\"call-1\",\"delta\":\"{\\\"city\\\":\\\"Rome\\\"}\"}\n\n",
          "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"function_call\",\"call_id\":\"call-1\",\"name\":\"weather\",\"arguments\":\"{\\\"city\\\":\\\"Rome\\\"}\"}],\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}\n\n",
        ] : ["data: {\"type\":\"response.completed\",\"response\":{\"output\":[],\"usage\":{}}}\n\n"]);
      },
    });
    const first = await collect(adapter.streamMessage({ model: "model-r", system: "Use tools.", messages: [{ role: "user", content: "weather" }], tools: [{ name: "weather", description: "Lookup weather", input_schema: { type: "object" } }], tool_choice: { type: "any" } }, context()));
    expect(bodies[0]).toMatchObject({ instructions: "Use tools.", tools: [{ type: "function", name: "weather" }], tool_choice: "required", input: [{ role: "user", content: "weather" }] });
    expect(first).toContainEqual({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":"Rome"}' } });
    expect(first).toContainEqual({ type: "usage", usage: { semantics: "cumulative", stage: "final", source: "provider", inputTokens: 3, outputTokens: 2 } });
    expect(first.at(-2)).toEqual({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 3, output_tokens: 2 } });

    await collect(adapter.streamMessage({ model: "model-r", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "sunny" }] }] }, context()));
    expect(bodies[1]).toMatchObject({ input: [{ type: "function_call", call_id: "call-1" }, { type: "function_call_output", call_id: "call-1", output: "sunny" }] });
    expect(redirects).toEqual(["manual", "manual"]);
  });
});

function sse(chunks: readonly string[]): Response { const encoder = new TextEncoder(); return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } }); }
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of stream) values.push(value); return values; }
function context() { return { signal: new AbortController().signal, session: "s", agent: "a" }; }
