import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCli } from "../src/cli.js";
import { ConfigStore } from "../src/config.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createCli", () => {
  it("uses macOS Keychain by default when adding a provider", async () => {
    const home = await mkdtemp(join(tmpdir(), "polycode-cli-test-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    const stored: string[] = [];
    const cli = createCli({
      configStore,
      keychain: { store: async (account) => { stored.push(account); } },
    });

    await cli.parseAsync(["node", "polycode", "provider", "add", "google", "--id", "personal"], { from: "node" });
    expect(stored).toEqual(["personal"]);
    expect(await configStore.read()).toEqual({
      version: 1,
      defaultProviderId: "personal",
      providers: [{ id: "personal", type: "google", apiKey: { kind: "keychain", service: "polycode", account: "personal" } }],
    });
  });

  it("passes unknown Claude arguments unchanged and closes the injected runtime", async () => {
    const home = await mkdtemp(join(tmpdir(), "polycode-cli-test-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [{ id: "google", type: "google" }] });
    const launched: unknown[] = [];
    let closed = false;
    const cli = createCli({
      configStore,
      startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", secretEnvironmentNames: ["CUSTOM_KEY"], close: async () => { closed = true; } }),
      launch: async (options) => { launched.push(options); return 0; },
    });

    await cli.parseAsync(["node", "polycode", "--resume", "session-id", "-p", "hello"], { from: "node" });
    expect(launched).toEqual([expect.objectContaining({ claudeArgs: ["--resume", "session-id", "-p", "hello"] })]);
    expect(launched).toEqual([expect.objectContaining({ scrubEnvironmentKeys: ["CUSTOM_KEY"] })]);
    expect(closed).toBe(true);
  });
});
