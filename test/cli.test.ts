import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCli } from "../src/cli.js";
import { ConfigStore } from "../src/config.js";
import type { TerminalUi } from "../src/terminal-ui.js";
import type { AgentSession } from "../src/agent-session.js";
import { CAPABILITIES } from "../src/providers/foundation/types.js";
import type { SessionsBackend } from "../src/session-history.js";

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

function fakeSessionsBackend(sessions: ReadonlyArray<{ sessionId: string; summary: string; lastModified: number; customTitle?: string }>): SessionsBackend & { renamed: Array<{ sessionId: string; title: string }> } {
  const renamed: Array<{ sessionId: string; title: string }> = [];
  return {
    renamed,
    async listSessions() { return sessions.map((session) => ({ ...session })); },
    async getSessionInfo(sessionId) { return sessions.find((session) => session.sessionId === sessionId); },
    async renameSession(sessionId, title) { renamed.push({ sessionId, title }); },
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

  it("rejects an unsafe optional base URL from native setup before storing credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-base-url-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    let stored = false;
    const cli = createCli({
      configStore,
      keychain: {
        store: async () => undefined,
        storeSecret: async () => { stored = true; },
        delete: async () => undefined,
      },
      providerSetup: async (input) => {
        const google = input.descriptors.find((descriptor) => descriptor.id === "google");
        if (google === undefined) throw new Error("missing Google descriptor");
        await input.connect({ descriptor: google, apiKey: "secret", baseUrl: "http://attacker.example/v1" });
      },
      ui: fakeUi(),
    });

    await expect(cli.parseAsync(["node", "alfacode", "connect", "google"], { from: "node" })).rejects.toThrow("absolute HTTPS URL");
    expect(stored).toBe(false);
    expect((await configStore.read()).providers).toEqual([]);
  });

  it("treats an unexpected Keychain retrieval failure as an unavailable credential instead of crashing", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-keychain-fail-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [
      { id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } },
    ] });
    let notice: string | undefined;
    let retrieveCalls = 0;
    const cli = createCli({
      configStore,
      keychain: {
        store: async () => undefined,
        storeSecret: async () => undefined,
        delete: async () => undefined,
        // Fails only the initial availability check that selectedCredentialUnavailable performs;
        // succeeds afterward so this test isolates that one fix from the separate
        // backup-before-replace fix (covered by its own test below).
        retrieve: async () => { retrieveCalls += 1; if (retrieveCalls === 1) throw new Error("Keychain is locked"); return undefined; },
      },
      providerSetup: async (input) => {
        notice = input.notice;
        await input.connect({ descriptor: input.descriptors[0]!, apiKey: "fresh-secret" });
      },
      startRuntime: async (input) => ({
        baseUrl: "http://gateway",
        authToken: "token",
        modelCandidates: input.purpose === "discovery"
          ? [{ providerId: "google", id: "gemini", displayName: "Gemini", wireProtocol: "gemini-generate-content", capabilities: CAPABILITIES["gemini-generate-content"], availability: "available", support: "best-effort" }]
          : [],
        close: async () => undefined,
      }),
      launch: async () => 0,
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode", "launch"], { from: "node" });
    expect(notice).toContain("has no credential");
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
        expect(input.identity).toMatchObject({
          claudeCodeVersion: "pending",
          compatibility: { status: "pending", compatible: false, actual: "pending" },
        });
        return { type: "exit" };
      },
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode"], { from: "node" });
    expect(sessionClosed).toBe(true);
    expect(runtimeClosed).toBe(true);
  });

  it("defaults fullscreen mode on, honors --no-fullscreen to opt out, and keeps --fullscreen working as a no-op", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-fullscreen-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [
      { id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } },
    ] });
    const seenFullscreen: (boolean | undefined)[] = [];
    const cli = createCli({
      configStore,
      keychain: { store: async () => undefined, retrieve: async () => "configured" },
      startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
      startAgentSession: async (input) => ({ close: async () => input.runtime.close() }) as unknown as AgentSession,
      chatTui: async (input) => { seenFullscreen.push(input.fullscreen); return { type: "exit" }; },
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode"], { from: "node" });
    await cli.parseAsync(["node", "alfacode", "--fullscreen"], { from: "node" });
    await cli.parseAsync(["node", "alfacode", "--no-fullscreen"], { from: "node" });
    expect(seenFullscreen).toEqual([true, true, false]);
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

  it("refuses to replace a credential when backing up the previous one fails unexpectedly", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-backup-fail-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [
      { id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } },
    ] });
    let stored = false;
    let chatCalls = 0;
    const cli = createCli({
      configStore,
      keychain: {
        store: async () => undefined,
        storeSecret: async () => { stored = true; },
        retrieve: async () => { throw new Error("Keychain is locked"); },
        delete: async () => undefined,
      },
      startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
      startAgentSession: async (input) => ({ close: async () => input.runtime.close() }) as unknown as AgentSession,
      chatTui: async () => (++chatCalls === 1 ? { type: "reconnect-provider", providerId: "google" } : { type: "exit" }),
      providerSetup: async (input) => {
        const google = input.descriptors.find((descriptor) => descriptor.id === "google");
        if (google === undefined) throw new Error("missing Google descriptor");
        await input.connect({ descriptor: google, apiKey: "new-key" });
      },
      ui: fakeUi(),
    });

    await expect(cli.parseAsync(["node", "alfacode"], { from: "node" })).rejects.toThrow("Credential backup is unavailable");
    expect(stored).toBe(false);
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

  describe("default provider bootstrap", () => {
    it("seeds the anonymous Zen provider on a genuinely fresh install and skips the setup wizard", async () => {
      const home = await mkdtemp(join(tmpdir(), "alfacode-cli-bootstrap-"));
      directories.push(home);
      const configStore = new ConfigStore({ homeDirectory: home });
      expect(await configStore.exists()).toBe(false);

      let wizardLaunched = false;
      let runtimeClosed = false;
      const cli = createCli({
        configStore,
        keychain: { store: async () => undefined },
        providerSetup: async () => { wizardLaunched = true; },
        startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => { runtimeClosed = true; } }),
        startAgentSession: async (input) => ({ close: async () => input.runtime.close() }) as unknown as AgentSession,
        chatTui: async () => ({ type: "exit" }),
        ui: fakeUi(),
      });

      await cli.parseAsync(["node", "alfacode"], { from: "node" });

      expect(wizardLaunched).toBe(false);
      expect(runtimeClosed).toBe(true);
      expect(await configStore.read()).toEqual({
        version: 1,
        defaultProviderId: "zen",
        providers: [{ id: "zen", type: "opencode-zen", options: { catalogProviderId: "opencode" } }],
      });
    });

    it("seeds the same default through the classic (`launch`) entrypoint", async () => {
      const home = await mkdtemp(join(tmpdir(), "alfacode-cli-bootstrap-classic-"));
      directories.push(home);
      const configStore = new ConfigStore({ homeDirectory: home });
      let wizardLaunched = false;
      const cli = createCli({
        configStore,
        keychain: { store: async () => undefined },
        providerSetup: async () => { wizardLaunched = true; },
        startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
        launch: async () => 0,
        ui: fakeUi(),
      });

      await cli.parseAsync(["node", "alfacode", "launch"], { from: "node" });

      expect(wizardLaunched).toBe(false);
      expect((await configStore.read()).providers).toEqual([{ id: "zen", type: "opencode-zen", options: { catalogProviderId: "opencode" } }]);
    });

    it("never touches an existing config that already has providers", async () => {
      const home = await mkdtemp(join(tmpdir(), "alfacode-cli-bootstrap-existing-"));
      directories.push(home);
      const configStore = new ConfigStore({ homeDirectory: home });
      await configStore.write({
        version: 1,
        defaultProviderId: "google",
        providers: [{ id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } }],
      });

      const cli = createCli({
        configStore,
        keychain: { store: async () => undefined, retrieve: async () => "configured" },
        startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
        startAgentSession: async (input) => ({ close: async () => input.runtime.close() }) as unknown as AgentSession,
        chatTui: async () => ({ type: "exit" }),
        ui: fakeUi(),
      });

      await cli.parseAsync(["node", "alfacode"], { from: "node" });

      expect(await configStore.read()).toEqual({
        version: 1,
        defaultProviderId: "google",
        providers: [{ id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } }],
      });
    });

    it("does not seed a default when a config file exists but the user deliberately emptied it", async () => {
      const home = await mkdtemp(join(tmpdir(), "alfacode-cli-bootstrap-emptied-"));
      directories.push(home);
      const configStore = new ConfigStore({ homeDirectory: home });
      await configStore.write({ version: 1, providers: [] });
      expect(await configStore.exists()).toBe(true);

      const cli = createCli({
        configStore,
        keychain: { store: async () => undefined },
        startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
        providerSetup: async () => {
          // The wizard being reached at all, with the config still untouched, is the assertion:
          // an existing-but-empty config must never be silently repopulated with a default.
          expect(await configStore.read()).toEqual({ version: 1, providers: [] });
          throw new Error("stop-after-assertion");
        },
        ui: fakeUi(),
      });

      await expect(cli.parseAsync(["node", "alfacode"], { from: "node" })).rejects.toThrow("stop-after-assertion");
    });

    it("bootstraps a fresh install under `run --non-interactive` instead of failing", async () => {
      const home = await mkdtemp(join(tmpdir(), "alfacode-cli-bootstrap-run-"));
      directories.push(home);
      const configStore = new ConfigStore({ homeDirectory: home });
      let launched = false;
      const cli = createCli({
        configStore,
        keychain: { store: async () => undefined },
        startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
        launch: async () => { launched = true; return 0; },
        ui: fakeUi({ interactive: false }),
      });

      await cli.parseAsync(["node", "alfacode", "run", "--non-interactive"], { from: "node" });

      expect(launched).toBe(true);
      expect((await configStore.read()).providers).toEqual([{ id: "zen", type: "opencode-zen", options: { catalogProviderId: "opencode" } }]);
    });

    it("still fails `run --non-interactive` when the config file exists but has zero providers", async () => {
      const home = await mkdtemp(join(tmpdir(), "alfacode-cli-bootstrap-run-empty-"));
      directories.push(home);
      const configStore = new ConfigStore({ homeDirectory: home });
      await configStore.write({ version: 1, providers: [] });
      const cli = createCli({ configStore, ui: fakeUi({ interactive: false }) });

      await expect(cli.parseAsync(["node", "alfacode", "run", "--non-interactive"], { from: "node" })).rejects.toThrow("No provider configured");
    });

    it("reports a ready status with the seeded provider from `doctor` on a fresh install", async () => {
      const home = await mkdtemp(join(tmpdir(), "alfacode-cli-bootstrap-doctor-"));
      directories.push(home);
      const configStore = new ConfigStore({ homeDirectory: home });
      const written: string[] = [];
      const cli = createCli({ configStore, ui: fakeUi({ write: (message) => { written.push(message); } }) });

      await cli.parseAsync(["node", "alfacode", "doctor"], { from: "node" });

      expect(written.join("\n")).toContain("Status: ready");
      expect(written.join("\n")).toContain("Default provider: zen");
      expect((await configStore.read()).providers).toEqual([{ id: "zen", type: "opencode-zen", options: { catalogProviderId: "opencode" } }]);
    });
  });

  describe("session resume, continue, and naming", () => {
    async function nativeConfig(): Promise<ConfigStore> {
      const home = await mkdtemp(join(tmpdir(), "alfacode-cli-native-"));
      directories.push(home);
      const configStore = new ConfigStore({ homeDirectory: home });
      await configStore.write({ version: 1, defaultProviderId: "google", providers: [{ id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } }] });
      return configStore;
    }

    it("resumes a session by uuid directly, without listing sessions", async () => {
      const configStore = await nativeConfig();
      let listed = false;
      const backend = fakeSessionsBackend([]);
      const spiedBackend: SessionsBackend = { ...backend, listSessions: async (options) => { listed = true; return backend.listSessions(options); } };
      let captured: { resume?: string; continue?: boolean } | undefined;
      const cli = createCli({
        configStore,
        keychain: { store: async () => undefined, retrieve: async () => "configured" },
        startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
        startAgentSession: async (input) => { captured = { ...(input.resume === undefined ? {} : { resume: input.resume }), ...(input.continue === undefined ? {} : { continue: input.continue }) }; return { close: async () => input.runtime.close() } as unknown as AgentSession; },
        chatTui: async () => ({ type: "exit" }),
        sessionsBackend: spiedBackend,
        ui: fakeUi(),
      });

      await cli.parseAsync(["node", "alfacode", "--resume", "3fa85f64-5717-4562-b3fc-2c963f66afa6"], { from: "node" });
      expect(captured).toEqual({ resume: "3fa85f64-5717-4562-b3fc-2c963f66afa6" });
      expect(listed).toBe(false);
    });

    it("continues the most recent session with --continue, and never sends resume", async () => {
      const configStore = await nativeConfig();
      let captured: { resume?: string; continue?: boolean } | undefined;
      const cli = createCli({
        configStore,
        keychain: { store: async () => undefined, retrieve: async () => "configured" },
        startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
        startAgentSession: async (input) => { captured = { ...(input.resume === undefined ? {} : { resume: input.resume }), ...(input.continue === undefined ? {} : { continue: input.continue }) }; return { close: async () => input.runtime.close() } as unknown as AgentSession; },
        chatTui: async () => ({ type: "exit" }),
        ui: fakeUi(),
      });

      await cli.parseAsync(["node", "alfacode", "--continue"], { from: "node" });
      expect(captured).toEqual({ continue: true });
    });

    it("rejects combining --continue and --resume", async () => {
      const configStore = await nativeConfig();
      const cli = createCli({
        configStore,
        keychain: { store: async () => undefined, retrieve: async () => "configured" },
        startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
        ui: fakeUi(),
      });
      await expect(cli.parseAsync(["node", "alfacode", "--continue", "--resume", "x"], { from: "node" })).rejects.toThrow("Use either --continue or --resume, not both");
    });

    it("resolves an unambiguous --resume name without prompting", async () => {
      const configStore = await nativeConfig();
      const backend = fakeSessionsBackend([
        { sessionId: "session-a", summary: "Fix the login bug", lastModified: Date.now() - 60_000 },
        { sessionId: "session-b", summary: "Refactor gateway routing", lastModified: Date.now() - 5_000 },
      ]);
      let captured: string | undefined;
      let selectCalled = false;
      const cli = createCli({
        configStore,
        keychain: { store: async () => undefined, retrieve: async () => "configured" },
        startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
        startAgentSession: async (input) => { captured = input.resume; return { close: async () => input.runtime.close() } as unknown as AgentSession; },
        chatTui: async () => ({ type: "exit" }),
        sessionsBackend: backend,
        ui: fakeUi({ select: async (_message, choices) => { selectCalled = true; return choices[0]!.value; } }),
      });

      await cli.parseAsync(["node", "alfacode", "--resume", "login"], { from: "node" });
      expect(captured).toBe("session-a");
      expect(selectCalled).toBe(false);
    });

    it("prompts a picker when --resume is ambiguous and resumes the selected session", async () => {
      const configStore = await nativeConfig();
      const backend = fakeSessionsBackend([
        { sessionId: "session-a", summary: "Fix login redirect", lastModified: Date.now() - 120_000 },
        { sessionId: "session-b", summary: "Fix login flicker", lastModified: Date.now() - 30_000 },
      ]);
      let captured: string | undefined;
      const cli = createCli({
        configStore,
        keychain: { store: async () => undefined, retrieve: async () => "configured" },
        startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
        startAgentSession: async (input) => { captured = input.resume; return { close: async () => input.runtime.close() } as unknown as AgentSession; },
        chatTui: async () => ({ type: "exit" }),
        sessionsBackend: backend,
        ui: fakeUi({ select: async (_message, choices) => choices[1]!.value }),
      });

      await cli.parseAsync(["node", "alfacode", "--resume", "login"], { from: "node" });
      expect(captured).toBe("session-a");
    });

    it("rejects a --resume query that matches nothing", async () => {
      const configStore = await nativeConfig();
      const cli = createCli({
        configStore,
        keychain: { store: async () => undefined, retrieve: async () => "configured" },
        startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
        sessionsBackend: fakeSessionsBackend([]),
        ui: fakeUi(),
      });
      await expect(cli.parseAsync(["node", "alfacode", "--resume", "nonexistent"], { from: "node" })).rejects.toThrow('No session matches "nonexistent"');
    });

    it("names the session after it starts, via --name", async () => {
      const configStore = await nativeConfig();
      const renameCalls: string[] = [];
      const cli = createCli({
        configStore,
        keychain: { store: async () => undefined, retrieve: async () => "configured" },
        startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
        startAgentSession: async (input) => ({
          close: async () => input.runtime.close(),
          rename: async (title: string) => { renameCalls.push(title); },
        } as unknown as AgentSession),
        chatTui: async () => ({ type: "exit" }),
        ui: fakeUi(),
      });

      await cli.parseAsync(["node", "alfacode", "--name", "My session"], { from: "node" });
      expect(renameCalls).toEqual(["My session"]);
    });

    it("does not call rename when --name is not given", async () => {
      const configStore = await nativeConfig();
      let renameCalled = false;
      const cli = createCli({
        configStore,
        keychain: { store: async () => undefined, retrieve: async () => "configured" },
        startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
        startAgentSession: async (input) => ({
          close: async () => input.runtime.close(),
          rename: async () => { renameCalled = true; },
        } as unknown as AgentSession),
        chatTui: async () => ({ type: "exit" }),
        ui: fakeUi(),
      });

      await cli.parseAsync(["node", "alfacode"], { from: "node" });
      expect(renameCalled).toBe(false);
    });
  });

  describe("sessions command", () => {
    it("lists resumable sessions, name/summary and time-since-activity first", async () => {
      const home = await mkdtemp(join(tmpdir(), "alfacode-cli-sessions-"));
      directories.push(home);
      const configStore = new ConfigStore({ homeDirectory: home });
      const backend = fakeSessionsBackend([{ sessionId: "session-a", summary: "Fix the login bug", customTitle: "Login fix", lastModified: Date.now() - 60_000 }]);
      const written: string[] = [];
      const cli = createCli({ configStore, sessionsBackend: backend, ui: fakeUi({ write: (message) => { written.push(message); } }) });

      await cli.parseAsync(["node", "alfacode", "sessions"], { from: "node" });
      expect(written).toHaveLength(1);
      expect(written[0]).toContain("session-a");
      expect(written[0]).toContain("Login fix");
    });

    it("reports when there is nothing to resume", async () => {
      const home = await mkdtemp(join(tmpdir(), "alfacode-cli-sessions-empty-"));
      directories.push(home);
      const configStore = new ConfigStore({ homeDirectory: home });
      const written: string[] = [];
      const cli = createCli({ configStore, sessionsBackend: fakeSessionsBackend([]), ui: fakeUi({ write: (message) => { written.push(message); } }) });

      await cli.parseAsync(["node", "alfacode", "sessions"], { from: "node" });
      expect(written).toEqual(["No resumable sessions in this directory yet."]);
    });

    it("emits JSON with --json", async () => {
      const home = await mkdtemp(join(tmpdir(), "alfacode-cli-sessions-json-"));
      directories.push(home);
      const configStore = new ConfigStore({ homeDirectory: home });
      const backend = fakeSessionsBackend([{ sessionId: "session-a", summary: "Fix the login bug", lastModified: Date.now() }]);
      const written: string[] = [];
      const cli = createCli({ configStore, sessionsBackend: backend, ui: fakeUi({ write: (message) => { written.push(message); } }) });

      await cli.parseAsync(["node", "alfacode", "sessions", "--json"], { from: "node" });
      expect(JSON.parse(written[0]!)).toEqual([{ sessionId: "session-a", title: "Fix the login bug", lastModified: expect.any(Number) }]);
    });
  });
});
