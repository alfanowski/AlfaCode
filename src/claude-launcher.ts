import { spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
  const secretKeys = new Set([...inheritedSecretKeys, ...(options.scrubEnvironmentKeys ?? [])]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!secretKeys.has(key) && !key.startsWith("ANTHROPIC_")) environment[key] = value;
  }
  Object.assign(environment, safeClaudeDefaults, options.extraEnv);
  for (const key of secretKeys) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (key.startsWith("ANTHROPIC_") && key !== "ANTHROPIC_CUSTOM_HEADERS") delete environment[key];
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

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const directory = await lstat(path);
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error(`Refusing unsafe Claude config directory: ${path}`);
  const parent = await lstat(join(path, ".."));
  if (parent.isSymbolicLink()) throw new Error(`Refusing symlinked Claude config parent: ${join(path, "..")}`);
}

export const systemClaudeSpawner: ClaudeSpawner = ({ command, args, env }) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { env, stdio: "inherit" });
  child.once("error", reject);
  child.once("close", (exitCode, signal) => resolve(exitCode ?? (signal === null ? 1 : 128)));
});
