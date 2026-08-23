import { describe, expect, it } from "vitest";
import { OpenAIChatAdapter } from "../../src/providers/openai/index.js";
import type { ModelDescriptor } from "../../src/providers/foundation/index.js";

const models: readonly ModelDescriptor[] = [{ providerId: "compat", id: "model-a", displayName: "Model A", wireProtocol: "openai-chat", capabilities: { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: true, reasoningState: "optional", nativeTokenCounting: false, jsonSchema: "full" }, availability: "available", support: "contract-tested" }];

describe("OpenAI Chat adapter", () => {
  it("assembles fragmented parallel tool calls and maps usage", async () => {
    let body = "";
    const adapter = new OpenAIChatAdapter({
      id: "compat", apiKey: "chat-secret", models, baseUrl: "https://chat.example/v1",
      fetch: async (_input, init) => { body = String(init?.body); return sse([
        "data: {\"id\":\"chat-1\",\"choices\":[{\"delta\":{\"content\":\"Checking \"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-a\",\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"city\\\":\"}},{\"index\":1,\"id\":\"call-b\",\"type\":\"function\",\"function\":{\"name\":\"time\",\"arguments\":\"{\\\"zone\\\":\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"Rome\\\"}\"}},{\"index\":1,\"function\":{\"arguments\":\"\\\"UTC\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4}}\n\n",
        "data: [DONE]\n\n",
      ]); },
    });
    const events = await collect(adapter.streamMessage({
      model: "model-a", max_tokens: 99, system: [{ type: "text", text: "You are a coding agent." }],
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "previous", name: "old", input: { a: 1 } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "previous", content: "ok" }] }],
      tools: [{ name: "weather", input_schema: { type: "object" } }], tool_choice: { type: "any" },
    }, context()));
    expect(JSON.parse(body)).toMatchObject({ stream: true, stream_options: { include_usage: true }, tool_choice: "required", messages: [{ role: "system", content: "You are a coding agent." }, { role: "assistant", tool_calls: [{ id: "previous" }] }, { role: "tool", tool_call_id: "previous", content: "ok" }] });
    expect(events).toContainEqual({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":"Rome"}' } });
    expect(events).toContainEqual({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"zone":"UTC"}' } });
    expect(events).toContainEqual({ type: "usage", usage: { semantics: "cumulative", stage: "final", source: "provider", inputTokens: 9, outputTokens: 4 } });
    expect(events.at(-2)).toEqual({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 9, output_tokens: 4 } });
  });

  it("maps an upstream authentication error and redacts its credential", async () => {
    const adapter = new OpenAIChatAdapter({ id: "compat", apiKey: "chat-secret", models, baseUrl: "https://chat.example/v1", fetch: async () => new Response("Authorization: Bearer chat-secret", { status: 401 }) });
    await expect(collect(adapter.streamMessage({ model: "model-a", messages: [] }, context()))).rejects.toMatchObject({ kind: "authentication" });
    await expect(collect(adapter.streamMessage({ model: "model-a", messages: [] }, context()))).rejects.not.toThrow("chat-secret");
  });
});

function sse(chunks: readonly string[]): Response { const encoder = new TextEncoder(); return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } }); }
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of stream) values.push(value); return values; }
function context() { return { signal: new AbortController().signal, session: "s", agent: "a" }; }
