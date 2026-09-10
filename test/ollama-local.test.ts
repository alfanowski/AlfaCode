import { describe, expect, it } from "vitest";
import { OLLAMA_LOCAL_BASE_URL, OLLAMA_LOCAL_PROVIDER_ID, ollamaLocalProviderRecord, probeOllamaLocal } from "../src/ollama-local.js";

describe("probeOllamaLocal", () => {
  it("returns true when the local endpoint responds ok", async () => {
    const calls: string[] = [];
    const reachable = await probeOllamaLocal({ fetch: async (input) => { calls.push(String(input)); return new Response(null, { status: 200 }); } });
    expect(reachable).toBe(true);
    expect(calls).toEqual([`${OLLAMA_LOCAL_BASE_URL}/models`]);
  });

  it("returns false when the endpoint is unreachable", async () => {
    const reachable = await probeOllamaLocal({ fetch: async () => { throw new Error("ECONNREFUSED"); } });
    expect(reachable).toBe(false);
  });

  it("returns false on a non-ok response", async () => {
    const reachable = await probeOllamaLocal({ fetch: async () => new Response(null, { status: 500 }) });
    expect(reachable).toBe(false);
  });
});

describe("ollamaLocalProviderRecord", () => {
  it("has no API key reference (openai-compatible discovery treats it as anonymous)", () => {
    expect(ollamaLocalProviderRecord()).toEqual({ id: OLLAMA_LOCAL_PROVIDER_ID, type: "ollama-local" });
  });
});
