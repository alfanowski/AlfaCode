import { randomUUID } from "node:crypto";
import type {
  AnthropicUsage,
  CanonicalStreamEvent,
  Provider,
  ProviderMessageRequest,
  ProviderRequestContext,
} from "../../provider-contract.js";
import { readSse, unknownError, upstreamError } from "../http.js";
import type { ModelDescriptor, ProtocolStateStore } from "../foundation/types.js";

export interface OpenAIChatAdapterOptions {
  readonly id: string;
  readonly apiKey: string;
  readonly models: readonly ModelDescriptor[];
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly stateStore?: ProtocolStateStore;
}

interface ToolAccumulator { id?: string; name?: string; arguments: string; }
type JsonObject = Record<string, unknown>;
type InputBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly source: { readonly type: "base64"; readonly media_type: string; readonly data: string } }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: JsonObject }
  | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string | readonly InputBlock[]; readonly is_error?: boolean }
  | { readonly type: "thinking"; readonly thinking: string; readonly signature?: string };
interface InputMessage { readonly role: "user" | "assistant"; readonly content: string | readonly InputBlock[]; }
interface InputTool { readonly name: string; readonly description?: string; readonly input_schema: JsonObject; }

/** OpenAI Chat Completions adapter, including indexed fragmented tool-call assembly. */
export class OpenAIChatAdapter implements Provider {
  public readonly models;
  private readonly endpoint: string;
  private readonly requestFetch: typeof fetch;

  public constructor(private readonly options: OpenAIChatAdapterOptions) {
    this.models = options.models.map((model) => ({ id: model.id, displayName: model.displayName }));
    this.endpoint = options.baseUrl.replace(/\/$/, "");
    this.requestFetch = options.fetch ?? fetch;
  }

  public get id(): string { return this.options.id; }

  public async *streamMessage(request: ProviderMessageRequest, context: ProviderRequestContext): AsyncGenerator<CanonicalStreamEvent> {
    let response: Response;
    try {
      response = await this.requestFetch(`${this.endpoint}/chat/completions`, {
        method: "POST",
        signal: context.signal,
        headers: { "content-type": "application/json", accept: "text/event-stream", Authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify(toChatRequest(request)),
      });
      if (!response.ok) throw upstreamError(response.status, await response.text(), this.options.apiKey);
      let messageStarted = false;
      let textBlockOpen = false;
      let textBlockIndex = 0;
      let nextBlockIndex = 1;
      let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
      let stopReason = "end_turn";
      const tools = new Map<number, ToolAccumulator>();

      for await (const frame of readSse(response)) {
        if (frame.data === "[DONE]") break;
        const chunk = parseChunk(frame.data, this.options.apiKey);
        const errorPayload = asRecord(chunk.error);
        if (Object.keys(errorPayload).length > 0) throw upstreamError(numberValue(errorPayload.status) ?? 500, stringValue(errorPayload.message) ?? "OpenAI stream error", this.options.apiKey);
        if (!messageStarted) {
          messageStarted = true;
          yield messageStart(request.model, chunk.id);
        }
        const choice = firstChoice(chunk);
        const delta = asRecord(choice?.delta);
        const content = stringValue(delta.content);
        if (content) {
          if (!textBlockOpen) {
            textBlockOpen = true;
            textBlockIndex = 0;
            yield { type: "content_block_start", index: textBlockIndex, content_block: { type: "text", text: "" } };
          }
          yield { type: "content_block_delta", index: textBlockIndex, delta: { type: "text_delta", text: content } };
        }
        for (const call of arrayValue(delta.tool_calls)) {
          const record = asRecord(call);
          const index = numberValue(record.index);
          if (index === undefined) continue;
          const current = tools.get(index) ?? { arguments: "" };
          const fn = asRecord(record.function);
          const id = stringValue(record.id);
          const name = stringValue(fn.name);
          if (id !== undefined) current.id = id;
          if (name !== undefined) current.name = name;
          current.arguments += stringValue(fn.arguments) ?? "";
          tools.set(index, current);
        }
        const finishReason = stringValue(choice?.finish_reason);
        if (finishReason) stopReason = mapFinishReason(finishReason);
        const wireUsage = asRecord(chunk.usage);
        if (Object.keys(wireUsage).length > 0) usage = { input_tokens: numberValue(wireUsage.prompt_tokens) ?? 0, output_tokens: numberValue(wireUsage.completion_tokens) ?? 0 };
      }
      if (!messageStarted) throw new Error("OpenAI stream ended before sending a chunk");
      if (textBlockOpen) {
        yield { type: "content_block_stop", index: textBlockIndex };
        nextBlockIndex = 1;
      } else nextBlockIndex = 0;
      for (const [, tool] of [...tools.entries()].sort(([a], [b]) => a - b)) {
        const name = tool.name;
        if (!name) throw new Error("OpenAI stream emitted a tool call without a function name");
        const id = tool.id ?? `call_alfacode_${randomUUID().replaceAll("-", "")}`;
        const input = parseToolArguments(tool.arguments);
        yield { type: "content_block_start", index: nextBlockIndex, content_block: { type: "tool_use", id, name, input: {} } };
        yield { type: "content_block_delta", index: nextBlockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } };
        yield { type: "content_block_stop", index: nextBlockIndex };
        nextBlockIndex += 1;
      }
      if (tools.size > 0) stopReason = "tool_use";
      yield { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage };
      yield { type: "message_stop" };
    } catch (error: unknown) {
      throw unknownError(error, this.options.apiKey);
    }
  }

