import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  query as createQuery,
  type CanUseTool,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeEnvironment } from "./claude-launcher.js";
import { ALFACODE_CLIENT_ID, checkEngineCompatibility, type EngineCompatibility } from "./engine-compatibility.js";
import type { RuntimeHandle } from "./runtime.js";

export interface AgentSessionOptions {
  readonly runtime: RuntimeHandle;
  readonly cwd?: string;
  readonly configDir?: string;
  readonly permissionMode?: PermissionMode;
  readonly canUseTool: CanUseTool;
  readonly resume?: string;
  readonly onMessage?: (message: SDKMessage) => void | Promise<void>;
  readonly onStderr?: (message: string) => void;
  readonly queryFactory?: typeof createQuery;
  readonly initializationTimeoutMs?: number;
}

export interface AgentSessionIdentity {
  readonly sessionId: string;
  readonly model: string;
  readonly claudeCodeVersion: string;
  readonly compatibility: EngineCompatibility;
  readonly capabilities: readonly string[];
}

class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private readonly readers: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;

  public push(message: SDKUserMessage): void {
    if (this.ended) throw new Error("Cannot send a prompt after the session has closed");
    const reader = this.readers.shift();
    if (reader === undefined) this.pending.push(message);
    else reader({ done: false, value: message });
  }

  public close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined });
  }

  public [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        const message = this.pending.shift();
        if (message !== undefined) return { done: false, value: message };
        if (this.ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => this.readers.push(resolve));
      },
    };
  }
}

export class AgentSession {
  private readonly input = new AsyncMessageQueue();
  private readonly query: Query;
  private readonly initialized: Promise<AgentSessionIdentity>;
  private resolveInitialized!: (identity: AgentSessionIdentity) => void;
  private rejectInitialized!: (error: Error) => void;
  private consumePromise: Promise<void>;
  private closed = false;

  private constructor(private readonly options: AgentSessionOptions) {
    this.initialized = new Promise((resolve, reject) => {
      this.resolveInitialized = resolve;
      this.rejectInitialized = reject;
    });
    const configDir = options.configDir ?? join(homedir(), ".alfacode", "claude");
    const env = buildClaudeEnvironment({
      claudeArgs: [],
      baseUrl: options.runtime.baseUrl,
      authToken: options.runtime.authToken,
      configDir,
      ...(options.runtime.defaultModelId === undefined ? {} : { defaultModelId: options.runtime.defaultModelId }),
      ...(options.runtime.contextWindowTokens === undefined ? {} : { contextWindowTokens: options.runtime.contextWindowTokens }),
      ...(options.runtime.secretEnvironmentNames === undefined ? {} : { scrubEnvironmentKeys: options.runtime.secretEnvironmentNames }),
      extraEnv: { CLAUDE_AGENT_SDK_CLIENT_APP: ALFACODE_CLIENT_ID },
    });
    this.query = (options.queryFactory ?? createQuery)({
      prompt: this.input,
      options: {
        cwd: options.cwd ?? process.cwd(),
        env,
        canUseTool: options.canUseTool,
        permissionMode: options.permissionMode ?? "default",
        includePartialMessages: true,
        forwardSubagentText: true,
        agentProgressSummaries: true,
        systemPrompt: { type: "preset", preset: "claude_code" },
        tools: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        persistSession: true,
        ...(options.resume === undefined ? {} : { resume: options.resume }),
        ...(options.onStderr === undefined ? {} : { stderr: options.onStderr }),
      },
    });
    this.consumePromise = this.consume();
  }

  public static async start(options: AgentSessionOptions): Promise<AgentSession> {
    const session = new AgentSession(options);
    try {
      await withTimeout(session.initialized, options.initializationTimeoutMs ?? 15_000, "Claude Code engine initialization timed out");
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  public identity(): Promise<AgentSessionIdentity> {
    return this.initialized;
  }

  public sendPrompt(text: string): string {
    if (text.trim().length === 0) throw new Error("Prompt cannot be empty");
    const uuid = randomUUID();
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid,
    });
    return uuid;
  }

  public interrupt(): Promise<unknown> {
    return this.query.interrupt();
  }

  public setModel(model?: string): Promise<void> {
    return this.query.setModel(model);
  }

  public setPermissionMode(mode: PermissionMode): Promise<void> {
    return this.query.setPermissionMode(mode);
  }

  public supportedCommands(): ReturnType<Query["supportedCommands"]> {
    return this.query.supportedCommands();
  }

  public supportedAgents(): ReturnType<Query["supportedAgents"]> {
    return this.query.supportedAgents();
  }

  public contextUsage(): ReturnType<Query["getContextUsage"]> {
    return this.query.getContextUsage();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    this.query.close();
    await Promise.allSettled([this.consumePromise, this.options.runtime.close()]);
  }

  private async consume(): Promise<void> {
    let sawInit = false;
    try {
      for await (const message of this.query) {
        if (!sawInit && isInitMessage(message)) {
          sawInit = true;
          this.resolveInitialized({
            sessionId: message.session_id,
            model: message.model,
            claudeCodeVersion: message.claude_code_version,
            compatibility: checkEngineCompatibility(message.claude_code_version),
            capabilities: message.capabilities ?? [],
          });
        }
        await this.options.onMessage?.(message);
      }
      if (!sawInit) this.rejectInitialized(new Error("Claude Code engine exited before initialization"));
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (!sawInit) this.rejectInitialized(normalized);
      else await this.options.onMessage?.(syntheticEngineError(normalized));
    }
  }
}

function isInitMessage(message: SDKMessage): message is SDKSystemMessage {
  return message.type === "system" && message.subtype === "init";
}

function syntheticEngineError(error: Error): SDKMessage {
  return {
    type: "system",
    subtype: "notification",
    key: "alfacode-engine-error",
    text: error.message,
    priority: "immediate",
    uuid: randomUUID(),
    session_id: "unknown",
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
