import { sanitizeTerminalText } from "./markdown.js";

const DEFAULT_DISPLAY_LIMIT = 1_600;

/**
 * Renders an arbitrary tool input/output payload as sanitized, human-readable text for the
 * transcript's detailed tool-output view. Mirrors the truncate-then-sanitize approach already
 * used for the blocking permission card's single-line input summary, but keeps line breaks so a
 * multi-line JSON payload stays readable.
 */
export function stringifyToolPayload(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return sanitizeTerminalText(value);
  try {
    const serialized = JSON.stringify(value, null, 2);
    return sanitizeTerminalText(serialized ?? String(value));
  } catch {
    return sanitizeTerminalText(String(value));
  }
}

export function truncateForDisplay(value: string, limit: number = DEFAULT_DISPLAY_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…truncated`;
}
