export interface ProviderDescriptor {
  readonly id: string;
  readonly configType: string;
  readonly displayName: string;
  readonly description: string;
  readonly requiresBaseUrl?: boolean;
}

/** Configuration metadata only; runtime adapters are resolved by the platform layer. */
export const providerDescriptors: readonly ProviderDescriptor[] = [
  { id: "google", configType: "google", displayName: "Google AI Studio", description: "Gemini models through Google AI Studio" },
  { id: "zen", configType: "zen", displayName: "OpenCode Zen", description: "OpenCode's multi-model gateway" },
  { id: "anthropic", configType: "anthropic", displayName: "Anthropic", description: "Anthropic Messages API" },
  { id: "openai-compatible", configType: "openai-compatible", displayName: "OpenAI-compatible", description: "A custom compatible API endpoint", requiresBaseUrl: true },
];

export function providerDescriptor(id: string): ProviderDescriptor | undefined {
  return providerDescriptors.find((descriptor) => descriptor.id === id);
}
