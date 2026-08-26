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

  it("refuses to resolve Keychain references outside the AlfaCode service", async () => {
    const keychain = { retrieve: async () => { throw new Error("must not run"); } };
    const resolver = new SecretResolver({ keychain });
    await expect(resolver.resolve({ kind: "keychain", service: "another-app", account: "google-main" }))
      .rejects.toThrow("Refusing to read a legacy Keychain record");
  });

  it("resolves Keychain references in the AlfaCode service", async () => {
    const calls: Array<{ account: string; service: string }> = [];
    const keychain = { retrieve: async (account: string, service: string) => {
      calls.push({ account, service });
      return "test-value";
    } };
    const resolver = new SecretResolver({ keychain });
    await expect(resolver.resolve({ kind: "keychain", service: "alfacode", account: "google-main" }))
      .resolves.toBe("test-value");
    expect(calls).toEqual([{ account: "google-main", service: "alfacode" }]);
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

  it("returns undefined when a Keychain entry is not found", async () => {
    const runner: CommandRunner = { run: async () => { throw new Error("must not spawn"); } };
    const entryFactory = () => ({
      setPassword: () => undefined,
      getPassword: () => null,
      deletePassword: () => true,
    });
    await expect(new MacOSKeychain(runner, entryFactory).retrieve("missing-account"))
      .resolves.toBeUndefined();
  });

  it("surfaces Keychain retrieval failures", async () => {
    const runner: CommandRunner = { run: async () => { throw new Error("must not spawn"); } };
    const keychainError = new Error("Keychain is locked");
    const entryFactory = () => ({
      setPassword: () => undefined,
      getPassword: () => { throw keychainError; },
      deletePassword: () => true,
    });
    const retrieval = new MacOSKeychain(runner, entryFactory).retrieve("google-main");
    await expect(retrieval).rejects.toThrow("Unable to retrieve secret from the system credential vault");
    await expect(retrieval).rejects.toMatchObject({ cause: keychainError });
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
