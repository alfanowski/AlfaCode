import type { ProviderError } from "../provider-contract.js";

export class UpstreamProviderError extends Error implements ProviderError {
  public readonly statusCode?: number;
  public readonly retryAfter?: string | number;
  public constructor(
    public readonly kind: ProviderError["kind"],
    message: string,
    statusCode?: number,
    retryAfter?: string | number,
  ) {
    super(message);
    this.name = "UpstreamProviderError";
    if (statusCode !== undefined) this.statusCode = statusCode;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

export async function* readSse(response: Response): AsyncGenerator<SseFrame> {
  if (!response.body) throw new UpstreamProviderError("api", "Upstream returned an empty streaming response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseSseFrame(raw);
        if (frame) yield frame;
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    const frame = parseSseFrame(buffer);
    if (frame) yield frame;
  } finally {
    reader.releaseLock();
  }
}

export function upstreamError(status: number, body: string, secret: string, retryAfter?: string | number): UpstreamProviderError {
  const lower = body.toLowerCase();
  const kind: ProviderError["kind"] = status === 401 || lower.includes("api key") || lower.includes("authentication")
    ? "authentication"
    : status === 403 ? "permission"
      : status === 404 ? "not_found"
        : status === 429 ? "rate_limit"
          : status === 400 || status === 422 ? "invalid_request"
            : status >= 500 ? "overloaded"
              : "api";
  return new UpstreamProviderError(kind, redactSecret(body || `Upstream request failed (${status})`, secret), status, retryAfter);
}

export function redactSecret(value: string, secret: string): string {
  return value
    .replaceAll(secret, "[REDACTED]")
    .replace(/(?:AIza|sk-[A-Za-z0-9_-]+|api[_-]?key[=:]\s*)[^\s'"&]+/gi, "[REDACTED]");
}

export function unknownError(error: unknown, secret: string): UpstreamProviderError {
  if (error instanceof UpstreamProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new UpstreamProviderError("api", redactSecret(message, secret));
}

function parseSseFrame(raw: string): SseFrame | undefined {
  if (raw.length === 0) return undefined;
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  return data.length === 0 ? undefined : { event, data: data.join("\n") };
}
