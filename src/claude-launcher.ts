import { spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export type ClaudeSpawner = (request: SpawnRequest) => Promise<number>;

export interface ClaudeLaunchOptions {
  readonly claudePath?: string;
  readonly claudeArgs: readonly string[];
  readonly baseUrl: string;
  readonly authToken: string;
  readonly configDir?: string;
  readonly defaultModelId?: string;
  readonly contextWindowTokens?: number;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly scrubEnvironmentKeys?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawner?: ClaudeSpawner;
}

const inheritedSecretKeys = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "VERTEX_PROJECT",
  "VERTEX_REGION",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "DISABLE_COMPACT",
  "DISABLE_AUTO_COMPACT",
]);

/** Routing controls read by the embedded Claude Code engine in the pinned SDK. */
const inheritedRoutingKeys = new Set([
  "AGENT_PROXY_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "GRPC_PROXY",
  "NO_GRPC_PROXY",
  "CLAUDE_CODE_PROXY_RESOLVES_HOSTS",
  "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER",
  "CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS",
  "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_GB_BASE_URL",
  "CLAUDE_CODE_MEMORY_API_BASE_URL",
  "CLAUDE_BRIDGE_BASE_URL",
  "CLAUDE_BRIDGE_SESSION_INGRESS_URL",
  "CLAUDE_REMOTE_TOOLS_BRIDGE_URL",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_LOCAL_OAUTH_API_BASE",
  "CLAUDE_LOCAL_OAUTH_APPS_BASE",
  "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
  "CLAUDE_CODE_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "CLAUDE_CODE_ARTIFACTS_API_BASE_URL",
  "CLAUDE_CODE_ARTIFACTS_API_TOKEN",
  "CLAUDE_CODE_ARTIFACT_ASSET_BASE_URL",
  "CLAUDE_CODE_ARTIFACT_LIVE_BASE_URL",
  "CLAUDE_CODE_ARTIFACT_SYNC_BASE_URL",
  "CLAUDE_CODE_ARTIFACT_VIEWER_BASE_URL",
  "CLAUDE_CODE_MEMORY_API_TOKEN",
  "CLOUD_ML_REGION",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
]);

const inheritedCloudPrefixes = ["AWS_", "GOOGLE_", "GEMINI_", "VERTEX_", "AZURE_"] as const;

/** Safe child-process defaults. Explicit launch extraEnv values may opt back in deliberately. */
const safeClaudeDefaults: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_ARTIFACT: "1",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "0",
  CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
};

export function buildClaudeEnvironment(options: ClaudeLaunchOptions): NodeJS.ProcessEnv {
  const base = options.environment ?? process.env;
  const secretKeys = new Set([...inheritedSecretKeys, ...(options.scrubEnvironmentKeys ?? [])].map((key) => key.toUpperCase()));
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!shouldScrubEnvironmentKey(key, secretKeys)) environment[key] = value;
  }
  Object.assign(environment, safeClaudeDefaults, options.extraEnv);
  for (const key of Object.keys(environment)) {
    if (shouldScrubEnvironmentKey(key, secretKeys) && key.toUpperCase() !== "ANTHROPIC_CUSTOM_HEADERS") delete environment[key];
  }
  Object.assign(environment, {
    ANTHROPIC_BASE_URL: options.baseUrl,
    ANTHROPIC_AUTH_TOKEN: options.authToken,
    CLAUDE_CONFIG_DIR: options.configDir ?? join(homedir(), ".alfacode", "claude"),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  });
  if (options.defaultModelId !== undefined) {
    environment.ANTHROPIC_MODEL = options.defaultModelId;
    environment.ANTHROPIC_DEFAULT_OPUS_MODEL = options.defaultModelId;
    environment.ANTHROPIC_DEFAULT_SONNET_MODEL = options.defaultModelId;
    environment.ANTHROPIC_DEFAULT_HAIKU_MODEL = options.defaultModelId;
  }
  if (options.contextWindowTokens !== undefined) {
    environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(options.contextWindowTokens);
  }
  return environment;
}

export async function launchClaude(options: ClaudeLaunchOptions): Promise<number> {
  const configDirectory = options.configDir ?? join(homedir(), ".alfacode", "claude");
  if (options.contextWindowTokens !== undefined && (!Number.isSafeInteger(options.contextWindowTokens) || options.contextWindowTokens <= 0)) {
    throw new Error("contextWindowTokens must be a positive integer");
  }
  await ensurePrivateDirectory(configDirectory);
  return (options.spawner ?? systemClaudeSpawner)({ command: options.claudePath ?? "claude", args: options.claudeArgs, env: buildClaudeEnvironment(options) });
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(parent);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error;
  }
  await assertPrivateDirectory(path);
}

function shouldScrubEnvironmentKey(key: string, secretKeys: ReadonlySet<string>): boolean {
  const normalized = key.toUpperCase();
  return secretKeys.has(normalized)
    || inheritedRoutingKeys.has(normalized)
    || normalized.startsWith("ANTHROPIC_")
    || inheritedCloudPrefixes.some((prefix) => normalized.startsWith(prefix));
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link at Claude config path: ${path}`);
  if (!info.isDirectory()) throw new Error(`Expected a directory at Claude config path: ${path}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`Refusing insecure permissions at Claude config path: ${path}. Fix with: chmod 700 ${path}`);
  if (process.getuid !== undefined && info.uid !== process.getuid()) throw new Error(`Refusing Claude config path not owned by the current user: ${path}`);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

export const systemClaudeSpawner: ClaudeSpawner = ({ command, args, env }) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { env, stdio: "inherit" });
  child.once("error", reject);
  child.once("close", (exitCode, signal) => resolve(exitCode ?? (signal === null ? 1 : 128)));
});
