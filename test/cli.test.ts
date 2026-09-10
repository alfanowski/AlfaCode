import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCli } from "../src/cli.js";
import { ConfigStore, type AlfaCodeConfig } from "../src/config.js";
import type { TerminalUi } from "../src/terminal-ui.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fakeUi(overrides: Partial<TerminalUi> = {}): TerminalUi {
  return {
    interactive: true,
    color: false,
    write() {},
    select: async (_message, choices) => choices[0]!.value,
    ask: async (_message, fallback) => fallback ?? "",
    ...overrides,
  };
}

describe("createCli", () => {
  it("uses macOS Keychain by default when adding a provider", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-test-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    const stored: string[] = [];
    const cli = createCli({
      configStore,
      keychain: { store: async (account) => { stored.push(account); } },
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode", "provider", "add", "google", "--id", "personal"], { from: "node" });
    expect(stored).toEqual(["personal"]);
    expect(await configStore.read()).toEqual({
      version: 1,
      defaultProviderId: "personal",
      providers: [{ id: "personal", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "personal" } }],
    });
  });

  it("rejects an unsafe base URL passed to connect", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-base-url-"));
    directories.push(home);
    const cli = createCli({ configStore: new ConfigStore({ homeDirectory: home }), ui: fakeUi() });
    await expect(cli.parseAsync(
      ["node", "alfacode", "connect", "openai-compatible", "--base-url", "http://attacker.example/v1", "--api-key-env", "TEST_KEY"],
      { from: "node" },
    )).rejects.toThrow("absolute HTTPS URL");
  });

  it("prints runtime warnings without failing the launch", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-warn-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [{ id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } }] });
    const written: string[] = [];
    const cli = createCli({
      configStore,
      keychain: { store: async () => undefined },
      probeOllamaLocal: async () => false,
      startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], warnings: ["Provider 'google' unavailable: Keychain is locked"], close: async () => undefined }),
      launch: async () => 0,
      ui: fakeUi({ write: (message) => { written.push(message); } }),
    });

    await cli.parseAsync(["node", "alfacode", "launch"], { from: "node" });
    expect(written).toContain("Warning: Provider 'google' unavailable: Keychain is locked");
  });

  it("runs the launch flow when invoked with no subcommand", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-bare-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [{ id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } }] });
    const launched: unknown[] = [];
    const cli = createCli({
      configStore,
      keychain: { store: async () => undefined, retrieve: async () => "secret" },
      probeOllamaLocal: async () => false,
      startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
      launch: async (launchOptions) => { launched.push(launchOptions); return 0; },
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode", "--", "--print", "hi"], { from: "node" });
    expect(launched).toHaveLength(1);
  });

  it("passes unknown Claude arguments unchanged and closes the injected runtime", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-test-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [{ id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } }] });
    const launched: unknown[] = [];
    let closed = false;
    const cli = createCli({
      configStore,
      keychain: { store: async () => undefined, retrieve: async () => "configured" },
      probeOllamaLocal: async () => false,
      startRuntime: async () => ({
        baseUrl: "http://gateway",
        authToken: "token",
        modelCandidates: [{
          providerId: "google",
          id: "gemini-3-pro",
          displayName: "Gemini 3 Pro",
          wireProtocol: "gemini-generate-content",
          capabilities: { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: false, reasoningState: "optional", nativeTokenCounting: true, jsonSchema: "full" },
          availability: "available",
          support: "contract-tested",
        }],
        secretEnvironmentNames: ["CUSTOM_KEY"],
        close: async () => { closed = true; },
      }),
      launch: async (options) => { launched.push(options); return 0; },
    });

    await cli.parseAsync(["node", "alfacode", "launch", "--resume", "session-id", "-p", "hello"], { from: "node" });
    expect(launched).toEqual([expect.objectContaining({ claudeArgs: ["--resume", "session-id", "-p", "hello"] })]);
    expect(launched).toEqual([expect.objectContaining({ scrubEnvironmentKeys: ["CUSTOM_KEY"] })]);
    expect(closed).toBe(true);
  });

  it("skips the gateway entirely and launches plain claude when no provider is available", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-no-provider-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    let startRuntimeCalls = 0;
    const launched: unknown[] = [];
    const cli = createCli({
      configStore,
      keychain: { store: async () => undefined },
      probeOllamaLocal: async () => false,
      startRuntime: async () => { startRuntimeCalls += 1; return { baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }; },
      launch: async (options) => { launched.push(options); return 0; },
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode", "--", "--print", "hi"], { from: "node" });
    expect(startRuntimeCalls).toBe(0);
    expect(launched).toEqual([{ claudeArgs: ["--print", "hi"], baseUrl: "", authToken: "" }]);
  });

  it("adds a local Ollama provider automatically when it's reachable and not already configured", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-ollama-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    const seenConfigs: AlfaCodeConfig[] = [];
    const cli = createCli({
      configStore,
      probeOllamaLocal: async () => true,
      startRuntime: async (input) => { seenConfigs.push(input.config); return { baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }; },
      launch: async () => 0,
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode"], { from: "node" });
    expect(seenConfigs[0]?.providers.map((provider) => provider.id)).toEqual(["ollama-local"]);
    expect(await configStore.exists()).toBe(false);
  });

  it("does not duplicate an already-configured ollama-local provider", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-ollama-dup-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, providers: [{ id: "ollama-local", type: "ollama-local" }] });
    const seenConfigs: AlfaCodeConfig[] = [];
    const cli = createCli({
      configStore,
      probeOllamaLocal: async () => true,
      startRuntime: async (input) => { seenConfigs.push(input.config); return { baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }; },
      launch: async () => 0,
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode"], { from: "node" });
    expect(seenConfigs[0]?.providers).toHaveLength(1);
  });

  it("does not duplicate a hand-configured provider that already claims the reserved ollama-local id under a different type", async () => {
    // A user could have run `alfacode connect openai-compatible --id ollama-local --base-url ...`
    // before this auto-detection feature existed. Matching on type alone would miss this and
    // inject a second record with the same id, which createGatewayServer/config validation both
    // reject as a duplicate id and hard-crash on.
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-ollama-id-collision-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({
      version: 1,
      providers: [{ id: "ollama-local", type: "openai-compatible", apiKey: { kind: "env", name: "OLLAMA_KEY" }, options: { baseUrl: "http://localhost:11434/v1" } }],
    });
    let probeCalls = 0;
    const seenConfigs: AlfaCodeConfig[] = [];
    const cli = createCli({
      configStore,
      probeOllamaLocal: async () => { probeCalls += 1; return true; },
      startRuntime: async (input) => { seenConfigs.push(input.config); return { baseUrl: "http://gateway", authToken: "token", modelCandidates: [{ providerId: "ollama-local", id: "gemma", displayName: "Gemma", wireProtocol: "openai-chat", capabilities: { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: false, reasoningState: "none", nativeTokenCounting: false, jsonSchema: "subset" }, availability: "available", support: "best-effort" }], close: async () => undefined }; },
      launch: async () => 0,
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode"], { from: "node" });
    expect(probeCalls).toBe(0);
    expect(seenConfigs[0]?.providers).toHaveLength(1);
    expect(seenConfigs[0]?.providers[0]).toMatchObject({ id: "ollama-local", type: "openai-compatible" });
  });

  it("falls back to plain claude when the gateway resolves zero usable models", async () => {
    // Ollama daemon reachable but no model pulled yet (discoverAccountModels throws), or an expired
    // key: startRuntime still succeeds but reports zero modelCandidates. The gateway would then be
    // empty and useless to claude (nothing in /model, every request 404s) — this should behave like
    // the zero-provider passthrough case instead.
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-no-models-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, providers: [{ id: "ollama-local", type: "ollama-local" }] });
    const written: string[] = [];
    const launched: unknown[] = [];
    let closed = false;
    const cli = createCli({
      configStore,
      probeOllamaLocal: async () => false,
      startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], warnings: ["Provider 'ollama-local' unavailable: model discovery returned no valid models"], close: async () => { closed = true; } }),
      launch: async (options) => { launched.push(options); return 0; },
      ui: fakeUi({ write: (message) => { written.push(message); } }),
    });

    await cli.parseAsync(["node", "alfacode", "--", "--print", "hi"], { from: "node" });
    expect(written).toContain("Warning: Provider 'ollama-local' unavailable: model discovery returned no valid models");
    expect(launched).toEqual([{ claudeArgs: ["--print", "hi"], baseUrl: "", authToken: "" }]);
    expect(closed).toBe(true);
  });

  it("alfacode doctor sees the auto-detected local Ollama provider instead of reporting passthrough", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-doctor-ollama-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    const written: string[] = [];
    const cli = createCli({
      configStore,
      probeOllamaLocal: async () => true,
      ui: fakeUi({ write: (message) => { written.push(message); } }),
    });

    await cli.parseAsync(["node", "alfacode", "doctor", "--json"], { from: "node" });
    const report = JSON.parse(written[0]!) as { providers: readonly { id: string }[]; status: string };
    expect(report.providers.map((provider) => provider.id)).toEqual(["ollama-local"]);
    expect(report.status).toBe("ready");
  });

  it("alfacode doctor reports passthrough, not setup-required, with zero usable providers", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-doctor-empty-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    const written: string[] = [];
    const cli = createCli({
      configStore,
      probeOllamaLocal: async () => false,
      ui: fakeUi({ write: (message) => { written.push(message); } }),
    });

    await cli.parseAsync(["node", "alfacode", "doctor", "--json"], { from: "node" });
    const report = JSON.parse(written[0]!) as { status: string };
    expect(report.status).toBe("passthrough");
  });

  it("alfacode models sees the auto-detected local Ollama provider", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-models-ollama-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    const written: string[] = [];
    const cli = createCli({
      configStore,
      probeOllamaLocal: async () => true,
      startRuntime: async () => ({
        baseUrl: "http://gateway",
        authToken: "token",
        modelCandidates: [{
          providerId: "ollama-local",
          id: "gemma3",
          displayName: "Gemma 3",
          wireProtocol: "openai-chat",
          capabilities: { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: false, reasoningState: "none", nativeTokenCounting: false, jsonSchema: "subset" },
          availability: "available",
          support: "best-effort",
        }],
        close: async () => undefined,
      }),
      ui: fakeUi({ write: (message) => { written.push(message); } }),
    });

    await cli.parseAsync(["node", "alfacode", "models"], { from: "node" });
    expect(written.some((line) => line.includes("gemma3"))).toBe(true);
    expect(written).not.toContain("No models available.");
  });

});
