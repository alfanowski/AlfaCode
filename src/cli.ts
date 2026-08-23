#!/usr/bin/env node
import { Command } from "commander";
import { decodeModelId } from "./model-id.js";
import { ConfigStore, migrateLegacyConfig, type AlfaCodeConfig, type ProviderRecord, type SecretReference } from "./config.js";
import { launchClaude, type ClaudeLaunchOptions } from "./claude-launcher.js";
import { keychainService, MacOSKeychain } from "./secrets.js";
import { startRuntime } from "./runtime.js";
import { createTerminalUi, requireInteractive, type TerminalUi } from "./terminal-ui.js";

export interface RuntimeHandle {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly defaultModelId?: string;
  readonly secretEnvironmentNames?: readonly string[];
  close(): Promise<void>;
}

export interface GatewayModel {
  readonly id: string;
  readonly displayName: string;
}

export type StartRuntime = (input: { provider: ProviderRecord; config: AlfaCodeConfig }) => Promise<RuntimeHandle>;
export type DiscoverModels = (input: { provider: ProviderRecord; config: AlfaCodeConfig }) => Promise<readonly GatewayModel[]>;

export interface CreateCliOptions {
  readonly configStore?: ConfigStore;
  readonly keychain?: Pick<MacOSKeychain, "store"> & Partial<Pick<MacOSKeychain, "delete">>;
  readonly startRuntime?: StartRuntime;
  readonly discoverModels?: DiscoverModels;
  readonly launch?: (options: ClaudeLaunchOptions) => Promise<number>;
  readonly ui?: TerminalUi;
  readonly legacyConfigPath?: string;
}

interface ConnectFlags { readonly id?: string; readonly apiKeyEnv?: string; readonly keychain?: boolean; }
interface RemoveFlags { readonly deleteKeychain?: boolean; }

