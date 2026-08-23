import { spawn } from "node:child_process";
import { Entry } from "@napi-rs/keyring";
import type { SecretReference } from "./config.js";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: { readonly interactive?: boolean; readonly input?: string }): Promise<CommandResult>;
}

export const systemCommandRunner: CommandRunner = {
  run(command, args, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: [options?.input === undefined ? "inherit" : "pipe", "pipe", options?.interactive ? "inherit" : "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
      if (options?.input !== undefined) child.stdin?.end(options.input);
    });
  },
};

export const keychainService = "alfacode";

export interface KeyringEntry {
  setPassword(secret: string): void;
  getPassword(): string | null;
  deletePassword(): boolean;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

export class MacOSKeychain {
  constructor(
    private readonly runner: CommandRunner = systemCommandRunner,
    private readonly entryFactory: KeyringEntryFactory = (service, account) => new Entry(service, account),
  ) {}

  /** security prompts on its TTY because -w is intentionally the final argument, with no password in argv. */
  async store(account: string, service = keychainService): Promise<void> {
    const result = await this.runner.run("/usr/bin/security", ["add-generic-password", "-U", "-a", account, "-s", service, "-w"], { interactive: true });
    if (result.exitCode !== 0) throw new Error(`Unable to store secret in macOS Keychain: ${result.stderr.trim()}`);
  }

  /** Stores a TUI-collected secret through stdin so it never appears in argv or a subprocess prompt. */
  async storeSecret(account: string, secret: string, service = keychainService): Promise<void> {
    if (secret.length === 0 || /[\r\n]/.test(secret)) throw new Error("Secret must be a non-empty single line");
    try {
      this.entryFactory(service, account).setPassword(secret);
    } catch (error) {
      throw new Error("Unable to store secret in the system credential vault", { cause: error });
    }
  }

  async retrieve(account: string, service = keychainService): Promise<string | undefined> {
    try {
      const secret = this.entryFactory(service, account).getPassword();
      return secret === null || secret.length === 0 ? undefined : secret;
    } catch {
      return undefined;
    }
  }

  async delete(account: string, service = keychainService): Promise<void> {
    try {
      this.entryFactory(service, account).deletePassword();
    } catch (error) {
      throw new Error("Unable to remove secret from the system credential vault", { cause: error });
    }
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
