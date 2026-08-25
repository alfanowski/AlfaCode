import { CAPABILITIES, type ModelDescriptor, type WireProtocol } from "../foundation/types.js";
import { providerFetch } from "../http.js";

export interface ZenCatalogOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

export interface ZenCatalogModel {
  readonly id?: string;
  readonly name?: string;
  readonly display_name?: string;
  readonly displayName?: string;
  readonly context_window?: number;
  readonly contextWindow?: number;
  readonly max_output_tokens?: number;
  readonly maxOutputTokens?: number;
  readonly endpoint?: string;
  readonly api?: string;
  readonly npm?: string;
  readonly protocol?: string;
  readonly status?: string;
}

/** Discover the catalog at runtime; credentials are sent only as an HTTP header. */
export async function discoverZenModels(options: ZenCatalogOptions): Promise<ModelDescriptor[]> {
  const baseUrl = (options.baseUrl ?? "https://opencode.ai/zen/v1").replace(/\/$/, "");
  const response = await providerFetch(options.fetch ?? fetch, `${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
  });
  if (!response.ok) throw zenError(response.status, await response.text(), options.apiKey);
  const body: unknown = await response.json();
  const models = extractModels(body);
  return models.flatMap<ModelDescriptor>((model) => {
    const id = model.id ?? model.name;
    if (!id) return [];
    const wireProtocol = classifyZenModel(model);
    if (wireProtocol === undefined) return [{
      providerId: "zen-unsupported", id, displayName: model.displayName ?? model.display_name ?? id,
      wireProtocol: "unsupported", capabilities: CAPABILITIES.unsupported, availability: "unknown",
      unavailableReason: "Zen catalog did not advertise a supported wire protocol for this model", support: "best-effort" as const,
    }];
    return [{
      providerId: `zen-${wireProtocol}`,
      id,
      displayName: model.displayName ?? model.display_name ?? id,
      wireProtocol,
      capabilities: CAPABILITIES[wireProtocol],
      availability: classifyAvailability(model.status),
      ...(numberOrUndefined(model.contextWindow ?? model.context_window, "contextWindow")),
      ...(numberOrUndefined(model.maxOutputTokens ?? model.max_output_tokens, "maxOutputTokens")),
      support: "best-effort" as const,
    }];
  });
}

function classifyAvailability(status: unknown): ModelDescriptor["availability"] {
  if (typeof status !== "string") return "unknown";
  const normalized = status.toLowerCase();
  if (normalized.includes("deprecated") || normalized.includes("retired")) return "deprecated";
  if (normalized.includes("validation") || normalized.includes("verification")) return "account-validation-required";
  if (normalized.includes("available") || normalized.includes("active")) return "available";
  return "unknown";
}

/** Public for deterministic model routing tests and cache refreshes. */
export function classifyZenModel(model: ZenCatalogModel): WireProtocol | undefined {
  const hint = [model.protocol, model.api, model.npm, model.endpoint].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
  if (hint.includes("responses")) return "openai-responses";
  if (hint.includes("messages") || hint.includes("anthropic")) return "anthropic-messages";
  if (hint.includes("gemini") || hint.includes("google")) return "gemini-generate-content";
  if (hint.includes("chat/completions") || hint.includes("openai-compatible")) return "openai-chat";
  return undefined;
}

function extractModels(value: unknown): ZenCatalogModel[] {
  if (!isRecord(value)) throw new Error("Zen model catalog has an invalid response shape");
  const candidates = Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : undefined;
  if (!candidates) throw new Error("Zen model catalog does not contain a data array");
  return candidates.filter(isRecord);
}

function zenError(status: number, text: string, secret: string): Error {
  const message = redact(text, secret).slice(0, 512);
  const error = new Error(`Zen model discovery failed (${status}): ${message || responseStatus(status)}`);
  error.name = status === 401 || status === 403 ? "ZenAuthenticationError" : "ZenDiscoveryError";
  return error;
}

function responseStatus(status: number): string {
  return status === 401 || status === 403 ? "authentication failed" : "request failed";
}

function numberOrUndefined(value: unknown, key: "contextWindow" | "maxOutputTokens"): Partial<Pick<ModelDescriptor, typeof key>> {
  return typeof value === "number" && Number.isFinite(value) ? { [key]: value } as Pick<ModelDescriptor, typeof key> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redact(value: string, secret: string): string {
  return value.replaceAll(secret, "[REDACTED]").replace(/(?:api[_-]?key|authorization)[=:]\s*[^\s'"&]+/gi, "$1=[REDACTED]");
}
