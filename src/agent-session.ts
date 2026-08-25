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

export interface AgentRuntimeHandle {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly defaultModelId?: string;
  readonly contextWindowTokens?: number;
  readonly secretEnvironmentNames?: readonly string[];
  close(): Promise<void>;
}

export interface AgentSessionOptions {
  readonly runtime: AgentRuntimeHandle;
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

/**
 * An image to attach alongside a prompt's text. The Messages API (and the SDK's `MessageParam`
 * content, which accepts `string | Array<ContentBlockParam>`) already supports image content blocks
 * in outgoing user messages — this is composer-side plumbing (image paste / dropped image files)
 * riding that existing capability, not a new wire format.
 */
export interface PromptImageAttachment {
  readonly mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly base64: string;
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
  private didInitialize = false;
  private initializationTimer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<(message: SDKMessage) => void | Promise<void>>();

  private constructor(private readonly options: AgentSessionOptions) {
    this.initialized = new Promise((resolve, reject) => {
      this.resolveInitialized = resolve;
      this.rejectInitialized = reject;
    });
    // Native mode renders before the SDK starts its child process. Keep the
    // deferred identity observable without producing an unhandled rejection
    // if initialization fails before the UI asks for it.
    void this.initialized.catch(() => undefined);
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
        promptSuggestions: true,
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
    return new AgentSession(options);
  }

  public identity(): Promise<AgentSessionIdentity> {
    return this.initialized;
  }

  public subscribe(listener: (message: SDKMessage) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public sendPrompt(text: string, attachments: readonly PromptImageAttachment[] = []): string {
    if (text.trim().length === 0) throw new Error("Prompt cannot be empty");
    const uuid = randomUUID();
    const content = attachments.length === 0 ? text : [
      ...attachments.map((attachment) => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: attachment.mediaType, data: attachment.base64 },
      })),
      { type: "text" as const, text },
    ];
    this.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      uuid,
    });
    if (!this.didInitialize && this.initializationTimer === undefined) {
      this.initializationTimer = setTimeout(() => {
        const error = new Error("Claude Code engine initialization timed out");
        this.rejectInitialized(error);
        this.query.close();
      }, this.options.initializationTimeoutMs ?? 15_000);
    }
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
    if (this.initializationTimer !== undefined) clearTimeout(this.initializationTimer);
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
          this.didInitialize = true;
          if (this.initializationTimer !== undefined) {
            clearTimeout(this.initializationTimer);
            this.initializationTimer = undefined;
          }
          this.resolveInitialized({
            sessionId: message.session_id,
            model: message.model,
            claudeCodeVersion: message.claude_code_version,
            compatibility: checkEngineCompatibility(message.claude_code_version),
            capabilities: message.capabilities ?? [],
          });
        }
        await this.options.onMessage?.(message);
        for (const listener of this.listeners) await listener(message);
      }
      if (!sawInit) this.rejectInitialized(new Error("Claude Code engine exited before initialization"));
      else if (!this.closed) {
        const message = syntheticEngineError(new Error("Claude Code engine exited unexpectedly"));
        await this.options.onMessage?.(message);
        for (const listener of this.listeners) await listener(message);
      }
    } catch (error) {
      if (this.initializationTimer !== undefined) {
        clearTimeout(this.initializationTimer);
        this.initializationTimer = undefined;
      }
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (!sawInit) this.rejectInitialized(normalized);
      const message = syntheticEngineError(normalized);
      await this.options.onMessage?.(message);
      for (const listener of this.listeners) await listener(message);
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
