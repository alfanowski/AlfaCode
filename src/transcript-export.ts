import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeTerminalText } from "./ui/markdown.js";

/**
 * Structural subset of `TranscriptItem` (from chat-tui.tsx) this module
 * needs. Kept independent (rather than importing the type from chat-tui.tsx)
 * so this module has no dependency on the TUI layer and stays trivially
 * unit-testable; any `TranscriptItem[]` is assignable here already.
 */
export interface TranscriptExportItem {
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly text: string;
  readonly status?: "running" | "completed" | "failed";
  readonly detail?: string;
}

export interface TranscriptExportMeta {
  readonly model: string;
  readonly exportedAt: Date;
}

/**
 * Renders the transcript as Markdown, reusing the same sanitizer the live
 * Markdown renderer (`src/ui/markdown.tsx`) applies to terminal output,
 * rather than re-implementing text cleanup here. Tool calls are rendered as
 * a short, readable line (name, status, detail) — never the raw tool-call
 * JSON, since `TranscriptItem` never carries that in the first place.
 */
export function formatTranscriptMarkdown(items: readonly TranscriptExportItem[], meta: TranscriptExportMeta): string {
  const header = `# AlfaCode transcript\n\nExported ${meta.exportedAt.toISOString()} · model \`${meta.model}\`\n`;
  const sections = items.map(renderTranscriptItem).filter((section) => section.length > 0);
  const body = sections.length === 0 ? "_This conversation is empty._" : sections.join("\n\n");
  return `${header}\n${body}\n`;
}

function renderTranscriptItem(item: TranscriptExportItem): string {
  const text = sanitizeTerminalText(item.text).trim();
  if (item.role === "user") return `## You\n\n${text}`;
  if (item.role === "assistant") return text.length === 0 ? "" : `## AlfaCode\n\n${text}`;
  if (item.role === "tool") return `> 🛠 ${text}${item.detail === undefined ? "" : ` (${item.detail})`}${item.status === undefined ? "" : ` — ${item.status}`}`;
  return text.length === 0 ? "" : `> ${text}`;
}

export interface ExportTranscriptOptions {
  readonly directory?: string;
  readonly now?: () => Date;
}

/**
 * Writes the transcript to a timestamped Markdown file under
 * `~/.alfacode/exports/` (or `options.directory`) and returns the absolute
 * path written. The directory and file are created owner-only, matching the
 * rest of AlfaCode's on-disk state.
 */
export async function exportTranscript(items: readonly TranscriptExportItem[], meta: { readonly model: string }, options: ExportTranscriptOptions = {}): Promise<string> {
  const now = (options.now ?? (() => new Date()))();
  const directory = options.directory ?? join(homedir(), ".alfacode", "exports");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = join(directory, `alfacode-transcript-${formatTimestamp(now)}.md`);
  await writeFile(filePath, formatTranscriptMarkdown(items, { model: meta.model, exportedAt: now }), { encoding: "utf8", mode: 0o600 });
  return filePath;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/gu, "-");
}
