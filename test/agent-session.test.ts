import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentSession } from "../src/agent-session.js";
import { PINNED_CLAUDE_CODE_VERSION } from "../src/engine-compatibility.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function isolatedConfigDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alfacode-agent-session-"));
  directories.push(root);
  return join(root, "claude");
}

function queryHarness(claudeCodeVersion: string): {
  readonly query: Query;
  readonly queryFactory: typeof import("@anthropic-ai/claude-agent-sdk").query;
  readonly permissionMode: () => unknown;
} {
  let prompt: AsyncIterable<unknown> | undefined;
  let initialPermissionMode: unknown;
  const query = {
    async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
      if (prompt === undefined) throw new Error("missing prompt stream");
      for await (const _message of prompt) {
        yield {
          type: "system", subtype: "init", session_id: "session-1", model: "route/model",
          claude_code_version: claudeCodeVersion, capabilities: ["tools"],
        } as SDKMessage;
        return;
      }
    },
    close: vi.fn(),
    interrupt: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    supportedCommands: vi.fn(async () => []),
    supportedAgents: vi.fn(async () => []),
    getContextUsage: vi.fn(async () => ({ totalTokens: 0, maxTokens: 1, rawMaxTokens: 1, percentage: 0, categories: [], gridRows: [], model: "route/model", memoryFiles: [] })),
  } as unknown as Query;
  const queryFactory = ((input: { prompt: AsyncIterable<unknown>; options: { permissionMode: unknown } }) => {
    prompt = input.prompt;
    initialPermissionMode = input.options.permissionMode;
    return query;
  }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
  return { query, queryFactory, permissionMode: () => initialPermissionMode };
}

describe("AgentSession", () => {
  it("renders before initialization and relaxes permissions only after verifying the engine", async () => {
    const runtimeClose = vi.fn(async () => undefined);
    const harness = queryHarness(PINNED_CLAUDE_CODE_VERSION);
    const session = await AgentSession.start({
      runtime: { baseUrl: "http://127.0.0.1:1", authToken: "token", close: runtimeClose },
      configDir: await isolatedConfigDir(),
      canUseTool: async () => ({ behavior: "allow" }),
      queryFactory: harness.queryFactory,
    });

    let initialized = false;
    void session.identity().then(() => { initialized = true; });
    await Promise.resolve();
    expect(initialized).toBe(false);
    expect(harness.permissionMode()).toBe("dontAsk");

    session.sendPrompt("hello");
    await expect(session.identity()).resolves.toMatchObject({
      sessionId: "session-1",
      model: "route/model",
      claudeCodeVersion: PINNED_CLAUDE_CODE_VERSION,
      compatibility: { status: "compatible", compatible: true, actual: PINNED_CLAUDE_CODE_VERSION },
    });
    expect(harness.query.setPermissionMode).toHaveBeenCalledWith("default");
    await session.close();
    expect(harness.query.close).toHaveBeenCalled();
    expect(runtimeClose).toHaveBeenCalledOnce();
  });

  it("keeps restrictive permissions and warns when the real engine version is incompatible", async () => {
    const harness = queryHarness("2.1.999");
    const warning = vi.fn();
    const session = await AgentSession.start({
      runtime: { baseUrl: "http://127.0.0.1:1", authToken: "token", close: async () => undefined },
      configDir: await isolatedConfigDir(),
      canUseTool: async () => ({ behavior: "allow" }),
      queryFactory: harness.queryFactory,
      onStderr: warning,
    });

    session.sendPrompt("hello");
    await expect(session.identity()).resolves.toMatchObject({
      claudeCodeVersion: "2.1.999",
      compatibility: {
        status: "incompatible",
        compatible: false,
        expected: PINNED_CLAUDE_CODE_VERSION,
        actual: "2.1.999",
      },
    });
    expect(harness.permissionMode()).toBe("dontAsk");
    expect(harness.query.setPermissionMode).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(`expects Claude Code ${PINNED_CLAUDE_CODE_VERSION}, but the Agent SDK started 2.1.999`));
    await session.close();
  });

  it("surfaces the compatibility warning as a transcript notification (not raw stderr) when no stderr sink is wired up", async () => {
    const harness = queryHarness("2.1.999");
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const received: SDKMessage[] = [];
    const session = await AgentSession.start({
      runtime: { baseUrl: "http://127.0.0.1:1", authToken: "token", close: async () => undefined },
      configDir: await isolatedConfigDir(),
      canUseTool: async () => ({ behavior: "allow" }),
      queryFactory: harness.queryFactory,
    });
    session.subscribe((message) => { received.push(message); });

    session.sendPrompt("hello");
    await session.identity();

    expect(stderrWrite).not.toHaveBeenCalled();
    expect(received).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "notification",
      text: expect.stringContaining(`expects Claude Code ${PINNED_CLAUDE_CODE_VERSION}, but the Agent SDK started 2.1.999`),
    }));
    await session.close();
    stderrWrite.mockRestore();
  });

  it("rejects an unsafe config directory before constructing the SDK query", async () => {
    const configDir = await isolatedConfigDir();
    await mkdir(configDir, { mode: 0o700 });
    await chmod(configDir, 0o755);
    const queryFactory = vi.fn();

    await expect(AgentSession.start({
      runtime: { baseUrl: "http://127.0.0.1:1", authToken: "token", close: async () => undefined },
      configDir,
      canUseTool: async () => ({ behavior: "allow" }),
      queryFactory: queryFactory as never,
    })).rejects.toThrow(/chmod 700/);
    expect(queryFactory).not.toHaveBeenCalled();
  });
});
