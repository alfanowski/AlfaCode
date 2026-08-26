import { describe, expect, it } from "vitest";
import { createModelsDevMetadataResolver, dynamicProviderDescriptors } from "../src/models-dev-runtime.js";
import type { ModelsDevCatalog, ModelsDevModel, ModelsDevProvider } from "../src/models-dev-catalog.js";
import { descriptorsFromDynamicCatalog } from "../src/provider-descriptors.js";

const model = (id: string, overrides: Partial<ModelsDevModel> = {}): ModelsDevModel => ({
  id, name: id, toolCall: true, reasoning: false,
  modalities: { input: ["text"], output: ["text"] }, limits: { context: 1000, output: 100 },
  deprecated: false, wireFamily: "openai-chat", ...overrides,
});

function provider(id: string, models: readonly ModelsDevModel[], overrides: Partial<ModelsDevProvider> = {}): ModelsDevProvider {
  return { id, name: id, npm: "opaque", env: ["KEY"], api: "https://example.invalid/v1", docs: "https://example.invalid/docs", models: new Map(models.map((entry) => [entry.id, entry])), ...overrides };
}

describe("models.dev runtime metadata", () => {
  it("joins configured providers to current opaque model IDs without name rules", async () => {
    const catalog: ModelsDevCatalog = { providers: new Map([["catalog-key", provider("catalog-key", [model("brand-new-opaque"), model("multi-output", { modalities: { input: ["text"], output: ["text", "image"] } })])]]) };
    const resolver = createModelsDevMetadataResolver(catalog, { version: 1, providers: [{ id: "personal", type: "catalog", options: { catalogProviderId: "catalog-key" } }] });
    const result = await resolver.resolve({ providerId: "personal", modelId: "brand-new-opaque", wireProtocol: "openai-chat" });
    expect(result).toMatchObject({ capabilities: { tools: true }, contextWindow: 1000, maxOutputTokens: 100 });
    await expect(resolver.resolve({ providerId: "personal", modelId: "multi-output", wireProtocol: "openai-chat" })).resolves.toMatchObject({ capabilities: { tools: false } });
    await expect(resolver.resolve({ providerId: "personal", modelId: "removed", wireProtocol: "openai-chat" })).resolves.toBeUndefined();
  });

  it("advertises only live text/tool protocols and never chooses a protocol by catalog order", () => {
    const catalog: ModelsDevCatalog = { providers: new Map([["mixed", provider("mixed", [
      model("chat"),
      model("responses", { wireFamily: "openai-responses" }),
      model("image-only", { modalities: { input: ["text"], output: ["image"] } }),
      model("retired", { deprecated: true }),
    ])]]) };
    expect(dynamicProviderDescriptors(catalog).map((entry) => entry.wireProtocol).sort()).toEqual(["openai-chat", "openai-responses"]);
  });

  it("sanitizes catalog display text before exposing runtime metadata and provider descriptors", async () => {
    const catalogProviderId = "catalog\u001b[31m-key";
    const unsafeModelName = "Model\u001b]52;c;Y2xpcGJvYXJk\u0007\u001b[2J Name";
    const unsafeProviderName = "Provider\u001b]0;hijacked\u0007\u001b[31m Name";
    const catalog: ModelsDevCatalog = {
      providers: new Map([[catalogProviderId, provider(catalogProviderId, [model("model", { name: unsafeModelName })], {
        name: unsafeProviderName,
        env: ["API\u001b]52;c;c2VjcmV0\u0007_KEY"],
      })]]),
    };
    const resolver = createModelsDevMetadataResolver(catalog, { version: 1, providers: [{ id: "personal", type: "catalog", options: { catalogProviderId } }] });

    await expect(resolver.resolve({ providerId: "personal", modelId: "model", wireProtocol: "openai-chat" })).resolves.toMatchObject({ displayName: "Model Name" });

    const dynamic = dynamicProviderDescriptors(catalog);
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0]).toMatchObject({ displayName: "Provider Name", environmentVariables: ["API_KEY"] });

    const descriptors = descriptorsFromDynamicCatalog(dynamic);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      displayName: "Provider Name · openai-chat",
      description: "Dynamic models from catalog-key",
      environmentVariables: ["API_KEY"],
    });
  });
});
