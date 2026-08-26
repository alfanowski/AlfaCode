import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCli } from "../src/cli.js";
import { ConfigStore } from "../src/config.js";
import type { TerminalUi } from "../src/terminal-ui.js";

const directories: string[] = [];

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "alfacode-outer-cli-"));
  directories.push(directory);
  return directory;
}

function ui(interactive = false): { terminal: TerminalUi; output: string[] } {
  const output: string[] = [];
  return {
    output,
    terminal: {
      interactive,
      color: false,
      write: (message) => { output.push(message); },
      select: async (_message, choices) => choices[0]!.value,
      ask: async (_message, fallback) => fallback ?? "google",
    },
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AlfaCode outer configuration CLI", () => {
  it("supports non-interactive environment references without calling Keychain", async () => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    const terminal = ui(false);
    const cli = createCli({ configStore, ui: terminal.terminal, keychain: { store: async () => { throw new Error("must not prompt"); } } });

    await cli.parseAsync(["node", "alfacode", "connect", "google", "--id", "ci", "--api-key-env", "GEMINI_API_KEY"], { from: "node" });
    expect(await configStore.read()).toMatchObject({ providers: [{ id: "ci", apiKey: { kind: "env", name: "GEMINI_API_KEY" } }] });
  });

  it.each(["", "9SECRET", "AWS-SECRET", "AWS.SECRET"])("rejects an invalid API key environment variable name: %s", async (name) => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    const cli = createCli({ configStore, ui: ui(false).terminal, keychain: { store: async () => { throw new Error("must not store"); } } });

    await expect(cli.parseAsync(["node", "alfacode", "connect", "google", "--api-key-env", name], { from: "node" }))
      .rejects.toThrow("API key environment variable");
    expect((await configStore.read()).providers).toEqual([]);
  });

  it("accepts lowercase environment variable names", async () => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    const cli = createCli({ configStore, ui: ui(false).terminal });

    await cli.parseAsync(["node", "alfacode", "connect", "google", "--api-key-env", "gemini_api_key"], { from: "node" });
    expect((await configStore.read()).providers[0]?.apiKey).toEqual({ kind: "env", name: "gemini_api_key" });
  });

  it("rejects Keychain prompts without a TTY", async () => {
    const cli = createCli({ configStore: new ConfigStore({ homeDirectory: await home() }), ui: ui(false).terminal });
    await expect(cli.parseAsync(["node", "alfacode", "connect", "google"], { from: "node" })).rejects.toThrow("interactive terminal");
  });

  it("rejects API keys pasted into the provider id field", async () => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    const cli = createCli({ configStore, ui: ui(false).terminal, keychain: { store: async () => { throw new Error("must not store"); } } });
    await expect(cli.parseAsync(["node", "alfacode", "connect", "zen", "--id", "sk-this-is-a-secret-not-a-provider-label", "--api-key-env", "ZEN_KEY"], { from: "node" }))
      .rejects.toThrow("looks like an API key");
    expect((await configStore.read()).providers).toEqual([]);
  });

  it("allocates local provider labels without asking users for an id", async () => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    const cli = createCli({ configStore, ui: ui(false).terminal });
    await cli.parseAsync(["node", "alfacode", "connect", "google", "--api-key-env", "GOOGLE_KEY_ONE"], { from: "node" });
    await cli.parseAsync(["node", "alfacode", "connect", "google", "--api-key-env", "GOOGLE_KEY_TWO"], { from: "node" });
    expect((await configStore.read()).providers.map((provider) => provider.id)).toEqual(["google", "google-2"]);
  });

  it("lists models and saves a selected default without secrets in output", async () => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [{ id: "google", type: "google", apiKey: { kind: "env", name: "PRIVATE_KEY" } }] });
    const terminal = ui(true);
    const cli = createCli({
      configStore,
      ui: terminal.terminal,
      discoverModels: async () => [{
        id: "alfacode-anthropic/google/gemini-test",
        displayName: "Gemini Test",
        availability: "available",
        capabilities: { streaming: true, tools: true },
        quota: { state: "limited", remainingRequests: 3 },
        headroom: { contextWindowTokens: 1_000_000, availableInputTokens: 900_000, maxOutputTokens: 64_000 },
      }],
    });

    await cli.parseAsync(["node", "alfacode", "models"], { from: "node" });
    await cli.parseAsync(["node", "alfacode", "default"], { from: "node" });
    expect((await configStore.read()).providers[0]?.options).toEqual({ defaultModel: "gemini-test" });
    expect(terminal.output.join("\n")).toContain("availability:available");
    expect(terminal.output.join("\n")).toContain("headroom:context=1000000");
    expect(terminal.output.join("\n")).not.toContain("PRIVATE_KEY");
  });

  it("clears a manual model pin back to automatic selection", async () => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [{ id: "google", type: "google", options: { defaultModel: "gemini-pinned" } }] });
    const cli = createCli({ configStore, ui: ui(false).terminal });
    await cli.parseAsync(["node", "alfacode", "default", "auto"], { from: "node" });
    expect((await configStore.read()).providers[0]?.options).toBeUndefined();
  });

  it("configures descriptor-driven providers without a hardcoded model catalog", async () => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    const cli = createCli({ configStore, ui: ui(false).terminal, keychain: { store: async () => { throw new Error("must not prompt"); } } });
    await cli.parseAsync(["node", "alfacode", "connect", "zen", "--id", "zen", "--api-key-env", "ZEN_KEY"], { from: "node" });
    await cli.parseAsync(["node", "alfacode", "connect", "anthropic", "--id", "anthropic", "--api-key-env", "ANTHROPIC_KEY"], { from: "node" });
    await cli.parseAsync(["node", "alfacode", "connect", "openai-compatible", "--id", "local", "--base-url", "http://127.0.0.1:4000/v1", "--api-key-env", "LOCAL_KEY"], { from: "node" });
    expect((await configStore.read()).providers).toMatchObject([
      { id: "zen", type: "opencode-zen" },
      { id: "anthropic", type: "anthropic" },
      { id: "local", type: "openai-compatible", options: { baseUrl: "http://127.0.0.1:4000/v1" } },
    ]);
  });

  it.each(["http://localhost:4000/v1", "http://127.0.0.1:4000/v1", "http://[::1]:4000/v1"])("allows HTTP only for an explicit loopback endpoint: %s", async (baseUrl) => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    const cli = createCli({ configStore, ui: ui(false).terminal });

    await cli.parseAsync(["node", "alfacode", "connect", "openai-compatible", "--base-url", baseUrl, "--api-key-env", "LOCAL_KEY"], { from: "node" });
    expect((await configStore.read()).providers[0]?.options?.baseUrl).toBe(baseUrl);
  });

  it("rejects a remote plaintext endpoint for a provider that requires a base URL", async () => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    const cli = createCli({ configStore, ui: ui(false).terminal });

    await expect(cli.parseAsync(["node", "alfacode", "connect", "openai-compatible", "--base-url", "http://attacker.example/v1", "--api-key-env", "COMPAT_KEY"], { from: "node" }))
      .rejects.toThrow("absolute HTTPS URL");
    expect((await configStore.read()).providers).toEqual([]);
  });

  it.each(["not-a-url", "file:///tmp/provider", "http://attacker.example/v1"])("validates a supplied base URL even when the provider does not require one: %s", async (baseUrl) => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    const cli = createCli({ configStore, ui: ui(false).terminal });

    await expect(cli.parseAsync(["node", "alfacode", "connect", "google", "--base-url", baseUrl, "--api-key-env", "GOOGLE_KEY"], { from: "node" }))
      .rejects.toThrow("absolute HTTPS URL");
    expect((await configStore.read()).providers).toEqual([]);
  });

  it("persists a valid optional HTTPS base URL", async () => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    const cli = createCli({ configStore, ui: ui(false).terminal });

    await cli.parseAsync(["node", "alfacode", "connect", "anthropic", "--base-url", "https://anthropic-proxy.example/v1", "--api-key-env", "ANTHROPIC_KEY"], { from: "node" });
    expect((await configStore.read()).providers[0]?.options?.baseUrl).toBe("https://anthropic-proxy.example/v1");
  });

  it("uses an injected provider catalog instead of a built-in CLI switch", async () => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    const cli = createCli({
      configStore,
      ui: ui(false).terminal,
      providerDescriptors: [{ id: "acme", configType: "acme-compatible", displayName: "Acme", description: "Injected at the platform boundary", requiresBaseUrl: true }],
      keychain: { store: async () => { throw new Error("must not prompt"); } },
    });
    await cli.parseAsync(["node", "alfacode", "connect", "acme", "--id", "acme", "--base-url", "https://api.acme.test/v1", "--api-key-env", "ACME_KEY"], { from: "node" });
    expect((await configStore.read()).providers).toMatchObject([{ id: "acme", type: "acme-compatible", options: { baseUrl: "https://api.acme.test/v1" } }]);
  });

  it("renders injected local usage data in human and JSON modes", async () => {
    const terminal = ui(false);
    const summary = {
      attempts: [{ id: "attempt", sessionKey: "redacted", agentKey: "redacted", providerId: "google", routeModelId: "route", upstreamModel: "model", usageCompleteness: "final" as const, outcome: "completed" as const, responseStarted: true, extendedContext: false, totalTokens: 12 }],
      totals: { inputTokens: 8, outputTokens: 4, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, toolTokens: 0, totalTokens: 12 },
    };
    const cli = createCli({ configStore: new ConfigStore({ homeDirectory: await home() }), ui: terminal.terminal, queryUsage: async () => summary });
    await cli.parseAsync(["node", "alfacode", "usage"], { from: "node" });
    await cli.parseAsync(["node", "alfacode", "usage", "--json", "--limit", "2"], { from: "node" });
    expect(terminal.output[0]).toContain("Tokens: total 12");
    expect(terminal.output[1]).toContain('"totalTokens":12');
  });

  it("removes only config by default and deletes a Keychain item only when requested", async () => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [{ id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } }] });
    const deleted: string[] = [];
    const cli = createCli({ configStore, ui: ui(false).terminal, keychain: { store: async () => {}, delete: async (account, service) => { deleted.push(`${service}/${account}`); } } });

    await cli.parseAsync(["node", "alfacode", "providers", "remove", "google", "--delete-keychain"], { from: "node" });
    expect(deleted).toEqual(["alfacode/google"]);
    expect((await configStore.read()).providers).toEqual([]);
  });

  it("imports legacy metadata without reading or changing the Keychain reference", async () => {
    const root = await home();
    const target = new ConfigStore({ homeDirectory: root });
    const legacyPath = join(root, ".polycode", "config.json");
    const legacy = new ConfigStore({ configPath: legacyPath, homeDirectory: root });
    await legacy.write({ version: 1, defaultProviderId: "legacy", providers: [{ id: "legacy", type: "google", apiKey: { kind: "keychain", service: "polycode", account: "legacy" } }] });
    const terminal = ui(false);
    const cli = createCli({ configStore: target, ui: terminal.terminal, legacyConfigPath: legacyPath });

    await cli.parseAsync(["node", "alfacode", "providers", "list"], { from: "node" });
    expect(await target.read()).toMatchObject({ providers: [{ apiKey: { kind: "keychain", service: "polycode", account: "legacy" } }] });
    expect(await legacy.read()).toMatchObject({ providers: [{ id: "legacy" }] });
    expect(terminal.output.join("\n")).not.toContain("AIza");
  });
});
