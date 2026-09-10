import type { ProviderRecord } from "./config.js";

export const OLLAMA_LOCAL_BASE_URL = "http://localhost:11434/v1";
export const OLLAMA_LOCAL_PROVIDER_ID = "ollama-local";

export interface OllamaLocalProbeOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** A short timeout keeps a cold/absent Ollama daemon from delaying every launch. */
export async function probeOllamaLocal(options: OllamaLocalProbeOptions = {}): Promise<boolean> {
  const baseUrl = options.baseUrl ?? OLLAMA_LOCAL_BASE_URL;
  const requestFetch = options.fetch ?? fetch;
  try {
    const response = await requestFetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(options.timeoutMs ?? 300) });
    return response.ok;
  } catch {
    return false;
  }
}

export function ollamaLocalProviderRecord(): ProviderRecord {
  return { id: OLLAMA_LOCAL_PROVIDER_ID, type: "ollama-local" };
}
