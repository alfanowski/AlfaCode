import type { Provider } from "../../provider-contract.js";
import type { ModelDescriptor, ProviderPreset } from "./types.js";

export interface RegisteredProvider {
  readonly preset: ProviderPreset;
  readonly models: readonly ModelDescriptor[];
  create(): Provider;
}

/** Descriptor-first registry: transport factories remain independently testable and composable. */
export class ProviderRegistry {
  private readonly values = new Map<string, RegisteredProvider>();

  public register(provider: RegisteredProvider): void {
    if (this.values.has(provider.preset.id)) throw new Error(`Provider preset already registered: ${provider.preset.id}`);
    this.values.set(provider.preset.id, provider);
  }

  public get(id: string): RegisteredProvider | undefined {
    return this.values.get(id);
  }

  public list(): readonly RegisteredProvider[] {
    return [...this.values.values()];
  }
}
