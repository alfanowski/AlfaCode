import { describe, expect, it } from "vitest";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  createSessionsBackend,
  describeSessionPickerEntry,
  formatRelativeTime,
  listRecentSessions,
  looksLikeSessionId,
  renameAlfaCodeSession,
  resolveResumeTarget,
  withSessionsConfigDir,
  type SessionsBackend,
} from "../src/session-history.js";

function fakeBackend(infos: readonly SDKSessionInfo[]): SessionsBackend & { readonly renamed: Array<{ sessionId: string; title: string }> } {
  const renamed: Array<{ sessionId: string; title: string }> = [];
  return {
    renamed,
    async listSessions() { return [...infos]; },
    async getSessionInfo(sessionId) { return infos.find((info) => info.sessionId === sessionId); },
    async renameSession(sessionId, title) { renamed.push({ sessionId, title }); },
  };
}

const now = Date.parse("2026-08-25T12:00:00.000Z");

describe("session-history", () => {
  it("recognizes UUIDs and rejects plain names", () => {
    expect(looksLikeSessionId("3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(true);
    expect(looksLikeSessionId("fix login bug")).toBe(false);
    expect(looksLikeSessionId("")).toBe(false);
  });

  it("formats relative time buckets", () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(formatRelativeTime(now - 400 * 86_400_000, now)).toBe("1y ago");
  });

  it("lists sessions most-recently-active first and prefers a custom title", async () => {
    const backend = fakeBackend([
      { sessionId: "a", summary: "Fix the login bug", lastModified: now - 60_000 },
      { sessionId: "b", summary: "auto summary", customTitle: "Refactor gateway", lastModified: now - 5_000 },
    ]);
    const entries = await listRecentSessions({ cwd: "/repo", backend });
    expect(entries.map((entry) => entry.sessionId)).toEqual(["b", "a"]);
    expect(entries[0]?.title).toBe("Refactor gateway");
    expect(entries[1]?.title).toBe("Fix the login bug");
  });

  it("falls back to a placeholder title when nothing is available", async () => {
    const backend = fakeBackend([{ sessionId: "a", summary: "   ", lastModified: now }]);
    const entries = await listRecentSessions({ cwd: "/repo", backend });
    expect(entries[0]?.title).toBe("Untitled session");
  });

  it("describes a picker row with name, time-since-activity, and branch", () => {
    expect(describeSessionPickerEntry({ sessionId: "a", title: "Fix login bug", lastModified: now - 7_200_000, gitBranch: "main" }, now))
      .toBe("Fix login bug — 2h ago · main");
    expect(describeSessionPickerEntry({ sessionId: "a", title: "Fix login bug", lastModified: now - 7_200_000 }, now))
      .toBe("Fix login bug — 2h ago");
  });

  describe("resolveResumeTarget", () => {
    it("trusts a bare session id without listing anything", async () => {
      const backend = fakeBackend([]);
      let listed = false;
      const spied: SessionsBackend = { ...backend, listSessions: async (options) => { listed = true; return backend.listSessions(options); } };
      const resolution = await resolveResumeTarget({ query: "3fa85f64-5717-4562-b3fc-2c963f66afa6", cwd: "/repo", backend: spied });
      expect(resolution).toEqual({ kind: "id", sessionId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" });
      expect(listed).toBe(false);
    });

    it("resolves an unambiguous name match", async () => {
      const backend = fakeBackend([
        { sessionId: "a", summary: "Fix the login bug", lastModified: now - 60_000 },
        { sessionId: "b", summary: "Refactor gateway routing", lastModified: now - 5_000 },
      ]);
      const resolution = await resolveResumeTarget({ query: "login", cwd: "/repo", backend });
      expect(resolution).toEqual({ kind: "id", sessionId: "a" });
    });

    it("reports not-found when nothing matches", async () => {
      const backend = fakeBackend([{ sessionId: "a", summary: "Fix the login bug", lastModified: now }]);
      expect(await resolveResumeTarget({ query: "nonexistent", cwd: "/repo", backend })).toEqual({ kind: "not-found" });
    });

    it("reports not-found when there is no history at all", async () => {
      const backend = fakeBackend([]);
      expect(await resolveResumeTarget({ cwd: "/repo", backend })).toEqual({ kind: "not-found" });
    });

    it("returns the sole session when no query is given and exactly one exists", async () => {
      const backend = fakeBackend([{ sessionId: "solo", summary: "Only session", lastModified: now }]);
      expect(await resolveResumeTarget({ cwd: "/repo", backend })).toEqual({ kind: "id", sessionId: "solo" });
    });

    it("is ambiguous with multiple matches, sorted most-recent-first", async () => {
      const backend = fakeBackend([
        { sessionId: "a", summary: "Fix login redirect", lastModified: now - 120_000 },
        { sessionId: "b", summary: "Fix login flicker", lastModified: now - 30_000 },
      ]);
      const resolution = await resolveResumeTarget({ query: "login", cwd: "/repo", backend });
      expect(resolution.kind).toBe("ambiguous");
      if (resolution.kind === "ambiguous") expect(resolution.candidates.map((entry) => entry.sessionId)).toEqual(["b", "a"]);
    });
  });

  it("renames a session through the backend, scoped to the given cwd", async () => {
    const backend = fakeBackend([]);
    await renameAlfaCodeSession("a", "New title", { cwd: "/repo", backend });
    expect(backend.renamed).toEqual([{ sessionId: "a", title: "New title" }]);
  });

  it("scopes CLAUDE_CONFIG_DIR for the duration of the call and restores it afterwards", async () => {
    const original = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      let seenDuringCall: string | undefined;
      await withSessionsConfigDir("/tmp/alfacode-test-config", async () => {
        seenDuringCall = process.env.CLAUDE_CONFIG_DIR;
      });
      expect(seenDuringCall).toBe("/tmp/alfacode-test-config");
      expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = original;
    }
  });

  it("restores a previous CLAUDE_CONFIG_DIR value even when the callback throws", async () => {
    const original = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/tmp/alfacode-previous";
    try {
      await expect(withSessionsConfigDir("/tmp/alfacode-other", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
      expect(process.env.CLAUDE_CONFIG_DIR).toBe("/tmp/alfacode-previous");
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = original;
    }
  });

  it("creates a real SDK-backed store that does not throw listing a directory with no sessions", async () => {
    const backend = createSessionsBackend("/tmp/alfacode-session-history-empty-config");
    await expect(backend.listSessions({ dir: "/tmp/alfacode-session-history-empty-cwd", includeProgrammatic: false })).resolves.toEqual([]);
  });
});
