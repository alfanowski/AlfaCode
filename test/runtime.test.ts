import { describe, expect, it } from "vitest";
import { GoogleGatewayProvider } from "../src/runtime.js";
import type { CanonicalStreamEvent as GoogleEvent, ProviderModel } from "../src/providers/google/types.js";
import type { ProviderMessageRequest } from "../src/provider-contract.js";

const request: ProviderMessageRequest = {
  model: "gemini-test",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 128,
};

describe("Google gateway bridge", () => {
  it("converts text, tools, usage, and completion to exact Anthropic events", async () => {
    const events: GoogleEvent[] = [
      { type: "text_delta", text: "checking" },
      { type: "tool_use", id: "call-1", name: "weather", input: { city: "Rome" } },
      { type: "usage", input_tokens: 12, output_tokens: 4 },
      { type: "message_delta", stop_reason: "tool_use" },
    ];
    const provider = new GoogleGatewayProvider("google.personal", fakeGoogle(events), models());
    const output = [];
    for await (const event of provider.streamMessage(request, context())) output.push(event);

    expect(output.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(output).toContainEqual({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"city":"Rome"}' },
    });
    expect(output.at(-2)).toEqual({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: 12, output_tokens: 4 },
    });
  });

  it("qualifies duplicate model names with the provider id", () => {
    expect(new GoogleGatewayProvider("work", fakeGoogle([]), models()).models).toEqual([
      { id: "gemini-test", displayName: "[work] Gemini Test" },
    ]);
  });

  it("preserves Gemini thinking and signature blocks on the Anthropic stream", async () => {
    const provider = new GoogleGatewayProvider("google", fakeGoogle([
      { type: "thinking_delta", thinking: "summary", signature: "opaque" },
      { type: "text_delta", text: "answer" },
      { type: "message_delta", stop_reason: "end_turn" },
    ]), models());
    const output = [];
    for await (const event of provider.streamMessage(request, context())) output.push(event);
    expect(output).toContainEqual({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "summary" } });
    expect(output).toContainEqual({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque" } });
    expect(output).toContainEqual({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  });
});

function models(): ProviderModel[] {
  return [{ id: "gemini-test", displayName: "Gemini Test", contextWindow: 1_000_000 }];
}

function context() {
  return { signal: new AbortController().signal, session: "session-1", agent: "main" };
}

function fakeGoogle(events: GoogleEvent[]) {
  return {
    async listModels() { return models(); },
    async *stream() { yield* events; },
    async countTokens() { return 5; },
    async close() {},
  };
}
