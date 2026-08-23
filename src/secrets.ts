import { spawn } from "node:child_process";
import type { SecretReference } from "./config.js";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: { readonly interactive?: boolean }): Promise<CommandResult>;
}

export const systemCommandRunner: CommandRunner = {
  run(command, args, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ["inherit", "pipe", options?.interactive ? "inherit" : "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
    });
  },
};

export const keychainService = "polycode";

export class MacOSKeychain {
  constructor(private readonly runner: CommandRunner = systemCommandRunner) {}

  /** security prompts on its TTY because -w is intentionally the final argument, with no password in argv. */
  async store(account: string, service = keychainService): Promise<void> {
    const result = await this.runner.run("/usr/bin/security", ["add-generic-password", "-U", "-a", account, "-s", service, "-w"], { interactive: true });
    if (result.exitCode !== 0) throw new Error(`Unable to store secret in macOS Keychain: ${result.stderr.trim()}`);
  }

  async retrieve(account: string, service = keychainService): Promise<string | undefined> {
    const result = await this.runner.run("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service, "-w"]);
    if (result.exitCode !== 0) return undefined;
    const secret = result.stdout.replace(/\r?\n$/, "");
    return secret.length > 0 ? secret : undefined;
  }
}

export interface SecretResolverOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly keychain?: Pick<MacOSKeychain, "retrieve">;
}

export class SecretResolver {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly keychain: Pick<MacOSKeychain, "retrieve">;

  constructor(options: SecretResolverOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.keychain = options.keychain ?? new MacOSKeychain();
  }

  async resolve(reference: SecretReference): Promise<string | undefined> {
    if (reference.kind === "env") return this.environment[reference.name];
    return this.keychain.retrieve(reference.account, reference.service);
  }
}
