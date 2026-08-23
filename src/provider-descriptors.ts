import type { DynamicProviderDescriptorData } from "./models-dev-runtime.js";

export interface ProviderDescriptor {
  readonly id: string;
  readonly configType: string;
  readonly displayName: string;
  readonly description: string;
  readonly requiresBaseUrl?: boolean;
  readonly suggestedBaseUrl?: string;
  readonly configurationOptions?: Readonly<Record<string, string>>;
  readonly environmentVariables?: readonly string[];
  readonly allowsAnonymous?: boolean;
}

/** Configuration metadata only; runtime adapters are resolved by the platform layer. */
export const providerDescriptors: readonly ProviderDescriptor[] = [
  { id: "google", configType: "google", displayName: "Google AI Studio", description: "Gemini models through Google AI Studio" },
  { id: "zen", configType: "opencode-zen", displayName: "OpenCode Zen", description: "Free public models or your own Zen account", allowsAnonymous: true, configurationOptions: { catalogProviderId: "opencode" } },
  { id: "anthropic", configType: "anthropic", displayName: "Anthropic", description: "Anthropic Messages API" },
  { id: "openai-compatible", configType: "openai-compatible", displayName: "OpenAI-compatible", description: "A custom compatible API endpoint", requiresBaseUrl: true },
];

export function descriptorsFromDynamicCatalog(entries: readonly DynamicProviderDescriptorData[]): readonly ProviderDescriptor[] {
  const nativeIds = new Set(providerDescriptors.map((descriptor) => descriptor.id));
  return entries
    .filter((entry) => !nativeIds.has(entry.catalogProviderId))
    .map((entry) => ({
      id: `catalog-${safeId(entry.catalogProviderId)}-${safeId(entry.wireProtocol)}`,
      configType: "catalog",
      displayName: `${entry.displayName} · ${entry.wireProtocol}`,
      description: `Dynamic models from ${entry.catalogProviderId}`,
      requiresBaseUrl: true,
      suggestedBaseUrl: entry.baseUrl,
      configurationOptions: { catalogProviderId: entry.catalogProviderId, wireProtocol: entry.wireProtocol },
      environmentVariables: entry.environmentVariables,
    }));
}

export function providerDescriptor(id: string): ProviderDescriptor | undefined {
  return providerDescriptors.find((descriptor) => descriptor.id === id);
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
}
