import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, migrateLegacyConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "alfacode-test-")));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ConfigStore", () => {
  it("returns an empty config before its directory exists", async () => {
    const home = await createTemporaryDirectory();
    expect(await new ConfigStore({ homeDirectory: home }).read()).toEqual({ version: 1, providers: [] });
  });

  it("writes validated non-secret config atomically with private permissions", async () => {
    const home = await createTemporaryDirectory();
    const store = new ConfigStore({ homeDirectory: home });
    await store.write({
      version: 1,
      defaultProviderId: "google",
      providers: [{ id: "google", type: "google", apiKey: { kind: "env", name: "GOOGLE_API_KEY" } }],
    });

    expect(await store.read()).toEqual({
      version: 1,
      defaultProviderId: "google",
      providers: [{ id: "google", type: "google", apiKey: { kind: "env", name: "GOOGLE_API_KEY" } }],
    });
    expect((await lstat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(store.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(store.path, "utf8")).not.toContain("AIza");
  });

  it("rejects credentials used as provider identifiers", async () => {
    const store = new ConfigStore({ homeDirectory: await createTemporaryDirectory() });
    await expect(store.write({ version: 1, providers: [{ id: "nvapi-this-is-a-secret-not-a-label", type: "catalog" }] }))
      .rejects.toThrow("Provider id must be a local label");
  });

  it("refuses symlinked config directories and files", async () => {
    const home = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    await symlink(outside, join(home, ".alfacode"));
    await expect(new ConfigStore({ homeDirectory: home }).write({ version: 1, providers: [] })).rejects.toThrow("symbolic link");

    const directory = join(home, "safe");
    await mkdir(directory);
    await chmod(directory, 0o700);
    const outsideConfig = join(outside, "config.json");
    await writeFile(outsideConfig, JSON.stringify({ version: 1, providers: [] }), { mode: 0o600 });
    await symlink(outsideConfig, join(directory, "config.json"));
    await expect(new ConfigStore({ configPath: join(directory, "config.json") }).read()).rejects.toThrow("symbolic link");
  });

  it("refuses non-regular config files", async () => {
    const home = await createTemporaryDirectory();
    const directory = join(home, ".alfacode");
    await mkdir(join(directory, "config.json"), { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    await expect(new ConfigStore({ homeDirectory: home }).read()).rejects.toThrow("Expected regular file");
  });

  it("refuses group-readable config files", async () => {
    const home = await createTemporaryDirectory();
    const store = new ConfigStore({ homeDirectory: home });
    await store.write({ version: 1, providers: [] });
    await chmod(store.path, 0o640);
    await expect(store.read()).rejects.toThrow("insecure permissions");
  });

  it("migrates legacy metadata once without changing its Keychain reference", async () => {
    const home = await createTemporaryDirectory();
    const target = new ConfigStore({ homeDirectory: home });
    const legacyPath = join(home, ".polycode", "config.json");
    const legacy = new ConfigStore({ homeDirectory: home, configPath: legacyPath });
    await legacy.write({ version: 1, defaultProviderId: "old", providers: [{ id: "old", type: "google", apiKey: { kind: "keychain", service: "polycode", account: "old" } }] });

    await expect(migrateLegacyConfig({ target, legacyConfigPath: legacyPath })).resolves.toMatchObject({ migrated: true });
    expect(await target.read()).toMatchObject({ providers: [{ apiKey: { kind: "keychain", service: "polycode", account: "old" } }] });
    await expect(migrateLegacyConfig({ target, legacyConfigPath: legacyPath })).resolves.toMatchObject({ migrated: false });
    expect(await legacy.read()).toMatchObject({ providers: [{ id: "old" }] });
  });
});
