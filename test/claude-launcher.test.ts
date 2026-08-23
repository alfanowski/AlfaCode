import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeEnvironment, launchClaude } from "../src/claude-launcher.js";

describe("launchClaude", () => {
  it("uses isolated config and replaces inherited cloud routing credentials", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "alfacode-claude-test-"));
    let request: Parameters<NonNullable<Parameters<typeof launchClaude>[0]["spawner"]>>[0] | undefined;
    const exitCode = await launchClaude({
      claudePath: "/test/claude",
      claudeArgs: ["--resume", "session id"],
      baseUrl: "http://127.0.0.1:4317",
      authToken: "ephemeral-token",
      configDir,
      defaultModelId: "gemini-3-pro",
      extraEnv: { ALFACODE_GATEWAY_URL: "http://127.0.0.1:4317" },
      scrubEnvironmentKeys: ["CUSTOM_GOOGLE_KEY"],
      environment: { ANTHROPIC_API_KEY: "leak", GEMINI_API_KEY: "leak", CUSTOM_GOOGLE_KEY: "leak", AWS_PROFILE: "wrong", PATH: "/bin" },
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
      ANTHROPIC_DEFAULT_OPUS_MODEL: "gemini-3-pro",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "gemini-3-pro",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "gemini-3-pro",
    });
    expect(request?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(request?.env.GEMINI_API_KEY).toBeUndefined();
    expect(request?.env.CUSTOM_GOOGLE_KEY).toBeUndefined();
    expect(request?.env.AWS_PROFILE).toBeUndefined();
    expect(request?.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    await rm(configDir, { recursive: true, force: true });
  });

  it("does not mutate the supplied process environment", () => {
    const environment = { ANTHROPIC_API_KEY: "outside", PATH: "/bin" };
    const result = buildClaudeEnvironment({ claudeArgs: [], baseUrl: "http://gateway", authToken: "token", environment });
    expect(environment).toEqual({ ANTHROPIC_API_KEY: "outside", PATH: "/bin" });
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
