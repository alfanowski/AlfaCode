import { describe, expect, it, vi } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentSession } from "../src/agent-session.js";

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

  it("sends image attachments as content blocks ahead of the text block", async () => {
    let prompt: AsyncIterable<unknown> | undefined;
    const fakeQuery = {
      async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "s", model: "m", claude_code_version: "2.1.241", capabilities: [] } as unknown as SDKMessage;
      },
      close: vi.fn(),
      interrupt: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async () => undefined),
      supportedCommands: vi.fn(async () => []),
      supportedAgents: vi.fn(async () => []),
      getContextUsage: vi.fn(async () => ({ totalTokens: 0, maxTokens: 1, rawMaxTokens: 1, percentage: 0, categories: [], gridRows: [], model: "m", memoryFiles: [] })),
    } as unknown as Query;
    const session = await AgentSession.start({
      runtime: { baseUrl: "http://127.0.0.1:1", authToken: "token", close: async () => undefined },
      canUseTool: async () => ({ behavior: "allow" }),
      queryFactory: ((input: { prompt: AsyncIterable<unknown> }) => { prompt = input.prompt; return fakeQuery; }) as never,
    });

    session.sendPrompt("look at this", [{ mediaType: "image/png", base64: "Zm9v" }]);
    const iterator = prompt![Symbol.asyncIterator]();
    const { value: pushed } = await iterator.next();

    expect(pushed).toMatchObject({
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "Zm9v" } },
          { type: "text", text: "look at this" },
        ],
      },
    });
  });
});