export function createCli(options: CreateCliOptions = {}): Command {
  const configStore = options.configStore ?? new ConfigStore();
  const keychain = options.keychain ?? new MacOSKeychain();
  const runtimeStarter = options.startRuntime;
  const ui = options.ui ?? createTerminalUi();
  let migrationChecked = false;

  const loadConfig = async (): Promise<AlfaCodeConfig> => {
    if (!migrationChecked) {
      migrationChecked = true;
      const result = await migrateLegacyConfig({ target: configStore, ...(options.legacyConfigPath === undefined ? {} : { legacyConfigPath: options.legacyConfigPath }) });
      if (result.migrated) ui.write(`Imported legacy AlfaCode metadata from ${result.sourcePath}. Keychain references were kept in place.`);
    }
    return configStore.read();
  };

  const selectedProvider = async (config: AlfaCodeConfig, id?: string): Promise<ProviderRecord> => {
    const provider = config.providers.find((item) => item.id === (id ?? config.defaultProviderId));
    if (provider === undefined) throw new Error("No provider is selected. Run: alfacode connect google");
    return provider;
  };

  const catalog = async (config: AlfaCodeConfig, provider?: ProviderRecord): Promise<readonly GatewayModel[]> => {
    const selected = provider ?? await selectedProvider(config);
    if (options.discoverModels !== undefined) return options.discoverModels({ provider: selected, config });
    if (runtimeStarter === undefined) throw new Error("Model discovery is not configured yet");
    return discoverModelsFromGateway(runtimeStarter, { provider: selected, config });
  };

  const connect = async (type: string, flags: ConnectFlags): Promise<ProviderRecord> => {
    if (type !== "google") throw new Error(`Unsupported provider type: ${type}`);
    if (flags.apiKeyEnv !== undefined && flags.keychain) throw new Error("Use either --api-key-env or --keychain, not both");
    const id = flags.id ?? (ui.interactive ? await ui.ask("Provider id", type) : type);
    if (id.length === 0) throw new Error("Provider id is required");
    const useKeychain = flags.keychain || flags.apiKeyEnv === undefined;
    if (useKeychain) requireInteractive(ui.interactive);
    const apiKey: SecretReference = flags.apiKeyEnv === undefined
      ? { kind: "keychain", service: "alfacode", account: id }
      : { kind: "env", name: flags.apiKeyEnv };
    const config = await loadConfig();
    if (config.providers.some((item) => item.id === id)) throw new Error(`Provider already exists: ${id}`);
    if (useKeychain) await keychain.store(id, "alfacode");
    const provider: ProviderRecord = { id, type, apiKey };
    await configStore.update((current) => ({ ...current, providers: [...current.providers, provider], defaultProviderId: current.defaultProviderId ?? id }));
    ui.write(`Connected ${id} (${type}) using ${apiKey.kind === "env" ? `environment variable ${apiKey.name}` : "macOS Keychain"}.`);
    return provider;
  };

  const setDefaultModel = async (model: string): Promise<void> => {
    const decoded = decodeModelId(model);
    if (decoded === undefined) throw new Error("Use a model id from `alfacode models`, for example alfacode-anthropic/google/model-id");
    await configStore.update((config) => {
      const provider = config.providers.find((item) => item.id === decoded.providerId);
      if (provider === undefined) throw new Error(`Provider not found: ${decoded.providerId}`);
      return {
        ...config,
        defaultProviderId: provider.id,
        providers: config.providers.map((item) => item.id === provider.id ? { ...item, options: { ...(item.options ?? {}), defaultModel: decoded.upstreamModel } } : item),
      };
    });
    ui.write(`Default model: ${model}`);
  };

  const chooseDefaultModel = async (): Promise<void> => {
    requireInteractive(ui.interactive);
    const config = await loadConfig();
    const models = await catalog(config);
    const model = await ui.select("Choose the default model", models.map((item) => ({ value: item.id, label: item.displayName, hint: item.id })));
    await setDefaultModel(model);
  };

  const launch = async (args: readonly string[]): Promise<void> => {
    let config = await loadConfig();
    if (config.providers.length === 0) {
      requireInteractive(ui.interactive);
      ui.write("Welcome to AlfaCode. Connect a provider before launching Claude Code.");
      const type = await ui.select("Choose a provider", [{ value: "google", label: "Google AI Studio / Gemini" }]);
      await connect(type, {});
      config = await loadConfig();
      try {
        await chooseDefaultModel();
        config = await loadConfig();
      } catch (error: unknown) {
        ui.write(`Model selection skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (runtimeStarter === undefined) throw new Error("Gateway runtime is not configured yet");
    const provider = await selectedProvider(config);
    const runtime = await runtimeStarter({ provider, config });
    try {
      const launchOptions: ClaudeLaunchOptions = {
        claudeArgs: args,
        baseUrl: runtime.baseUrl,
        authToken: runtime.authToken,
        ...(runtime.defaultModelId === undefined ? {} : { defaultModelId: runtime.defaultModelId }),
        ...(runtime.secretEnvironmentNames === undefined ? {} : { scrubEnvironmentKeys: runtime.secretEnvironmentNames }),
      };
      process.exitCode = await (options.launch ?? launchClaude)(launchOptions);
    } finally {
      await runtime.close();
    }
  };

  const program = new Command();
  program.name("alfacode").description("Launch Claude Code through the local AlfaCode gateway").argument("[args...]", "Arguments passed unchanged to Claude").allowUnknownOption(true).action(launch);
  program.command("connect [type]").description("Connect a provider without sending credentials through a Claude transcript")
    .option("--id <id>", "Provider identifier").option("--api-key-env <name>", "Reference an environment variable for non-interactive use").option("--keychain", "Prompt macOS Keychain securely")
    .action(async (type: string | undefined, flags: ConnectFlags) => { await connect(type ?? "google", flags); });

  const providers = program.command("providers").description("List, select, and remove provider metadata");
  providers.command("list").action(async () => {
    const config = await loadConfig();
    if (config.providers.length === 0) return ui.write("No providers configured.");
    for (const item of config.providers) {
      const secret = item.apiKey?.kind === "env" ? `env:${item.apiKey.name}` : item.apiKey?.kind === "keychain" ? `keychain:${item.apiKey.service}/${item.apiKey.account}` : "no credential";
      const model = typeof item.options?.defaultModel === "string" ? ` default-model:${item.options.defaultModel}` : "";
      ui.write(`${item.id}\t${item.type}\t${secret}${item.id === config.defaultProviderId ? "\tdefault-provider" : ""}${model}`);
    }
  });
  providers.command("remove <id>").option("--delete-keychain", "Delete the AlfaCode Keychain item as well").action(async (id: string, flags: RemoveFlags) => {
    const config = await loadConfig();
    const provider = config.providers.find((item) => item.id === id);
    if (provider === undefined) throw new Error(`Provider not found: ${id}`);
    if (flags.deleteKeychain && provider.apiKey?.kind === "keychain") {
      if (provider.apiKey.service !== keychainService) throw new Error("Refusing to delete a legacy Keychain record. Reconnect this provider to migrate its credential first.");
      if (keychain.delete === undefined) throw new Error("Keychain deletion is unavailable in this environment");
      await keychain.delete(provider.apiKey.account, provider.apiKey.service);
    }
    await configStore.update((current) => {
      const remaining = current.providers.filter((item) => item.id !== id);
      if (current.defaultProviderId !== id) return { ...current, providers: remaining };
      const { defaultProviderId: _removedDefault, ...withoutDefault } = current;
      return { ...withoutDefault, providers: remaining, ...(remaining[0] === undefined ? {} : { defaultProviderId: remaining[0].id }) };
    });
    ui.write(`Removed provider ${id}.${flags.deleteKeychain ? " Its AlfaCode Keychain item was deleted." : " Its credential was left untouched."}`);
  });
  providers.command("default <id>").action(async (id: string) => {
    await configStore.update((config) => {
      if (!config.providers.some((item) => item.id === id)) throw new Error(`Provider not found: ${id}`);
      return { ...config, defaultProviderId: id };
    });
    ui.write(`Default provider: ${id}`);
  });

  const legacy = program.command("provider").description("Compatibility aliases for provider management");
  legacy.command("add <type>").option("--id <id>").option("--api-key-env <name>").option("--keychain").action(async (type: string, flags: ConnectFlags) => { await connect(type, flags); });

  program.command("models [provider]").option("--json", "Emit JSON").action(async (providerId: string | undefined, flags: { json?: boolean }) => {
    const config = await loadConfig();
    const models = await catalog(config, await selectedProvider(config, providerId));
    if (flags.json) return ui.write(JSON.stringify(models));
    if (models.length === 0) return ui.write("No models available.");
    for (const model of models) ui.write(`${model.id}\t${model.displayName}`);
  });
  program.command("default [model]").description("Select the default model").action(async (model: string | undefined) => { if (model === undefined) await chooseDefaultModel(); else await setDefaultModel(model); });
  program.command("usage").option("--json", "Emit JSON").action((flags: { json?: boolean }) => {
    const result = { available: false, reason: "No local usage ledger is configured yet." };
    ui.write(flags.json ? JSON.stringify(result) : result.reason);
  });
  program.command("doctor").option("--json", "Emit JSON").action(async (flags: { json?: boolean }) => {
    const config = await loadConfig();
    const report = { configPath: configStore.path, providers: config.providers.map((provider) => ({ id: provider.id, type: provider.type, credential: provider.apiKey?.kind ?? "missing" })), defaultProviderId: config.defaultProviderId ?? null, isolatedClaudeConfig: `${configStore.homeDirectory}/.alfacode/claude`, status: config.providers.length > 0 ? "ready" : "setup-required" };
    if (flags.json) return ui.write(JSON.stringify(report));
    ui.write(`Config: ${report.configPath}`); ui.write(`Providers: ${report.providers.length}`); ui.write(`Default provider: ${report.defaultProviderId ?? "not set"}`); ui.write(`Claude state: ${report.isolatedClaudeConfig}`); ui.write(`Status: ${report.status}`);
  });
  program.command("config").command("path").action(() => ui.write(configStore.path));
  program.command("launch [args...]").allowUnknownOption(true).action(launch);
  program.command("run [args...]").allowUnknownOption(true).option("--non-interactive", "Fail instead of prompting for setup").action(async (args: string[], flags: { nonInteractive?: boolean }) => {
    if (flags.nonInteractive && !ui.interactive && (await loadConfig()).providers.length === 0) throw new Error("No provider configured. Use `alfacode connect google --api-key-env NAME` first.");
    await launch(args);
  });
  return program;
}

async function discoverModelsFromGateway(start: StartRuntime, input: { provider: ProviderRecord; config: AlfaCodeConfig }): Promise<readonly GatewayModel[]> {
  const runtime = await start(input);
  try {
    const response = await fetch(`${runtime.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${runtime.authToken}` } });
    if (!response.ok) throw new Error(`Model discovery failed (${response.status})`);
    const payload: unknown = await response.json();
    if (!isModelResponse(payload)) throw new Error("Gateway returned an invalid model catalog");
    return payload.data.map((model) => ({ id: model.id, displayName: model.display_name }));
  } finally { await runtime.close(); }
}

function isModelResponse(value: unknown): value is { data: Array<{ id: string; display_name: string }> } {
  return typeof value === "object" && value !== null && "data" in value && Array.isArray(value.data)
    && value.data.every((model) => typeof model === "object" && model !== null && "id" in model && typeof model.id === "string" && "display_name" in model && typeof model.display_name === "string");
}

export async function main(argv = process.argv): Promise<void> { await createCli({ startRuntime }).parseAsync(argv); }

if (import.meta.url === `file://${process.argv[1]}`) void main().catch((error: unknown) => { process.stderr.write(`alfacode: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
