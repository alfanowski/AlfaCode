#!/usr/bin/env node
import { Command } from "commander";
import { decodeModelId, encodeModelId } from "./model-id.js";
import { ConfigStore, migrateLegacyConfig, type AlfaCodeConfig, type ProviderRecord, type SecretReference } from "./config.js";
import { launchClaude, type ClaudeLaunchOptions } from "./claude-launcher.js";
import { keychainService, MacOSKeychain } from "./secrets.js";
import { startRuntime } from "./runtime.js";
import { createTerminalUi, requireInteractive, type TerminalUi } from "./terminal-ui.js";
import { descriptorsFromDynamicCatalog, providerDescriptors, type ProviderDescriptor } from "./provider-descriptors.js";
import { UsageLedger, type UsageQuery, type UsageSummary } from "./usage-ledger.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { ModelsDevCatalogClient } from "./models-dev-catalog.js";
import { createModelsDevMetadataResolver, dynamicProviderDescriptors } from "./models-dev-runtime.js";
import type { ModelDescriptor } from "./providers/foundation/types.js";

export interface RuntimeHandle {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly defaultModelId?: string;
  readonly contextWindowTokens?: number;
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

export type StartRuntime = (input: { provider: ProviderRecord; config: AlfaCodeConfig; purpose?: "launch" | "discovery" }) => Promise<RuntimeHandle>;
export type DiscoverModels = (input: { provider: ProviderRecord; config: AlfaCodeConfig }) => Promise<readonly GatewayModel[]>;
export type QueryUsage = (query: UsageQuery) => Promise<UsageSummary>;

export interface CreateCliOptions {
  readonly configStore?: ConfigStore;
  readonly keychain?: Pick<MacOSKeychain, "store"> & Partial<Pick<MacOSKeychain, "delete">>;
  readonly startRuntime?: StartRuntime;
  readonly discoverModels?: DiscoverModels;
  readonly queryUsage?: QueryUsage;
  readonly launch?: (options: ClaudeLaunchOptions) => Promise<number>;
  readonly ui?: TerminalUi;
  readonly legacyConfigPath?: string;
  /** Platform-supplied catalog; the bundled catalog is only a bootstrap fallback. */
  readonly providerDescriptors?: readonly ProviderDescriptor[];
}

interface ConnectFlags { readonly id?: string; readonly apiKeyEnv?: string; readonly keychain?: boolean; readonly baseUrl?: string; }
interface RemoveFlags { readonly deleteKeychain?: boolean; }
interface UsageFlags { readonly json?: boolean; readonly provider?: string; readonly model?: string; readonly session?: string; readonly limit?: string; }

export function createCli(options: CreateCliOptions = {}): Command {
  const configStore = options.configStore ?? new ConfigStore();
  const keychain = options.keychain ?? new MacOSKeychain();
  const runtimeStarter = options.startRuntime;
  const ui = options.ui ?? createTerminalUi();
  const descriptors = options.providerDescriptors ?? providerDescriptors;
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
    const descriptor = descriptors.find((item) => item.id === type);
    if (descriptor === undefined) throw new Error(`Unsupported provider type: ${type}. Use: ${descriptors.map((item) => item.id).join(", ")}`);
    if (flags.apiKeyEnv !== undefined && flags.keychain) throw new Error("Use either --api-key-env or --keychain, not both");
    const config = await loadConfig();
    const id = flags.id ?? availableProviderId(localProviderId(descriptor.id), config.providers);
    validateProviderId(id);
    const baseUrl = flags.baseUrl ?? (descriptor.requiresBaseUrl && ui.interactive ? await ui.ask(`${descriptor.displayName} base URL`, descriptor.suggestedBaseUrl) : undefined);
    if (descriptor.requiresBaseUrl && (baseUrl === undefined || !isHttpUrl(baseUrl))) {
      throw new Error(`${descriptor.displayName} requires an absolute http(s) --base-url`);
    }
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

  const clearDefaultModel = async (): Promise<void> => {
    const config = await loadConfig();
    const provider = await selectedProvider(config);
    await configStore.update((current) => ({
      ...current,
      providers: current.providers.map((item) => {
        if (item.id !== provider.id || item.options?.defaultModel === undefined) return item;
        const { defaultModel: _pinnedModel, ...remainingOptions } = item.options;
        if (Object.keys(remainingOptions).length > 0) return { ...item, options: remainingOptions };
        const { options: _removedOptions, ...withoutOptions } = item;
        return withoutOptions;
      }),
    }));
    ui.write("Default model: automatic selection.");
  };

  const launch = async (args: readonly string[]): Promise<void> => {
    let config = await loadConfig();
    if (config.providers.length === 0) {
      requireInteractive(ui.interactive);
      ui.write("Welcome to AlfaCode. Connect a provider before launching Claude Code.");
      const type = await ui.select("Choose a provider", descriptors.map(toChoice));
      await connect(type, {});
      config = await loadConfig();
      ui.write("Model selection is automatic. Run `alfacode default` later to pin a model.");
    }
    if (runtimeStarter === undefined) throw new Error("Gateway runtime is not configured yet");
    const provider = await selectedProvider(config);
    const runtime = await runtimeStarter({ provider, config });
    try {
      for (const warning of runtime.warnings ?? []) ui.write(`Warning: ${warning}`);
      const launchOptions: ClaudeLaunchOptions = {
        claudeArgs: args,
        baseUrl: runtime.baseUrl,
        authToken: runtime.authToken,
        ...(runtime.defaultModelId === undefined ? {} : { defaultModelId: runtime.defaultModelId }),
        ...(runtime.contextWindowTokens === undefined ? {} : { contextWindowTokens: runtime.contextWindowTokens }),
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
  legacy.command("add <type>").option("--id <id>").option("--api-key-env <name>").option("--keychain").option("--base-url <url>").action(async (type: string, flags: ConnectFlags) => { await connect(type, flags); });

  program.command("models [provider]").option("--json", "Emit JSON").action(async (providerId: string | undefined, flags: { json?: boolean }) => {
    const config = await loadConfig();
    const models = await catalog(config, await selectedProvider(config, providerId));
    if (flags.json) return ui.write(JSON.stringify(models));
    if (models.length === 0) return ui.write("No models available.");
    for (const model of models) ui.write(renderModel(model));
  });
  program.command("default [model]").description("Pin a default model, or clear it with 'auto'").action(async (model: string | undefined) => {
    if (model === undefined) await chooseDefaultModel();
    else if (model === "auto") await clearDefaultModel();
    else await setDefaultModel(model);
  });
  program.command("usage").option("--json", "Emit JSON").option("--provider <id>").option("--model <id>").option("--session <id>").option("--limit <count>").action(async (flags: UsageFlags) => {
    const query = usageQuery(flags);
    const summary = options.queryUsage === undefined ? await queryUsageLedger(join(configStore.homeDirectory, ".alfacode", "usage"), query) : await options.queryUsage(query);
    ui.write(flags.json ? JSON.stringify(summary) : renderUsage(summary));
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
  const runtime = await start({ ...input, purpose: "discovery" });
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
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
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

function usageQuery(flags: UsageFlags): UsageQuery {
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer");
  return {
    ...(flags.provider === undefined ? {} : { providerId: flags.provider }),
    ...(flags.model === undefined ? {} : { routeModelId: flags.model }),
    ...(flags.session === undefined ? {} : { session: flags.session }),
    ...(limit === undefined ? {} : { limit }),
  };
}

async function queryUsageLedger(directory: string, query: UsageQuery): Promise<UsageSummary> {
  const ledger = await UsageLedger.open(directory);
  try {
    return await ledger.query(query);
  } finally {
    await ledger.close();
  }
}

function renderUsage(summary: UsageSummary): string {
  const totals = summary.totals;
  const lines = [
    `Attempts: ${summary.attempts.length}`,
    `Tokens: total ${totals.totalTokens} | input ${totals.inputTokens} | output ${totals.outputTokens} | cached ${totals.cachedInputTokens} | reasoning ${totals.reasoningTokens} | tools ${totals.toolTokens}`,
  ];
  for (const attempt of summary.attempts) {
    lines.push(`${attempt.providerId}\t${attempt.routeModelId}\t${attempt.outcome}\tusage:${attempt.usageCompleteness}\ttokens:${attempt.totalTokens ?? "unknown"}`);
  }
  return lines.join("\n");
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
    startRuntime: (input) => startRuntime(input, catalog === undefined ? {} : { modelMetadata: createModelsDevMetadataResolver(catalog, input.config) }),
  }).parseAsync(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) void main().catch((error: unknown) => { process.stderr.write(`alfacode: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
