#!/usr/bin/env node
import { Command } from "commander";
import { decodeModelId, encodeModelId } from "./model-id.js";
import { ConfigStore, migrateLegacyConfig, type AlfaCodeConfig, type ProviderRecord, type SecretReference } from "./config.js";
import { launchClaude, type ClaudeLaunchOptions } from "./claude-launcher.js";
import { keychainService, MacOSKeychain } from "./secrets.js";
import { startRuntime } from "./runtime.js";
import { createTerminalUi, requireInteractive, type TerminalUi } from "./terminal-ui.js";
import { descriptorsFromDynamicCatalog, providerDescriptors, type ProviderDescriptor } from "./provider-descriptors.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { ModelsDevCatalogClient } from "./models-dev-catalog.js";
import { createModelsDevMetadataResolver, dynamicProviderDescriptors } from "./models-dev-runtime.js";
import type { ModelDescriptor } from "./providers/foundation/types.js";
import { OLLAMA_LOCAL_PROVIDER_ID, ollamaLocalProviderRecord, probeOllamaLocal } from "./ollama-local.js";

export interface RuntimeHandle {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly secretEnvironmentNames?: readonly string[];
  readonly modelCandidates?: readonly ModelDescriptor[];
  readonly warnings?: readonly string[];
  close(): Promise<void>;
}

export interface GatewayModel {
  readonly id: string;
  readonly displayName: string;
  readonly availability?: "available" | "deprecated" | "account-validation-required" | "unknown";
  readonly capabilities?: Readonly<Record<string, boolean | string>>;
  readonly quota?: { readonly state: "available" | "limited" | "exhausted" | "unknown"; readonly remainingRequests?: number; readonly retryAfterSeconds?: number };
  readonly headroom?: { readonly contextWindowTokens?: number; readonly availableInputTokens?: number; readonly maxOutputTokens?: number };
}

export type StartRuntime = (input: { config: AlfaCodeConfig }) => Promise<RuntimeHandle>;
export type DiscoverModels = (input: { config: AlfaCodeConfig }) => Promise<readonly GatewayModel[]>;

export interface CreateCliOptions {
  readonly configStore?: ConfigStore;
  readonly keychain?: Pick<MacOSKeychain, "store"> & Partial<Pick<MacOSKeychain, "storeSecret" | "retrieve" | "delete">>;
  readonly startRuntime?: StartRuntime;
  readonly discoverModels?: DiscoverModels;
  readonly launch?: (options: ClaudeLaunchOptions) => Promise<number>;
  readonly ui?: TerminalUi;
  readonly legacyConfigPath?: string;
  /** Platform-supplied catalog; the bundled catalog is only a bootstrap fallback. */
  readonly providerDescriptors?: readonly ProviderDescriptor[];
  readonly probeOllamaLocal?: () => Promise<boolean>;
}

interface ConnectFlags { readonly id?: string; readonly apiKeyEnv?: string; readonly keychain?: boolean; readonly baseUrl?: string; }
interface RemoveFlags { readonly deleteKeychain?: boolean; }

