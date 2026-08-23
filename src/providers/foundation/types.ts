/** The wire protocol, not the vendor, decides how a request is encoded and replayed. */
export type WireProtocol = "anthropic-messages" | "openai-responses" | "openai-chat" | "gemini-generate-content" | "ollama-native";

export interface CapabilitySet {
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly parallelTools: boolean;
  readonly forcedToolChoice: boolean;
  readonly vision: boolean;
  readonly reasoningState: "none" | "optional" | "required";
  readonly nativeTokenCounting: boolean;
  readonly jsonSchema: "none" | "subset" | "full";
}

export interface ModelDescriptor {
  readonly providerId: string;
  readonly id: string;
  readonly displayName: string;
  readonly wireProtocol: WireProtocol;
  readonly capabilities: CapabilitySet;
  /** A listed model is not necessarily callable by this account or project. */
  readonly availability: "available" | "deprecated" | "account-validation-required" | "unknown";
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  /** "best-effort" means the upstream has not passed AlfaCode's protocol contract suite. */
  readonly support: "contract-tested" | "best-effort";
}

/** Never use an arbitrary first catalog entry as a default. */
export function selectDefaultModel(models: readonly ModelDescriptor[], preferredId?: string): ModelDescriptor | undefined {
  if (preferredId !== undefined) return models.find((model) => model.id === preferredId && model.availability !== "deprecated");
  return models.find((model) => model.availability === "available" && model.support === "contract-tested");
}

/**
 * Opaque continuation data is replayed verbatim by the owning adapter. It is
 * intentionally distinct from prompts and never intended for logging.
 */
export interface ProtocolState {
  readonly protocol: WireProtocol;
  readonly session: string;
  readonly agent: string;
  readonly model: string;
  readonly continuations: readonly ProtocolContinuation[];
}

export interface ProtocolContinuation {
  readonly turnId: string;
  readonly kind: "assistant" | "reasoning" | "tool";
  readonly payload: unknown;
}

export interface ProtocolStateStore {
  get(input: Pick<ProtocolState, "protocol" | "session" | "agent" | "model">): Promise<ProtocolState | undefined>;
  put(state: ProtocolState): Promise<void>;
  close?(): Promise<void>;
}

export class MemoryProtocolStateStore implements ProtocolStateStore {
  private readonly values = new Map<string, ProtocolState>();

  public async get(input: Pick<ProtocolState, "protocol" | "session" | "agent" | "model">): Promise<ProtocolState | undefined> {
    return this.values.get(protocolStateKey(input));
  }

  public async put(state: ProtocolState): Promise<void> {
    this.values.set(protocolStateKey(state), state);
  }
}

export interface ProviderPreset {
  readonly id: string;
  readonly displayName: string;
  readonly wireProtocol: WireProtocol;
  readonly baseUrl: string;
  readonly authentication: "bearer" | "x-api-key" | "none";
  readonly support: "contract-tested" | "best-effort";
}

export const CAPABILITIES: Readonly<Record<WireProtocol, CapabilitySet>> = {
  "anthropic-messages": { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: true, reasoningState: "optional", nativeTokenCounting: true, jsonSchema: "full" },
  "openai-responses": { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: true, reasoningState: "required", nativeTokenCounting: true, jsonSchema: "full" },
  "openai-chat": { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: true, reasoningState: "optional", nativeTokenCounting: false, jsonSchema: "full" },
  "gemini-generate-content": { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: true, reasoningState: "required", nativeTokenCounting: true, jsonSchema: "subset" },
  "ollama-native": { streaming: true, tools: true, parallelTools: true, forcedToolChoice: false, vision: true, reasoningState: "optional", nativeTokenCounting: false, jsonSchema: "subset" },
};

function protocolStateKey(input: Pick<ProtocolState, "protocol" | "session" | "agent" | "model">): string {
  return JSON.stringify([input.protocol, input.session, input.agent, input.model]);
}
