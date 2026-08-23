import type { AlfaCodeConfig } from "./config.js";
import type { ModelsDevCatalog, ModelsDevModel, ModelsDevProvider } from "./models-dev-catalog.js";
import { CAPABILITIES, type CapabilitySet, type WireProtocol } from "./providers/foundation/types.js";
import type { DynamicModelMetadataResolver } from "./runtime.js";

/** Enriches account-scoped discovery without treating catalog order or model names as policy. */
export function createModelsDevMetadataResolver(catalog: ModelsDevCatalog, config: AlfaCodeConfig): DynamicModelMetadataResolver {
  const providerKeys = new Map(config.providers.map((record) => [record.id, catalogProviderKey(record.type, record.options)]));
  return {
    async resolve(input) {
      const key = providerKeys.get(input.providerId) ?? input.providerId;
      const provider = catalog.providers.get(key);
      const model = provider?.models.get(input.modelId);
      if (provider === undefined || model === undefined || model.wireFamily !== input.wireProtocol) return undefined;
      return {
        displayName: model.name,
        capabilities: modelCapabilities(model, input.wireProtocol),
        contextWindow: model.limits.input ?? model.limits.context,
        maxOutputTokens: model.limits.output,
        support: "best-effort",
      };
    },
  };
}

export interface DynamicProviderDescriptorData {
  readonly catalogProviderId: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly wireProtocol: Exclude<WireProtocol, "unsupported" | "ollama-native">;
  readonly environmentVariables: readonly string[];
}

/** One descriptor per advertised wire contract; mixed-protocol providers are never guessed. */
export function dynamicProviderDescriptors(catalog: ModelsDevCatalog): readonly DynamicProviderDescriptorData[] {
  const descriptors: DynamicProviderDescriptorData[] = [];
  for (const provider of catalog.providers.values()) {
    if (provider.api === undefined) continue;
    for (const wireProtocol of providerWireProtocols(provider)) {
      descriptors.push({
        catalogProviderId: provider.id,
        displayName: provider.name,
        baseUrl: provider.api,
        wireProtocol,
        environmentVariables: provider.env,
      });
    }
  }
  return descriptors.sort((left, right) => JSON.stringify([left.displayName, left.catalogProviderId, left.wireProtocol]).localeCompare(JSON.stringify([right.displayName, right.catalogProviderId, right.wireProtocol])));
}

function catalogProviderKey(type: string, options: Readonly<Record<string, unknown>> | undefined): string {
  const configured = options?.catalogProviderId;
  return typeof configured === "string" && configured.length > 0 ? configured : type;
}

function providerWireProtocols(provider: ModelsDevProvider): readonly DynamicProviderDescriptorData["wireProtocol"][] {
  const protocols = new Set<DynamicProviderDescriptorData["wireProtocol"]>();
  for (const model of provider.models.values()) {
    if (model.deprecated || !model.toolCall || !supportsTextConversation(model)) continue;
    const wire = model.wireFamily;
    if (wire !== undefined && wire !== "ollama-native") protocols.add(wire);
  }
  return [...protocols];
}

function modelCapabilities(model: ModelsDevModel, wireProtocol: Exclude<WireProtocol, "unsupported">): CapabilitySet {
  const protocol = CAPABILITIES[wireProtocol];
  const conversational = supportsTextConversation(model);
  const tools = conversational && model.toolCall;
  return {
    ...protocol,
    tools,
    parallelTools: tools && protocol.parallelTools,
    forcedToolChoice: tools && protocol.forcedToolChoice,
    vision: protocol.vision && model.modalities.input.includes("image"),
    reasoningState: model.reasoning ? protocol.reasoningState : "none",
  };
}

function supportsTextConversation(model: ModelsDevModel): boolean {
  return model.modalities.input.includes("text") && model.modalities.output.includes("text");
}
