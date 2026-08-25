import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportTranscript, formatTranscriptMarkdown, type TranscriptExportItem } from "../src/transcript-export.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true }))); });

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "alfacode-export-"));
  directories.push(directory);
  return directory;
}

const exportedAt = new Date("2026-08-25T12:00:00.000Z");

describe("formatTranscriptMarkdown", () => {
  it("renders user and assistant turns as headed Markdown sections", () => {
    const items: TranscriptExportItem[] = [
      { role: "user", text: "Explain the change" },
      { role: "assistant", text: "It fixes the **off-by-one** bug." },
    ];
    const markdown = formatTranscriptMarkdown(items, { model: "alfacode-anthropic/google/gemini", exportedAt });
    expect(markdown).toContain("# AlfaCode transcript");
    expect(markdown).toContain("model `alfacode-anthropic/google/gemini`");
    expect(markdown).toContain("## You\n\nExplain the change");
    expect(markdown).toContain("## AlfaCode\n\nIt fixes the **off-by-one** bug.");
  });

  it("renders a readable indication of tool calls, not a raw JSON blob", () => {
    const items: TranscriptExportItem[] = [
      { role: "tool", text: "Read", status: "completed", detail: "subagent" },
    ];
    const markdown = formatTranscriptMarkdown(items, { model: "m", exportedAt });
    expect(markdown).toContain("Read (subagent) — completed");
    expect(markdown).not.toContain("{");
  });

  it("renders system notices as blockquotes and drops empty entries", () => {
    const items: TranscriptExportItem[] = [
      { role: "system", text: "Model switched to gemini" },
      { role: "assistant", text: "" },
    ];
    const markdown = formatTranscriptMarkdown(items, { model: "m", exportedAt });
    expect(markdown).toContain("> Model switched to gemini");
  });

  it("strips ANSI control sequences using the shared sanitizer", () => {
    const items: TranscriptExportItem[] = [{ role: "user", text: "ok\u001B[31mred\u001B[0m" }];
    const markdown = formatTranscriptMarkdown(items, { model: "m", exportedAt });
    expect(markdown).toContain("okred");
    expect(markdown).not.toContain("\u001B");
  });

  it("reports an empty transcript clearly instead of an empty file", () => {
    const markdown = formatTranscriptMarkdown([], { model: "m", exportedAt });
    expect(markdown).toContain("_This conversation is empty._");
  });
});

describe("exportTranscript", () => {
  it("writes an owner-only Markdown file and returns its path", async () => {
    const directory = await tempDirectory();
    const items: TranscriptExportItem[] = [{ role: "user", text: "hello" }];
    const path = await exportTranscript(items, { model: "m" }, { directory, now: () => exportedAt });

    expect(path).toBe(join(directory, "alfacode-transcript-2026-08-25T12-00-00-000Z.md"));
    const contents = await readFile(path, "utf8");
    expect(contents).toContain("## You\n\nhello");
  });
});