  public async countTokens(request: ProviderMessageRequest, _context: ProviderRequestContext): Promise<AnthropicUsage> {
    // Generic Chat Completions exposes no portable count endpoint; keep the capability marked false.
    return { input_tokens: Math.ceil(JSON.stringify(toChatRequest(request)).length / 4), output_tokens: 0 };
  }

  public async close(): Promise<void> {
    await this.options.stateStore?.close?.();
  }
}

function toChatRequest(request: ProviderMessageRequest): Record<string, unknown> {
  const messages = toChatMessages(request.messages);
  const tools = Array.isArray(request.tools) ? request.tools.filter(isTool).map((tool) => ({ type: "function", function: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), parameters: tool.input_schema } })) : undefined;
  const toolChoice = mapToolChoice(request.tool_choice);
  return {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(typeof request.max_tokens === "number" ? { max_tokens: request.max_tokens } : {}),
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
    ...(typeof request.top_p === "number" ? { top_p: request.top_p } : {}),
    ...(Array.isArray(request.stop_sequences) ? { stop: request.stop_sequences } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
}

function toChatMessages(input: readonly unknown[]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const item of input) {
    const message = asAnthropicMessage(item);
    if (!message) continue;
    const blocks: readonly InputBlock[] = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    if (message.role === "assistant") {
      const text = blocks.filter(isText).map((block) => block.text).join("\n");
      const toolCalls = blocks.filter(isToolUse).map((block) => ({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) } }));
      output.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    const toolResults = blocks.filter(isToolResult);
    for (const result of toolResults) output.push({ role: "tool", tool_call_id: result.tool_use_id, content: toolResultText(result) });
    const normal = blocks.filter((block) => !isToolResult(block));
    if (normal.length) output.push({ role: "user", content: normal.map(toChatContent).filter((entry): entry is Record<string, unknown> | string => entry !== undefined) });
  }
  return output;
}

function asAnthropicMessage(value: unknown): InputMessage | undefined {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) return undefined;
  if (typeof value.content !== "string" && !Array.isArray(value.content)) return undefined;
  return value as unknown as InputMessage;
}
function toChatContent(block: InputBlock): Record<string, unknown> | string | undefined {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") return { type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
  return undefined;
}
function isTool(value: unknown): value is InputTool { return isRecord(value) && typeof value.name === "string" && isRecord(value.input_schema); }
function isText(block: InputBlock): block is Extract<InputBlock, { type: "text" }> { return block.type === "text"; }
function isToolUse(block: InputBlock): block is Extract<InputBlock, { type: "tool_use" }> { return block.type === "tool_use"; }
function isToolResult(block: InputBlock): block is Extract<InputBlock, { type: "tool_result" }> { return block.type === "tool_result"; }
function toolResultText(block: Extract<InputBlock, { type: "tool_result" }>): string { return typeof block.content === "string" ? block.content : block.content.filter(isText).map((entry) => entry.text).join("\n"); }
function mapToolChoice(value: unknown): unknown {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "auto") return "auto";
  if (value.type === "any") return "required";
  if (value.type === "none") return "none";
  if (value.type === "tool" && typeof value.name === "string") return { type: "function", function: { name: value.name } };
  return undefined;
}
function messageStart(model: string, id: unknown): CanonicalStreamEvent { return { type: "message_start", message: { id: stringValue(id) ?? `msg_alfacode_${randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }; }
function parseChunk(data: string, secret: string): Record<string, unknown> { try { const value: unknown = JSON.parse(data); if (!isRecord(value)) throw new Error("not an object"); return value; } catch (error: unknown) { throw unknownError(new Error(`Invalid OpenAI SSE payload: ${error instanceof Error ? error.message : String(error)}`), secret); } }
function firstChoice(chunk: Record<string, unknown>): Record<string, unknown> | undefined { const first = arrayValue(chunk.choices)[0]; return isRecord(first) ? first : undefined; }
function parseToolArguments(value: string): Record<string, unknown> { if (!value) return {}; try { const parsed: unknown = JSON.parse(value); return isRecord(parsed) ? parsed : {}; } catch { throw new Error("OpenAI stream emitted invalid JSON tool arguments"); } }
function mapFinishReason(value: string): string { return value === "tool_calls" ? "tool_use" : value === "length" ? "max_tokens" : value === "content_filter" ? "content_filtered" : "end_turn"; }
function asRecord(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
