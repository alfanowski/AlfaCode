import { chmod, lstat, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "polycode-test-")));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ConfigStore", () => {
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

  it("refuses symlinked config directories and files", async () => {
    const home = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    await symlink(outside, join(home, ".polycode"));
    await expect(new ConfigStore({ homeDirectory: home }).write({ version: 1, providers: [] })).rejects.toThrow("symbolic link");

    const directory = join(home, "safe");
    await mkdir(directory);
    await chmod(directory, 0o700);
    await symlink(join(outside, "config.json"), join(directory, "config.json"));
    await expect(new ConfigStore({ configPath: join(directory, "config.json") }).read()).rejects.toThrow("symbolic link");
  });
});
