import type { Provider, ProviderMessageRequest, ProviderRequestContext, TokenCount, CanonicalStreamEvent, ProviderModel } from "../provider-contract.js";
import type { ModelDescriptor } from "./foundation/types.js";

/** Routes a prewarmed model catalog to a protocol-specific adapter; it never guesses a wire protocol. */
export class CompositeProvider implements Provider {
  public readonly models: readonly ProviderModel[];
  private readonly routes = new Map<string, Provider>();

  public constructor(public readonly id: string, entries: readonly { descriptor: ModelDescriptor; provider?: Provider }[]) {
    this.models = entries.flatMap(({ descriptor, provider }) => {
      if (!provider || descriptor.wireProtocol === "unsupported" || descriptor.availability !== "available" || !descriptor.capabilities.tools) return [];
      this.routes.set(descriptor.id, provider);
      const model = provider.models.find((candidate) => candidate.id === descriptor.id);
      return model ? [model] : [];
    });
  }

  public streamMessage(request: ProviderMessageRequest, context: ProviderRequestContext): AsyncIterable<CanonicalStreamEvent> {
    return this.route(request.model).streamMessage(request, context);
  }

  public countTokens(request: ProviderMessageRequest, context: ProviderRequestContext): Promise<TokenCount> {
    return this.route(request.model).countTokens(request, context);
  }

  public async close(): Promise<void> {
    await Promise.allSettled([...new Set(this.routes.values())].map(async (provider) => provider.close()));
  }

  private route(model: string): Provider {
    const provider = this.routes.get(model);
    if (!provider) throw new Error(`Model '${model}' is unavailable or has no supported protocol adapter`);
    return provider;
  }
}
