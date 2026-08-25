import { describe, expect, it, vi } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentSession } from "../src/agent-session.js";
import { renameAlfaCodeSession } from "../src/session-history.js";

vi.mock("../src/session-history.js", () => ({ renameAlfaCodeSession: vi.fn(async () => undefined) }));

function makeFakeQuery(overrides: Partial<Record<string, unknown>> = {}): Query {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
      yield {
        type: "system", subtype: "init", session_id: "session-1", model: "route/model",
        claude_code_version: "2.1.241", capabilities: ["tools"],
      } as SDKMessage;
    },
    close: vi.fn(),
    interrupt: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    supportedCommands: vi.fn(async () => []),
    supportedAgents: vi.fn(async () => []),
    getContextUsage: vi.fn(async () => ({ totalTokens: 0, maxTokens: 1, rawMaxTokens: 1, percentage: 0, categories: [], gridRows: [], model: "route/model", memoryFiles: [] })),
    rewindFiles: vi.fn(async () => ({ canRewind: true, filesChanged: ["a.ts"], insertions: 1, deletions: 0 })),
    ...overrides,
  } as unknown as Query;
}

describe("AgentSession", () => {
  it("renders before initialization and starts after the first streamed prompt", async () => {
    let prompt: AsyncIterable<unknown> | undefined;
    let closed = false;
    const runtimeClose = vi.fn(async () => undefined);
    const fakeQuery = {
      async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
        if (prompt === undefined) throw new Error("missing prompt stream");
        for await (const _message of prompt) {
          yield {
            type: "system", subtype: "init", session_id: "session-1", model: "route/model",
            claude_code_version: "2.1.241", capabilities: ["tools"],
          } as SDKMessage;
          return;
        }
      },
      close: vi.fn(() => { closed = true; }),
      interrupt: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async () => undefined),
      supportedCommands: vi.fn(async () => []),
      supportedAgents: vi.fn(async () => []),
      getContextUsage: vi.fn(async () => ({ totalTokens: 0, maxTokens: 1, rawMaxTokens: 1, percentage: 0, categories: [], gridRows: [], model: "route/model", memoryFiles: [] })),
    } as unknown as Query;
    const session = await AgentSession.start({
      runtime: { baseUrl: "http://127.0.0.1:1", authToken: "token", close: runtimeClose },
      canUseTool: async () => ({ behavior: "allow" }),
      queryFactory: ((input: { prompt: AsyncIterable<unknown> }) => { prompt = input.prompt; return fakeQuery; }) as never,
    });

    let initialized = false;
    void session.identity().then(() => { initialized = true; });
    await Promise.resolve();
    expect(initialized).toBe(false);

    session.sendPrompt("hello");
    await expect(session.identity()).resolves.toMatchObject({ sessionId: "session-1", model: "route/model", claudeCodeVersion: "2.1.241" });
    await session.close();
    expect(closed).toBe(true);
    expect(runtimeClose).toHaveBeenCalledOnce();
  });

  it("wires continue and file checkpointing into the query options, without resume", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    await AgentSession.start({
      runtime: { baseUrl: "http://127.0.0.1:1", authToken: "token", close: async () => undefined },
      canUseTool: async () => ({ behavior: "allow" }),
      continue: true,
      queryFactory: ((input: { options: Record<string, unknown> }) => { capturedOptions = input.options; return makeFakeQuery(); }) as never,
    });
    expect(capturedOptions).toMatchObject({ continue: true, enableFileCheckpointing: true, persistSession: true });
    expect(capturedOptions?.resume).toBeUndefined();
  });

  it("wires resume into the query options, without continue", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    await AgentSession.start({
      runtime: { baseUrl: "http://127.0.0.1:1", authToken: "token", close: async () => undefined },
      canUseTool: async () => ({ behavior: "allow" }),
      resume: "session-abc",
      queryFactory: ((input: { options: Record<string, unknown> }) => { capturedOptions = input.options; return makeFakeQuery(); }) as never,
    });
    expect(capturedOptions).toMatchObject({ resume: "session-abc", enableFileCheckpointing: true });
    expect(capturedOptions?.continue).toBeUndefined();
  });

  it("forwards rewindFiles to the underlying query", async () => {
    const rewindFilesMock = vi.fn(async () => ({ canRewind: true, filesChanged: ["a.ts"], insertions: 1, deletions: 0 }));
    const fakeQuery = makeFakeQuery({ rewindFiles: rewindFilesMock });
    const session = await AgentSession.start({
      runtime: { baseUrl: "http://127.0.0.1:1", authToken: "token", close: async () => undefined },
      canUseTool: async () => ({ behavior: "allow" }),
      queryFactory: (() => fakeQuery) as never,
    });
    const result = await session.rewindFiles("prompt-uuid", { dryRun: true });
    expect(result).toMatchObject({ canRewind: true, filesChanged: ["a.ts"] });
    expect(rewindFilesMock).toHaveBeenCalledWith("prompt-uuid", { dryRun: true });
  });

  it("renames the session once identity resolves, scoped to cwd and configDir", async () => {
    const session = await AgentSession.start({
      runtime: { baseUrl: "http://127.0.0.1:1", authToken: "token", close: async () => undefined },
      cwd: "/repo",
      configDir: "/config/alfacode-claude",
      canUseTool: async () => ({ behavior: "allow" }),
      queryFactory: (() => makeFakeQuery()) as never,
    });
    await session.rename("My session");
    expect(vi.mocked(renameAlfaCodeSession)).toHaveBeenCalledWith("session-1", "My session", { cwd: "/repo", configDir: "/config/alfacode-claude" });
  });
});
