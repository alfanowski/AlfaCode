import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCli } from "../src/cli.js";
import { ConfigStore } from "../src/config.js";
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
      startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", secretEnvironmentNames: ["CUSTOM_KEY"], close: async () => { closed = true; } }),
      launch: async (options) => { launched.push(options); return 0; },
    });

    await cli.parseAsync(["node", "alfacode", "launch", "--resume", "session-id", "-p", "hello"], { from: "node" });
    expect(launched).toEqual([expect.objectContaining({ claudeArgs: ["--resume", "session-id", "-p", "hello"] })]);
    expect(launched).toEqual([expect.objectContaining({ scrubEnvironmentKeys: ["CUSTOM_KEY"] })]);
    expect(closed).toBe(true);
  });

  describe("default provider bootstrap", () => {
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
});
