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
});