export function createCli(options: CreateCliOptions = {}): Command {
  const configStore = options.configStore ?? new ConfigStore();
  const keychain = options.keychain ?? new MacOSKeychain();
  const runtimeStarter = options.startRuntime;
  const ui = options.ui ?? createTerminalUi();
  const descriptors = options.providerDescriptors ?? providerDescriptors;
  const probeOllama = options.probeOllamaLocal ?? probeOllamaLocal;
  let migrationChecked = false;

  const loadConfig = async (): Promise<AlfaCodeConfig> => {
    if (!migrationChecked) {
      migrationChecked = true;
      const result = await migrateLegacyConfig({ target: configStore, ...(options.legacyConfigPath === undefined ? {} : { legacyConfigPath: options.legacyConfigPath }) });
      if (result.migrated) ui.write(`Imported legacy AlfaCode metadata from ${result.sourcePath}. Keychain references were kept in place.`);
    }
    return configStore.read();
  };

  const catalog = async (config: AlfaCodeConfig, providerId?: string): Promise<readonly GatewayModel[]> => {
    if (options.discoverModels !== undefined) return options.discoverModels({ config });
    if (runtimeStarter === undefined) throw new Error("Model discovery is not configured yet");
    const models = await discoverModelsFromGateway(runtimeStarter, { config });
    return providerId === undefined ? models : models.filter((model) => decodeModelId(model.id)?.providerId === providerId);
  };

  /**
   * Loads persisted config and, unless a provider already claims the reserved
   * `ollama-local` id (of any `type` — a hand-configured record shadows the
   * probe just as much as a previously auto-detected one), merges in an
   * auto-detected local Ollama record. Never persisted back to disk.
   */
  const resolveLaunchConfig = async (): Promise<AlfaCodeConfig> => {
    const config = await loadConfig();
    if (config.providers.some((item) => item.id === OLLAMA_LOCAL_PROVIDER_ID)) return config;
    return (await probeOllama()) ? { ...config, providers: [...config.providers, ollamaLocalProviderRecord()] } : config;
  };

  const connect = async (type: string, flags: ConnectFlags): Promise<ProviderRecord> => {
    const descriptor = descriptors.find((item) => item.id === type);
    if (descriptor === undefined) throw new Error(`Unsupported provider type: ${type}. Use: ${descriptors.map((item) => item.id).join(", ")}`);
    if (flags.apiKeyEnv !== undefined && flags.keychain) throw new Error("Use either --api-key-env or --keychain, not both");
    if (flags.apiKeyEnv !== undefined) validateEnvironmentVariableName(flags.apiKeyEnv);
    const config = await loadConfig();
    const id = flags.id ?? availableProviderId(localProviderId(descriptor.id), config.providers);
    validateProviderId(id);
    const baseUrl = flags.baseUrl ?? (descriptor.requiresBaseUrl && ui.interactive ? await ui.ask(`${descriptor.displayName} base URL`, descriptor.suggestedBaseUrl) : undefined);
    if (descriptor.requiresBaseUrl && baseUrl === undefined) throw new Error(`${descriptor.displayName} requires a --base-url`);
    if (baseUrl !== undefined && !isHttpUrl(baseUrl)) throw new Error("Base URL must be an absolute HTTPS URL (HTTP is allowed only for localhost, 127.0.0.1, or ::1)");
    const useKeychain = flags.keychain || flags.apiKeyEnv === undefined;
    if (useKeychain) requireInteractive(ui.interactive);
    const apiKey: SecretReference = flags.apiKeyEnv === undefined
      ? { kind: "keychain", service: "alfacode", account: id }
      : { kind: "env", name: flags.apiKeyEnv };
    if (config.providers.some((item) => item.id === id)) throw new Error(`Provider already exists: ${id}`);
    if (useKeychain) await keychain.store(id, "alfacode");
    const provider: ProviderRecord = {
      id,
      type: descriptor.configType,
      apiKey,
      ...((baseUrl === undefined && descriptor.configurationOptions === undefined) ? {} : { options: { ...(descriptor.configurationOptions ?? {}), ...(baseUrl === undefined ? {} : { baseUrl }) } }),
    };
    await configStore.update((current) => ({ ...current, providers: [...current.providers, provider], defaultProviderId: current.defaultProviderId ?? id }));
    ui.write(`Connected ${id} (${descriptor.displayName}) using ${apiKey.kind === "env" ? `environment variable ${apiKey.name}` : "macOS Keychain"}.`);
    return provider;
  };

  const passthroughLaunch = (args: readonly string[]): Promise<number> =>
    (options.launch ?? launchClaude)({ claudeArgs: args, baseUrl: "", authToken: "" });

  const classicLaunch = async (args: readonly string[]): Promise<void> => {
    const config = await resolveLaunchConfig();
    if (config.providers.length === 0) {
      process.exitCode = await passthroughLaunch(args);
      return;
    }
    if (runtimeStarter === undefined) throw new Error("Gateway runtime is not configured yet");
    const runtime = await runtimeStarter({ config });
    // A configured provider that resolved zero usable models (auth expired, no
    // model pulled yet, etc.) leaves the gateway empty and useless to claude
    // (nothing in /model, every request 404s) — fall back to plain claude
    // exactly like the zero-provider case, instead of handing the user a
    // gateway that cannot do anything.
    if ((runtime.modelCandidates ?? []).length === 0) {
      for (const warning of runtime.warnings ?? []) ui.write(`Warning: ${warning}`);
      await runtime.close();
      process.exitCode = await passthroughLaunch(args);
      return;
    }
    try {
      for (const warning of runtime.warnings ?? []) ui.write(`Warning: ${warning}`);
      const launchOptions: ClaudeLaunchOptions = {
        claudeArgs: args,
        baseUrl: runtime.baseUrl,
        authToken: runtime.authToken,
        ...(runtime.secretEnvironmentNames === undefined ? {} : { scrubEnvironmentKeys: runtime.secretEnvironmentNames }),
      };
      process.exitCode = await (options.launch ?? launchClaude)(launchOptions);
    } finally {
      await runtime.close();
    }
  };

  const program = new Command();
  program.name("alfacode").description("Run the real Claude Code TUI with extra models available through the gateway").argument("[args...]", "Arguments passed through to claude").allowUnknownOption(true)
    .action(classicLaunch);
  program.command("connect [type]").description("Connect a provider without sending credentials through a Claude transcript")
    .option("--id <id>", "Provider identifier").option("--api-key-env <name>", "Reference an environment variable for non-interactive use").option("--keychain", "Prompt macOS Keychain securely").option("--base-url <url>", "Base URL for an OpenAI-compatible provider")
    .action(async (type: string | undefined, flags: ConnectFlags) => {
      const selectedType = type ?? (ui.interactive ? await ui.select("Choose a provider", descriptors.map(toChoice)) : undefined);
      if (selectedType === undefined) throw new Error("Specify a provider type in a non-interactive terminal");
      await connect(selectedType, flags);
    });

  const providers = program.command("providers").description("List, select, and remove provider metadata");
  providers.command("list").action(async () => {
    const config = await loadConfig();
    if (config.providers.length === 0) return ui.write("No providers configured.");
    for (const item of config.providers) {
      const secret = item.apiKey?.kind === "env" ? `env:${item.apiKey.name}` : item.apiKey?.kind === "keychain" ? `keychain:${item.apiKey.service}/${item.apiKey.account}` : "no credential";
      ui.write(`${item.id}\t${item.type}\t${secret}${item.id === config.defaultProviderId ? "\tdefault-provider" : ""}`);
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
  const legacy = program.command("provider").description("Compatibility aliases for provider management");
  legacy.command("add <type>").option("--id <id>").option("--api-key-env <name>").option("--keychain").option("--base-url <url>").action(async (type: string, flags: ConnectFlags) => { await connect(type, flags); });

  program.command("models [provider]").option("--json", "Emit JSON").action(async (providerId: string | undefined, flags: { json?: boolean }) => {
    const config = await resolveLaunchConfig();
    const models = await catalog(config, providerId);
    if (flags.json) return ui.write(JSON.stringify(models));
    if (models.length === 0) return ui.write("No models available.");
    for (const model of models) ui.write(renderModel(model));
  });
  program.command("doctor").option("--json", "Emit JSON").action(async (flags: { json?: boolean }) => {
    const config = await resolveLaunchConfig();
    const report = { configPath: configStore.path, providers: config.providers.map((provider) => ({ id: provider.id, type: provider.type, credential: provider.apiKey?.kind ?? "missing" })), defaultProviderId: config.defaultProviderId ?? null, isolatedClaudeConfig: `${configStore.homeDirectory}/.alfacode/claude`, status: config.providers.length > 0 ? "ready" : "passthrough" };
    if (flags.json) return ui.write(JSON.stringify(report));
    ui.write(`Config: ${report.configPath}`); ui.write(`Providers: ${report.providers.length}`); ui.write(`Default provider: ${report.defaultProviderId ?? "not set"}`); ui.write(`Claude state: ${report.isolatedClaudeConfig}`); ui.write(`Status: ${report.status}`);
  });
  program.command("config").command("path").action(() => ui.write(configStore.path));
  program.command("launch [args...]").description("Same as running alfacode with no subcommand").allowUnknownOption(true).action(classicLaunch);
  return program;
}

async function discoverModelsFromGateway(start: StartRuntime, input: { config: AlfaCodeConfig }): Promise<readonly GatewayModel[]> {
  const runtime = await start(input);
  try {
    if (runtime.modelCandidates !== undefined) return runtime.modelCandidates.map(toGatewayModel);
    const response = await fetch(`${runtime.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${runtime.authToken}` } });
    if (!response.ok) throw new Error(`Model discovery failed (${response.status})`);
    const payload: unknown = await response.json();
    if (!isModelResponse(payload)) throw new Error("Gateway returned an invalid model catalog");
    return payload.data.map((model) => ({ id: model.id, displayName: model.display_name, availability: "unknown" }));
  } finally { await runtime.close(); }
}

function toGatewayModel(model: ModelDescriptor): GatewayModel {
  return {
    id: encodeModelId(model.providerId, model.id),
    displayName: `[${model.providerId}] ${model.displayName}`,
    availability: model.availability,
    capabilities: { ...model.capabilities },
    quota: { state: "unknown" },
    headroom: {
      ...(model.contextWindow === undefined ? {} : { contextWindowTokens: model.contextWindow }),
      ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
    },
  };
}

function isModelResponse(value: unknown): value is { data: Array<{ id: string; display_name: string }> } {
  return typeof value === "object" && value !== null && "data" in value && Array.isArray(value.data)
    && value.data.every((model) => typeof model === "object" && model !== null && "id" in model && typeof model.id === "string" && "display_name" in model && typeof model.display_name === "string");
}

function toChoice(descriptor: ProviderDescriptor): { value: string; label: string; hint: string } {
  return { value: descriptor.id, label: descriptor.displayName, hint: descriptor.description };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

function validateEnvironmentVariableName(value: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(value)) {
    throw new Error("API key environment variable must contain only letters, numbers, and underscores, and must not start with a number");
  }
}

function validateProviderId(value: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value)) {
    throw new Error("Provider id must be a short local label (1-64 letters, numbers, dots, underscores, or hyphens), not an API key");
  }
  if (/^(?:sk-|nvapi-|AIza)/i.test(value)) {
    throw new Error("Provider id looks like an API key. Pass a local label with --id; AlfaCode collects the credential separately");
  }
}

