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

  it("rejects Keychain prompts without a TTY", async () => {
    const cli = createCli({ configStore: new ConfigStore({ homeDirectory: await home() }), ui: ui(false).terminal });
    await expect(cli.parseAsync(["node", "alfacode", "connect", "google"], { from: "node" })).rejects.toThrow("interactive terminal");
  });

  it("lists models and saves a selected default without secrets in output", async () => {
    const configStore = new ConfigStore({ homeDirectory: await home() });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [{ id: "google", type: "google", apiKey: { kind: "env", name: "PRIVATE_KEY" } }] });
    const terminal = ui(true);
    const cli = createCli({
      configStore,
      ui: terminal.terminal,
      discoverModels: async () => [{ id: "alfacode-anthropic/google/gemini-test", displayName: "Gemini Test" }],
    });

    await cli.parseAsync(["node", "alfacode", "models"], { from: "node" });
    await cli.parseAsync(["node", "alfacode", "default"], { from: "node" });
    expect((await configStore.read()).providers[0]?.options).toEqual({ defaultModel: "gemini-test" });
    expect(terminal.output.join("\n")).not.toContain("PRIVATE_KEY");
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
