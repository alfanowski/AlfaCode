import { describe, expect, it } from "vitest";
import { MacOSKeychain, SecretResolver, type CommandRunner } from "../src/secrets.js";

describe("MacOSKeychain", () => {
  it("prompts via security without putting the secret in argv", async () => {
    const calls: Array<{ command: string; args: readonly string[]; options?: { readonly interactive?: boolean } }> = [];
    const runner: CommandRunner = { run: async (command, args, options) => {
      calls.push({ command, args, ...(options === undefined ? {} : { options }) });
      return { stdout: "", stderr: "", exitCode: 0 };
    } };
    await new MacOSKeychain(runner).store("google-main");
    expect(calls).toEqual([{
      command: "/usr/bin/security",
      args: ["add-generic-password", "-U", "-a", "google-main", "-s", "alfacode", "-w"],
      options: { interactive: true },
    }]);
  });

  it("resolves portable env references without invoking Keychain", async () => {
    const keychain = { retrieve: async () => { throw new Error("must not run"); } };
    const resolver = new SecretResolver({ environment: { ALFACODE_KEY: "test-value" }, keychain });
    await expect(resolver.resolve({ kind: "env", name: "ALFACODE_KEY" })).resolves.toBe("test-value");
  });

  it("stores a TUI secret through the native credential vault without spawning", async () => {
    const calls: Array<{ service: string; account: string; secret: string }> = [];
    const runner: CommandRunner = { run: async () => { throw new Error("must not spawn"); } };
    const entryFactory = (service: string, account: string) => ({
      setPassword: (secret: string) => calls.push({ service, account, secret }),
      getPassword: () => null,
      deletePassword: () => true,
    });
    await new MacOSKeychain(runner, entryFactory).storeSecret("google-main", "secret-value");
    expect(calls).toEqual([{ service: "alfacode", account: "google-main", secret: "secret-value" }]);
  });

  it("deletes only the named Keychain record", async () => {
    const calls: Array<{ service: string; account: string }> = [];
    const runner: CommandRunner = { run: async () => { throw new Error("must not spawn"); } };
    const entryFactory = (service: string, account: string) => ({
      setPassword: () => undefined,
      getPassword: () => null,
      deletePassword: () => { calls.push({ service, account }); return true; },
    });
    await new MacOSKeychain(runner, entryFactory).delete("google-work", "alfacode");
    expect(calls).toEqual([{ service: "alfacode", account: "google-work" }]);
  });
});
