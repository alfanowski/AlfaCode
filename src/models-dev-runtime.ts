import type { AlfaCodeConfig } from "./config.js";
import type { ModelsDevCatalog, ModelsDevModel, ModelsDevProvider } from "./models-dev-catalog.js";
import { CAPABILITIES, type CapabilitySet, type WireProtocol } from "./providers/foundation/types.js";
import type { DynamicModelMetadataResolver } from "./runtime.js";
import { sanitizeTerminalText } from "./ui/markdown.js";

/** Enriches account-scoped discovery without treating catalog order or model names as policy. */
export function createModelsDevMetadataResolver(catalog: ModelsDevCatalog, config: AlfaCodeConfig): DynamicModelMetadataResolver {
  const providerKeys = new Map(config.providers.map((record) => [record.id, catalogProviderKey(record.type, record.options)]));
  return {
    async resolve(input) {
      const key = providerKeys.get(input.providerId) ?? input.providerId;
      const provider = catalog.providers.get(key);
      const model = provider?.models.get(input.modelId);
      if (provider === undefined || model === undefined || (input.wireProtocol !== undefined && model.wireFamily !== input.wireProtocol)) return undefined;
      const wireProtocol = input.wireProtocol ?? model.wireFamily;
      if (wireProtocol === undefined) return undefined;
      return {
        displayName: sanitizeTerminalText(model.name),
        capabilities: modelCapabilities(model, wireProtocol),
        contextWindow: model.limits.input ?? model.limits.context,
        maxOutputTokens: model.limits.output,
        support: "best-effort",
        ...(model.wireFamily === undefined ? {} : { wireProtocol: model.wireFamily }),
        free: model.costs !== undefined && model.costs.input === 0 && model.costs.output === 0,
        deprecated: model.deprecated,
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
    if (provider.api === undefined || !isSafeSuggestedBaseUrl(provider.api)) continue;
    for (const wireProtocol of providerWireProtocols(provider)) {
      descriptors.push({
        catalogProviderId: provider.id,
        displayName: sanitizeTerminalText(provider.name),
        baseUrl: provider.api,
        wireProtocol,
        environmentVariables: provider.env.map(sanitizeTerminalText),
      });
    }
  }
  return descriptors.sort((left, right) => JSON.stringify([left.displayName, left.catalogProviderId, left.wireProtocol]).localeCompare(JSON.stringify([right.displayName, right.catalogProviderId, right.wireProtocol])));
}

/**
 * A provider's catalog-supplied `api` field is untrusted, freeform upstream data (not every
 * models.dev entry uses one, e.g. local-gateway providers publish a loopback http:// URL, and a
 * minority publish a non-URL template string). The catalog schema deliberately does not enforce a
 * strict URL shape here (one malformed entry must never fail parsing for the whole catalog) — this
 * is the actual security boundary: only a well-formed absolute HTTPS URL, or an HTTP URL pointing
 * at a loopback host, is ever surfaced as a pre-fillable suggested base URL. Mirrors `cli.ts`'s
 * `isHttpUrl`.
 */
function isSafeSuggestedBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
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
  return model.modalities.input.includes("text") && model.modalities.output.length === 1 && model.modalities.output[0] === "text";
}
