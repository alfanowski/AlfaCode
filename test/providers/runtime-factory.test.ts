import { describe, expect, it } from "vitest";
import { createConfiguredProvider } from "../../src/runtime.js";
import type { ProviderRecord } from "../../src/config.js";

describe("runtime provider factory", () => {
  it("probes Google catalog entries with countTokens, caches results, and never selects a default", async () => {
    let probes = 0;
    const record: ProviderRecord = { id: "google", type: "google-ai-studio" };
    const fake = () => ({
      async listModels() { return [{ id: "retired", displayName: "Retired" }, { id: "current", displayName: "Current", contextWindow: 200_000 }]; },
      async countTokens(_request: unknown, model: string) { probes += 1; if (model === "retired") throw Object.assign(new Error("not found"), { status: 404 }); return 1; },
      async *stream() {}, async close() {},
    });
    const dependencies = { createGoogle: () => fake() as never, modelMetadata: { async resolve() { return { capabilities: { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: true, reasoningState: "required" as const, nativeTokenCounting: true, jsonSchema: "subset" as const } }; } } };
    const first = await createConfiguredProvider(record, "secret", dependencies, "/tmp/alfacode-test");
    const second = await createConfiguredProvider(record, "secret", dependencies, "/tmp/alfacode-test");
    expect(probes).toBe(2);
    expect(first.descriptors.map((model) => [model.id, model.availability])).toEqual([["retired", "deprecated"], ["current", "available"]]);
    expect(first.provider.models.map((model) => model.id)).toEqual(["current"]);
    expect(second.provider.models.map((model) => model.id)).toEqual(["current"]);
  });

  it("keeps callable Google models unverified when no capability evidence exists", async () => {
    const fake = () => ({ async listModels() { return [{ id: "unknown", displayName: "Unknown" }]; }, async countTokens() { return 1; }, async *stream() {}, async close() {} });
    const built = await createConfiguredProvider({ id: "unverified-google", type: "google-ai-studio" }, "secret", { createGoogle: () => fake() as never }, "/tmp/alfacode-test");
    expect(built.descriptors[0]).toMatchObject({ id: "unknown", availability: "unknown", capabilities: { tools: false } });
    expect(built.provider.models).toHaveLength(0);
  });

  it("exposes unsupported Zen catalog routes as candidates without routing them", async () => {
    const record: ProviderRecord = { id: "zen", type: "opencode-zen" };
    const built = await createConfiguredProvider(record, "zen-secret", {
      fetch: async () => Response.json({ data: [{ id: "known", endpoint: "/chat/completions", status: "available" }, { id: "unknown" }] }),
    }, "/tmp/alfacode-test");
    expect(built.descriptors.map((model) => [model.id, model.wireProtocol])).toEqual([["known", "openai-chat"], ["unknown", "unsupported"]]);
    expect(built.provider.models.map((model) => model.id)).toEqual(["known"]);
  });

  it("discovers a catalog-defined wire provider without a provider-type switch", async () => {
    const record: ProviderRecord = { id: "catalog", type: "models-dev-proxy", options: { baseUrl: "https://example.invalid/v1", wireProtocol: "openai-chat" } };
    const built = await createConfiguredProvider(record, "catalog-secret", { fetch: async () => Response.json({ data: [{ id: "model-a" }] }), modelMetadata: { async resolve() { return { capabilities: { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: true, reasoningState: "optional" as const, nativeTokenCounting: false, jsonSchema: "full" as const } }; } } }, "/tmp/alfacode-test");
    expect(built.descriptors[0]).toMatchObject({ id: "model-a", wireProtocol: "openai-chat", availability: "available" });
    expect(built.provider.models.map((model) => model.id)).toEqual(["model-a"]);
  });

  it("discovers OpenAI-compatible models without a configured model ID", async () => {
    const record: ProviderRecord = { id: "openai", type: "openai-compatible", options: { baseUrl: "https://example.invalid/v1" } };
    const urls: string[] = [];
    const built = await createConfiguredProvider(record, "openai-secret", { fetch: async (input) => { urls.push(String(input)); return Response.json(String(input).endsWith("/models") ? { data: [{ id: "dynamic-model" }] } : { id: "dynamic-model" }); }, modelMetadata: { async resolve() { return { capabilities: { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: true, reasoningState: "optional" as const, nativeTokenCounting: false, jsonSchema: "full" as const } }; } } }, "/tmp/alfacode-test");
    expect(built.descriptors[0]).toMatchObject({ id: "dynamic-model", availability: "available" });
    expect(built.provider.models.map((model) => model.id)).toEqual(["dynamic-model"]);
    expect(urls).toEqual(["https://example.invalid/v1/models", "https://example.invalid/v1/models/dynamic-model"]);
  });
});
