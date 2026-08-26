import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeEnvironment, launchClaude } from "../src/claude-launcher.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function privateTestRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alfacode-claude-test-"));
  directories.push(root);
  return root;
}

describe("launchClaude", () => {
  it("uses isolated config and replaces inherited cloud routing credentials", async () => {
    const configDir = join(await privateTestRoot(), "claude");
    let request: Parameters<NonNullable<Parameters<typeof launchClaude>[0]["spawner"]>>[0] | undefined;
    const exitCode = await launchClaude({
      claudePath: "/test/claude",
      claudeArgs: ["--resume", "session id"],
      baseUrl: "http://127.0.0.1:4317",
      authToken: "ephemeral-token",
      configDir,
      defaultModelId: "gemini-3-pro",
      contextWindowTokens: 262_144,
      extraEnv: { ALFACODE_GATEWAY_URL: "http://127.0.0.1:4317" },
      scrubEnvironmentKeys: ["CUSTOM_GOOGLE_KEY"],
      environment: { ANTHROPIC_API_KEY: "leak", GEMINI_API_KEY: "leak", CUSTOM_GOOGLE_KEY: "leak", AWS_PROFILE: "wrong", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "9999999", DISABLE_AUTO_COMPACT: "1", PATH: "/bin" },
      spawner: async (next) => { request = next; return 17; },
    });

    expect(exitCode).toBe(17);
    expect(request).toMatchObject({ command: "/test/claude", args: ["--resume", "session id"] });
    expect(request?.env).toMatchObject({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4317",
      ANTHROPIC_AUTH_TOKEN: "ephemeral-token",
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_DISABLE_ARTIFACT: "1",
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_FEEDBACK_COMMAND: "1",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "0",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "gemini-3-pro",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "gemini-3-pro",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "gemini-3-pro",
      ANTHROPIC_MODEL: "gemini-3-pro",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144",
    });
    expect(request?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(request?.env.GEMINI_API_KEY).toBeUndefined();
    expect(request?.env.CUSTOM_GOOGLE_KEY).toBeUndefined();
    expect(request?.env.AWS_PROFILE).toBeUndefined();
    expect(request?.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(request?.env.DISABLE_AUTO_COMPACT).toBeUndefined();
    expect((await lstat(configDir)).mode & 0o777).toBe(0o700);
  });

  it("does not mutate the supplied process environment", () => {
    const environment = { ANTHROPIC_API_KEY: "outside", PATH: "/bin" };
    const result = buildClaudeEnvironment({ claudeArgs: [], baseUrl: "http://gateway", authToken: "token", environment });
    expect(environment).toEqual({ ANTHROPIC_API_KEY: "outside", PATH: "/bin" });
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("scrubs every embedded-engine proxy and cloud routing override from process.env", () => {
    const keys = [
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "all_proxy", "no_proxy", "grpc_proxy", "no_grpc_proxy",
      "AGENT_PROXY_URL", "CLAUDE_CODE_API_BASE_URL", "CLOUD_ML_REGION", "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
      "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_GATEWAY",
      "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "CLAUDE_CODE_SKIP_VERTEX_AUTH", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
      "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH", "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
      "CLAUDE_CODE_SKIP_MANTLE_AUTH",
      "CLAUDE_LOCAL_OAUTH_APPS_BASE", "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE", "CLAUDE_CODE_OAUTH_CLIENT_ID",
      "CLAUDE_CODE_ARTIFACTS_API_BASE_URL", "CLAUDE_CODE_ARTIFACTS_API_TOKEN",
      "CLAUDE_CODE_ARTIFACT_ASSET_BASE_URL", "CLAUDE_CODE_ARTIFACT_LIVE_BASE_URL",
      "CLAUDE_CODE_ARTIFACT_SYNC_BASE_URL", "CLAUDE_CODE_ARTIFACT_VIEWER_BASE_URL",
      "CLAUDE_CODE_MEMORY_API_TOKEN",
    ] as const;
    for (const key of keys) vi.stubEnv(key, "leak");

    const result = buildClaudeEnvironment({ claudeArgs: [], baseUrl: "http://127.0.0.1:4317", authToken: "token" });

    for (const key of keys) expect(result[key], key).toBeUndefined();
    expect(result).toMatchObject({ ANTHROPIC_BASE_URL: "http://127.0.0.1:4317", ANTHROPIC_AUTH_TOKEN: "token" });
  });

  it("scrubs common AI provider credential prefixes from process.env", () => {
    const keys = ["OPENAI_API_KEY", "XAI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "COHERE_API_KEY", "OPENROUTER_API_KEY"] as const;
    for (const key of keys) vi.stubEnv(key, "leak");

    const result = buildClaudeEnvironment({ claudeArgs: [], baseUrl: "http://127.0.0.1:4317", authToken: "token" });

    for (const key of keys) expect(result[key], key).toBeUndefined();
  });

  it("exempts an explicitly-passed ANTHROPIC_CUSTOM_HEADERS override from the blanket ANTHROPIC_ scrub", () => {
    // Only an explicit extraEnv override (AlfaCode's own internal passthrough) is exempt — a
    // value merely inherited from the ambient shell environment is still scrubbed like any other
    // ANTHROPIC_-prefixed variable (see the next test).
    const result = buildClaudeEnvironment({
      claudeArgs: [],
      baseUrl: "http://127.0.0.1:4317",
      authToken: "token",
      extraEnv: { ANTHROPIC_CUSTOM_HEADERS: "x-team: infra" },
      environment: { ANTHROPIC_API_KEY: "leak" },
    });
    expect(result.ANTHROPIC_CUSTOM_HEADERS).toBe("x-team: infra");
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("never inherits ANTHROPIC_CUSTOM_HEADERS from the ambient shell environment", () => {
    const result = buildClaudeEnvironment({
      claudeArgs: [],
      baseUrl: "http://127.0.0.1:4317",
      authToken: "token",
      environment: { ANTHROPIC_CUSTOM_HEADERS: "x-team: infra" },
    });
    expect(result.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  it("still scrubs an explicit ANTHROPIC_CUSTOM_HEADERS override when a caller explicitly requests it", () => {
    const result = buildClaudeEnvironment({
      claudeArgs: [],
      baseUrl: "http://127.0.0.1:4317",
      authToken: "token",
      scrubEnvironmentKeys: ["ANTHROPIC_CUSTOM_HEADERS"],
      extraEnv: { ANTHROPIC_CUSTOM_HEADERS: "x-team: infra" },
    });
    expect(result.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  it("allows explicit launch options to opt into a safe default", () => {
    const result = buildClaudeEnvironment({
      claudeArgs: [],
      baseUrl: "http://gateway",
      authToken: "token",
      extraEnv: { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "1" },
    });
    expect(result.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe("1");
    expect(result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
  });

  it("refuses loose permissions on an existing config directory", async () => {
    const configDir = join(await privateTestRoot(), "claude");
    await mkdir(configDir, { mode: 0o700 });
    await chmod(configDir, 0o750);
    const spawner = vi.fn(async () => 0);

    await expect(launchClaude({ claudeArgs: [], baseUrl: "http://gateway", authToken: "token", configDir, spawner }))
      .rejects.toThrow(/chmod 700/);
    expect(spawner).not.toHaveBeenCalled();
  });

  it("refuses an insecure parent before creating the config directory", async () => {
    const parent = await privateTestRoot();
    await chmod(parent, 0o755);
    const configDir = join(parent, "claude");

    await expect(launchClaude({ claudeArgs: [], baseUrl: "http://gateway", authToken: "token", configDir, spawner: async () => 0 }))
      .rejects.toThrow(/chmod 700/);
    await expect(lstat(configDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses symlinked config directories and parents", async () => {
    const root = await privateTestRoot();
    const target = join(root, "target");
    await mkdir(target, { mode: 0o700 });
    const configLink = join(root, "config-link");
    await symlink(target, configLink);
    await expect(launchClaude({ claudeArgs: [], baseUrl: "http://gateway", authToken: "token", configDir: configLink, spawner: async () => 0 }))
      .rejects.toThrow(/symbolic link/);

    const parentLink = join(root, "parent-link");
    await symlink(target, parentLink);
    await expect(launchClaude({ claudeArgs: [], baseUrl: "http://gateway", authToken: "token", configDir: join(parentLink, "claude"), spawner: async () => 0 }))
      .rejects.toThrow(/symbolic link/);
  });

  it.runIf(process.getuid !== undefined)("refuses paths not owned by the current user", async () => {
    const configDir = join(await privateTestRoot(), "claude");
    await mkdir(configDir, { mode: 0o700 });
    const realUid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(realUid + 1);

    await expect(launchClaude({ claudeArgs: [], baseUrl: "http://gateway", authToken: "token", configDir, spawner: async () => 0 }))
      .rejects.toThrow(/not owned by the current user/);
  });
});
