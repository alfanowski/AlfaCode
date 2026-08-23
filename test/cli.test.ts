import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCli } from "../src/cli.js";
import { ConfigStore } from "../src/config.js";
import type { TerminalUi } from "../src/terminal-ui.js";
import type { AgentSession } from "../src/agent-session.js";
import { CAPABILITIES } from "../src/providers/foundation/types.js";

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
      startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", secretEnvironmentNames: ["CUSTOM_KEY"], close: async () => { closed = true; } }),
      launch: async (options) => { launched.push(options); return 0; },
    });

    await cli.parseAsync(["node", "alfacode", "launch", "--resume", "session-id", "-p", "hello"], { from: "node" });
    expect(launched).toEqual([expect.objectContaining({ claudeArgs: ["--resume", "session-id", "-p", "hello"] })]);
    expect(launched).toEqual([expect.objectContaining({ scrubEnvironmentKeys: ["CUSTOM_KEY"] })]);
    expect(closed).toBe(true);
  });

  it("starts the native AlfaCode UI by default with every provider model", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-native-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [
      { id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } },
      { id: "zen", type: "opencode-zen" },
    ] });
    let runtimeClosed = false;
    let sessionClosed = false;
    const cli = createCli({
      configStore,
      keychain: { store: async () => undefined, retrieve: async () => "configured" },
      startRuntime: async () => ({
        baseUrl: "http://gateway", authToken: "token", defaultModelId: "alfacode-anthropic/zen/free-model",
        modelCandidates: [
          { providerId: "google", id: "gemini", displayName: "Gemini", wireProtocol: "gemini-generate-content", capabilities: CAPABILITIES["gemini-generate-content"], availability: "available", support: "best-effort" },
          { providerId: "zen", id: "free-model", displayName: "Free model", wireProtocol: "openai-chat", capabilities: CAPABILITIES["openai-chat"], availability: "available", support: "best-effort" },
        ],
        close: async () => { runtimeClosed = true; },
      }),
      startAgentSession: async (input) => ({ close: async () => { sessionClosed = true; await input.runtime.close(); } }) as unknown as AgentSession,
      chatTui: async (input) => {
        expect(input.config.providers.map((provider) => provider.id)).toEqual(["google", "zen"]);
        expect(input.models.map((model) => model.providerId)).toEqual(["google", "zen"]);
        return { type: "exit" };
      },
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode"], { from: "node" });
    expect(sessionClosed).toBe(true);
    expect(runtimeClosed).toBe(true);
  });

  it("restores the previous Keychain secret when reconnect validation fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-reconnect-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [
      { id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } },
    ] });
    let secret: string | undefined = "working-key";
    let chatCalls = 0;
    const cli = createCli({
      configStore,
      keychain: {
        store: async () => undefined,
        storeSecret: async (_account, value) => { secret = value; },
        retrieve: async () => secret,
        delete: async () => { secret = undefined; },
      },
      startRuntime: async (input) => {
        if (input.purpose === "discovery") throw new Error("invalid replacement key");
        return { baseUrl: "http://gateway", authToken: "token", defaultModelId: "route/model", modelCandidates: [], close: async () => undefined };
      },
      startAgentSession: async (input) => ({ close: async () => input.runtime.close() }) as unknown as AgentSession,
      chatTui: async () => (++chatCalls === 1 ? { type: "reconnect-provider", providerId: "google" } : { type: "exit" }),
      providerSetup: async (input) => {
        const google = input.descriptors.find((descriptor) => descriptor.id === "google");
        if (google === undefined) throw new Error("missing Google descriptor");
        await input.connect({ descriptor: google, apiKey: "broken-key" });
      },
      ui: fakeUi(),
    });

    await expect(cli.parseAsync(["node", "alfacode"], { from: "node" })).rejects.toThrow("invalid replacement key");
    expect(secret).toBe("working-key");
    expect(await configStore.read()).toMatchObject({ providers: [{ id: "google", type: "google" }] });
  });

  it("reconnects missing credentials through the native setup before launch", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-test-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({
      version: 1,
      defaultProviderId: "zen",
      providers: [{ id: "zen", type: "opencode-zen", apiKey: { kind: "keychain", service: "alfacode", account: "zen" } }],
    });
    let stored: string | undefined;
    let launched = false;
    const cli = createCli({
      configStore,
      keychain: {
        store: async () => undefined,
        storeSecret: async (_account, secret) => { stored = secret; },
        retrieve: async () => stored,
        delete: async () => { stored = undefined; },
      },
      providerSetup: async (options) => {
        expect(options.notice).toContain("zen");
        const zen = options.descriptors.find((item) => item.id === "zen");
        if (zen === undefined) throw new Error("missing test descriptor");
        await options.connect({ descriptor: zen, apiKey: "new-key" });
      },
      startRuntime: async (input) => ({
        baseUrl: "http://gateway",
        authToken: "token",
        modelCandidates: [{
          providerId: "zen",
          id: "dynamic-model",
          displayName: "Dynamic model",
          wireProtocol: "openai-responses",
          capabilities: CAPABILITIES["openai-responses"],
          availability: "available",
          support: "best-effort",
        }],
        ...(input.purpose === "launch" ? { defaultModelId: "alfacode-anthropic/zen/dynamic-model" } : {}),
        close: async () => undefined,
      }),
      launch: async () => { launched = true; return 0; },
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode", "launch"], { from: "node" });
    expect(stored).toBe("new-key");
    expect(launched).toBe(true);
    expect(await configStore.read()).toMatchObject({ defaultProviderId: "zen", providers: [{ id: "zen", type: "opencode-zen" }] });
  });
});
