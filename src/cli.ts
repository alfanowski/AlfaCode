#!/usr/bin/env node
import { Command } from "commander";
import { ConfigStore, type ProviderRecord, type SecretReference } from "./config.js";
import { launchClaude, type ClaudeLaunchOptions } from "./claude-launcher.js";
import { MacOSKeychain } from "./secrets.js";

export interface RuntimeHandle {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly defaultModelId?: string;
  readonly contextWindowTokens?: number;
  close(): Promise<void>;
}

export type StartRuntime = (input: { provider: ProviderRecord; config: import("./config.js").PolycodeConfig }) => Promise<RuntimeHandle>;

export interface CreateCliOptions {
  readonly configStore?: ConfigStore;
  readonly keychain?: Pick<MacOSKeychain, "store">;
  readonly startRuntime?: StartRuntime;
  readonly launch?: (options: ClaudeLaunchOptions) => Promise<number>;
}

export function createCli(options: CreateCliOptions = {}): Command {
  const configStore = options.configStore ?? new ConfigStore();
  const keychain = options.keychain ?? new MacOSKeychain();
  const program = new Command();
  program.name("polycode")
    .description("Run Claude Code through a local Polycode gateway")
    .argument("[args...]", "Arguments passed unchanged to Claude")
    .allowUnknownOption(true);

  const provider = program.command("provider").description("Manage non-secret provider configuration");
  provider.command("add <type>")
    .option("--id <id>", "Provider identifier")
    .option("--api-key-env <name>", "Read API key from this environment variable")
    .option("--keychain", "Prompt and save API key in macOS Keychain")
    .action(async (type: string, flags: { id?: string; apiKeyEnv?: string; keychain?: boolean }) => {
      if (type !== "google") throw new Error(`Unsupported provider type: ${type}`);
      if (flags.apiKeyEnv !== undefined && flags.keychain) throw new Error("Use either --api-key-env or --keychain, not both");
      const id = flags.id ?? type;
      const apiKey: SecretReference | undefined = flags.apiKeyEnv === undefined
        ? flags.keychain ? { kind: "keychain", service: "polycode", account: id } : undefined
        : { kind: "env", name: flags.apiKeyEnv };
      if (flags.keychain) await keychain.store(id, "polycode");
      await configStore.update((config) => {
        if (config.providers.some((existing) => existing.id === id)) throw new Error(`Provider already exists: ${id}`);
        const record: ProviderRecord = apiKey === undefined ? { id, type } : { id, type, apiKey };
        return { ...config, providers: [...config.providers, record], defaultProviderId: config.defaultProviderId ?? id };
      });
      process.stdout.write(`Added provider ${id}\n`);
    });
  provider.command("list").action(async () => {
    for (const item of (await configStore.read()).providers) process.stdout.write(`${item.id}\t${item.type}\n`);
  });
  provider.command("remove <id>").action(async (id: string) => {
    await configStore.update((config) => {
      if (!config.providers.some((item) => item.id === id)) throw new Error(`Provider not found: ${id}`);
      const providers = config.providers.filter((item) => item.id !== id);
      return { ...config, providers, defaultProviderId: config.defaultProviderId === id ? providers[0]?.id : config.defaultProviderId };
    });
    process.stdout.write(`Removed provider ${id}\n`);
  });

  program.command("config").command("path").action(() => { process.stdout.write(`${configStore.path}\n`); });
  program.command("doctor").action(async () => {
    const config = await configStore.read();
    process.stdout.write(`Config: ${configStore.path}\nProviders: ${config.providers.length}\n`);
  });

  program.action(async (args: string[]) => {
    if (options.startRuntime === undefined) throw new Error("Gateway runtime is not configured yet");
    const config = await configStore.read();
    const providerId = config.defaultProviderId;
    const selected = config.providers.find((item) => item.id === providerId);
    if (selected === undefined) throw new Error("No default provider configured. Run: polycode provider add google");
    const runtime = await options.startRuntime({ provider: selected, config });
    try {
      const launchOptions: ClaudeLaunchOptions = {
        claudeArgs: args,
        baseUrl: runtime.baseUrl,
        authToken: runtime.authToken,
        ...(runtime.defaultModelId === undefined ? {} : { defaultModelId: runtime.defaultModelId }),
        ...(runtime.contextWindowTokens === undefined ? {} : { contextWindowTokens: runtime.contextWindowTokens }),
      };
      const exitCode = await (options.launch ?? launchClaude)(launchOptions);
      process.exitCode = exitCode;
    } finally {
      await runtime.close();
    }
  });
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await createCli().parseAsync(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
