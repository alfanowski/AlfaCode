import { describe, expect, it } from "vitest";
import { MacOSKeychain, SecretResolver, type CommandRunner } from "../src/secrets.js";

describe("MacOSKeychain", () => {
  it("prompts via security without putting the secret in argv", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: CommandRunner = { run: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    } };
    await new MacOSKeychain(runner).store("google-main");
    expect(calls).toEqual([{
      command: "/usr/bin/security",
      args: ["add-generic-password", "-U", "-a", "google-main", "-s", "polycode", "-w"],
    }]);
  });

  it("resolves portable env references without invoking Keychain", async () => {
    const keychain = { retrieve: async () => { throw new Error("must not run"); } };
    const resolver = new SecretResolver({ environment: { POLYCODE_KEY: "test-value" }, keychain });
    await expect(resolver.resolve({ kind: "env", name: "POLYCODE_KEY" })).resolves.toBe("test-value");
  });
});
