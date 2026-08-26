import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activeMentionQuery, filterMentionEntries, insertMention, listMentionEntries, type MentionEntry } from "../src/ui/mentions.js";

describe("activeMentionQuery", () => {
  it("finds the @token containing the cursor", () => {
    const value = "check @src/inde";
    expect(activeMentionQuery(value, value.length)).toEqual({ start: 6, end: value.length, query: "src/inde" });
  });

  it("requires the @ to start a token (start of buffer or after whitespace)", () => {
    expect(activeMentionQuery("email@example.com", 6)).toBeUndefined();
    expect(activeMentionQuery("@readme", 3)).toEqual({ start: 0, end: 3, query: "re" });
  });

  it("stops matching once the token is closed by whitespace", () => {
    expect(activeMentionQuery("look at @file.ts and more", 20)).toBeUndefined();
  });

  it("returns undefined when there's no @ before the cursor", () => {
    expect(activeMentionQuery("plain text", 5)).toBeUndefined();
  });
});

describe("filterMentionEntries", () => {
  const entries: readonly MentionEntry[] = [
    { relativePath: "src/chat-tui.tsx", isDirectory: false },
    { relativePath: "src/ui/input-editor.ts", isDirectory: false },
    { relativePath: "src/ui", isDirectory: true },
    { relativePath: "README.md", isDirectory: false },
  ];

  it("ranks whole-path prefix matches first, shortest match first among ties", () => {
    const matches = filterMentionEntries(entries, "src");
    expect(matches.map((entry) => entry.relativePath)).toEqual(["src/ui", "src/chat-tui.tsx", "src/ui/input-editor.ts"]);
  });

  it("matches on basename even when the query isn't a path prefix", () => {
    const matches = filterMentionEntries(entries, "input");
    expect(matches.map((entry) => entry.relativePath)).toEqual(["src/ui/input-editor.ts"]);
  });

  it("returns everything, shortest first, for an empty query", () => {
    const matches = filterMentionEntries(entries, "", 10);
    expect(matches[0]?.relativePath).toBe("src/ui");
  });

  it("respects the limit", () => {
    expect(filterMentionEntries(entries, "", 2)).toHaveLength(2);
  });
});

describe("insertMention", () => {
  it("replaces the active @query token with the full mention and a trailing space", () => {
    const value = "check @src/inde now";
    const start = value.indexOf("@");
    const end = start + "@src/inde".length;
    const query = { start, end, query: "src/inde" };
    const result = insertMention(value, query, { relativePath: "src/index.ts", isDirectory: false });
    // No extra trailing space is added: the space already sitting after the token (before "now")
    // is reused as the separator instead of doubling up.
    expect(result).toEqual({ value: "check @src/index.ts now", cursor: start + "@src/index.ts".length });
  });

  it("appends a trailing slash for directory mentions", () => {
    const query = { start: 0, end: 3, query: "src" };
    const result = insertMention("src", query, { relativePath: "src", isDirectory: true });
    expect(result).toEqual({ value: "@src/ ", cursor: 6 });
  });
});

describe("listMentionEntries", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("walks the tree, skipping ignored directories like node_modules and .git", async () => {
    root = await mkdtemp(join(tmpdir(), "alfacode-mentions-"));
    await writeFile(join(root, "README.md"), "hi");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export {};");
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = {};");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main");

    const entries = await listMentionEntries(root);
    const paths = entries.map((entry) => entry.relativePath).sort();

    expect(paths).toEqual(["README.md", "src", "src/index.ts"]);
    expect(entries.find((entry) => entry.relativePath === "src")?.isDirectory).toBe(true);
  });

  it("returns an empty list instead of throwing when the root doesn't exist", async () => {
    await expect(listMentionEntries(join(tmpdir(), "alfacode-does-not-exist-xyz"))).resolves.toEqual([]);
  });
});
