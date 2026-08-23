import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageLedger } from "../src/usage-ledger.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true }))); });

async function ledger() {
  const directory = await mkdtemp(join(tmpdir(), "alfacode-usage-"));
  directories.push(directory);
  return { directory, ledger: await UsageLedger.open(directory) };
}

const model = {
  id: "gemini-test",
  limits: { maxInputTokens: 1000, maxOutputTokens: 100, contextIncludesOutput: false },
  capabilities: { tokenCounting: "exact" as const, usageReporting: "final" as const },
};

describe("UsageLedger", () => {
  it("replaces cumulative snapshots and aggregates final provider usage", async () => {
    const { ledger: store } = await ledger();
    const attempt = await store.start({ session: "session-private", agent: "worker-a", providerId: "google", routeModelId: "alfacode-anthropic/google/gemini-test", upstreamModel: model.id, model, requestedOutputTokens: 100, extendedContext: true });
    await store.observe(attempt, { semantics: "cumulative", stage: "interim", source: "provider", inputTokens: 11, outputTokens: 2 });
    await store.observe(attempt, { semantics: "cumulative", stage: "final", source: "provider", inputTokens: 11, outputTokens: 5, cachedInputTokens: 3, reasoningTokens: 2, toolTokens: 1, totalTokens: 16 });
    await store.finish(attempt, "completed", true);

    const result = await store.query({ session: "session-private" });
    expect(result.totals).toEqual({ inputTokens: 11, outputTokens: 5, cachedInputTokens: 3, cacheWriteTokens: 0, reasoningTokens: 2, toolTokens: 1, totalTokens: 16 });
    expect(result.attempts[0]).toMatchObject({ outcome: "completed", usageCompleteness: "final", responseStarted: true, requestedOutputTokens: 100, extendedContext: true });
    await store.close();
  });

  it("keeps missing usage and cancellation distinguishable from a zero-token result", async () => {
    const { ledger: store } = await ledger();
    const attempt = await store.start({ session: "session-private", agent: "main", providerId: "google", routeModelId: "route", upstreamModel: model.id, model, extendedContext: false });
    await store.finish(attempt, "cancelled", true);
    const [record] = (await store.query({ session: "session-private" })).attempts;
    expect(record).toMatchObject({ outcome: "cancelled", usageCompleteness: "unknown", responseStarted: true });
    expect(record?.inputTokens).toBeUndefined();
    await store.close();
  });

  it("persists only pseudonymous metadata and recovers a corrupt database", async () => {
    const { directory, ledger: store } = await ledger();
    const secret = "prompt body and API key AIzaDontPersist";
    const attempt = await store.start({ session: secret, agent: "agent-private", providerId: "google", routeModelId: "route", upstreamModel: model.id, model, extendedContext: false });
    await store.finish(attempt, "failed", false, "api");
    await store.close();

    const database = await readFile(join(directory, "usage.sqlite"), "utf8");
    expect(database).not.toContain(secret);
    expect(database).not.toContain("agent-private");
    const secretStat = await (await import("node:fs/promises")).stat(join(directory, "ledger.key"));
    expect(secretStat.mode & 0o077).toBe(0);
    const databaseStat = await (await import("node:fs/promises")).stat(join(directory, "usage.sqlite"));
    expect(databaseStat.mode & 0o077).toBe(0);

    await rm(join(directory, "usage.sqlite"));
    await writeFile(join(directory, "usage.sqlite"), "not a sqlite database", { mode: 0o600 });
    await chmod(join(directory, "usage.sqlite"), 0o600);
    const recovered = await UsageLedger.open(directory);
    expect((await recovered.query()).attempts).toEqual([]);
    await recovered.close();
  });
});