function localProviderId(descriptorId: string): string {
  const normalized = descriptorId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
  return normalized.length === 0 ? "provider" : normalized;
}

function availableProviderId(base: string, providers: readonly ProviderRecord[]): string {
  const existing = new Set(providers.map((provider) => provider.id));
  if (!existing.has(base)) return base;
  for (let sequence = 2; sequence < 10_000; sequence += 1) {
    const suffix = `-${sequence}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate a local provider id for ${base}`);
}

function renderModel(model: GatewayModel): string {
  const availability = model.availability ?? "unknown";
  const capabilities = model.capabilities === undefined ? "" : ` capabilities:${Object.entries(model.capabilities).filter(([, value]) => value === true).map(([name]) => name).join(",") || "none"}`;
  const quota = model.quota === undefined ? "" : ` quota:${model.quota.state}${model.quota.remainingRequests === undefined ? "" : ` (${model.quota.remainingRequests} remaining)`}${model.quota.retryAfterSeconds === undefined ? "" : ` retry:${model.quota.retryAfterSeconds}s`}`;
  const headroom = model.headroom === undefined ? "" : ` headroom:context=${model.headroom.contextWindowTokens ?? "?"},input=${model.headroom.availableInputTokens ?? "?"},output=${model.headroom.maxOutputTokens ?? "?"}`;
  return `${model.id}\t${model.displayName}\tavailability:${availability}${capabilities}${quota}${headroom}`;
}

export async function main(argv = process.argv): Promise<void> {
  let dynamicDescriptors: readonly ProviderDescriptor[] = [];
  let catalog: Awaited<ReturnType<ModelsDevCatalogClient["load"]>>["catalog"] | undefined;
  try {
    const result = await new ModelsDevCatalogClient({ cachePath: join(homedir(), ".alfacode", "catalog", "models-dev.json"), ttlMs: 1 }).load();
    catalog = result.catalog;
    dynamicDescriptors = descriptorsFromDynamicCatalog(dynamicProviderDescriptors(result.catalog));
  } catch {
    // Provider-owned live discovery still runs; missing external metadata remains explicitly unverified.
  }
  await createCli({
    providerDescriptors: [...providerDescriptors, ...dynamicDescriptors],
    startRuntime: (input) => startRuntime({ config: input.config }, catalog === undefined ? {} : { modelMetadata: createModelsDevMetadataResolver(catalog, input.config) }),
  }).parseAsync(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) void main().catch((error: unknown) => { process.stderr.write(`alfacode: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
