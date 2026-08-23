import { randomUUID } from "node:crypto";
import type { CanonicalStreamEvent, Provider, ProviderMessageRequest, ProviderRequestContext, TokenCount } from "../../provider-contract.js";
import { readSse, unknownError, upstreamError } from "../http.js";
import type { ModelDescriptor, ProtocolState, ProtocolStateStore } from "../foundation/types.js";

type JsonObject = Record<string, unknown>;
type InputBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly source: { readonly type: "base64"; readonly media_type: string; readonly data: string } }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: JsonObject }
  | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string | readonly InputBlock[]; readonly is_error?: boolean }
  | { readonly type: "thinking"; readonly thinking: string; readonly signature?: string };
interface InputMessage { readonly role: "user" | "assistant"; readonly content: string | readonly InputBlock[]; }
interface InputTool { readonly name: string; readonly description?: string; readonly input_schema: JsonObject; }

/** Responses transport retains opaque output items so reasoning/tool continuations can be replayed. */
export class OpenAIResponsesAdapter implements Provider {
  public readonly models;
  private readonly endpoint: string;
  private readonly requestFetch: typeof fetch;
  public constructor(private readonly options: { id: string; apiKey: string; models: readonly ModelDescriptor[]; baseUrl: string; fetch?: typeof fetch; stateStore?: ProtocolStateStore }) {
    this.models = options.models.map((model) => ({ id: model.id, displayName: model.displayName, limits: { ...(model.contextWindow === undefined ? {} : { maxInputTokens: model.contextWindow }), ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }), contextIncludesOutput: false }, capabilities: { tokenCounting: "none" as const, usageReporting: "final" as const } }));
    this.endpoint = options.baseUrl.replace(/\/$/, ""); this.requestFetch = options.fetch ?? fetch;
  }
  public get id(): string { return this.options.id; }
  public async *streamMessage(request: ProviderMessageRequest, context: ProviderRequestContext): AsyncGenerator<CanonicalStreamEvent> {
    try {
      const prior = await this.options.stateStore?.get({ protocol: "openai-responses", session: context.session, agent: context.agent, model: request.model });
      const response = await this.requestFetch(`${this.endpoint}/responses`, { method: "POST", signal: context.signal, headers: { "content-type": "application/json", accept: "text/event-stream", Authorization: `Bearer ${this.options.apiKey}` }, body: JSON.stringify(toResponsesRequest(request, prior)) });
      if (!response.ok) throw upstreamError(response.status, await response.text(), this.options.apiKey);
      let started = false; let textOpen = false; let usage = { input_tokens: 0, output_tokens: 0 }; let stop = "end_turn"; const calls = new Map<string, { name?: string; arguments: string }>(); let rawOutput: unknown[] = [];
      for await (const frame of readSse(response)) {
        if (frame.data === "[DONE]") break;
        const payload = parse(frame.data, this.options.apiKey); const type = str(payload.type);
        if (type === "error") throw upstreamError(num(rec(payload.error).status) ?? 500, str(rec(payload.error).message) ?? "Responses stream error", this.options.apiKey);
        if (!started) { started = true; yield start(request.model, payload.response_id ?? payload.id); }
        if (type === "response.output_text.delta") { const delta = str(payload.delta) ?? ""; if (!textOpen) { textOpen = true; yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }; } if (delta) yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } }; }
        if (type === "response.output_item.added") { const item = rec(payload.item); rawOutput.push(item); if (str(item.type) === "function_call") { const name = str(item.name); calls.set(str(item.call_id) ?? str(item.id) ?? `call_${calls.size}`, { ...(name === undefined ? {} : { name }), arguments: str(item.arguments) ?? "" }); } }
        if (type === "response.function_call_arguments.delta") { const key = str(payload.call_id) ?? str(payload.item_id); if (key) { const call = calls.get(key) ?? { arguments: "" }; call.arguments += str(payload.delta) ?? ""; calls.set(key, call); } }
        if (type === "response.completed") { const result = rec(payload.response); rawOutput = arr(result.output); const wireUsage = rec(result.usage); usage = { input_tokens: num(wireUsage.input_tokens) ?? 0, output_tokens: num(wireUsage.output_tokens) ?? 0 }; }
      }
      if (!started) throw new Error("Responses stream ended before sending a chunk");
      if (textOpen) yield { type: "content_block_stop", index: 0 };
      let index = textOpen ? 1 : 0;
      for (const [id, call] of calls) { if (!call.name) continue; const input = jsonObject(call.arguments); yield { type: "content_block_start", index, content_block: { type: "tool_use", id, name: call.name, input: {} } }; yield { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }; yield { type: "content_block_stop", index }; index += 1; stop = "tool_use"; }
      if (rawOutput.length && this.options.stateStore) { const state: ProtocolState = { protocol: "openai-responses", session: context.session, agent: context.agent, model: request.model, continuations: [{ turnId: randomUUID(), kind: "assistant", payload: rawOutput }] }; await this.options.stateStore.put(state); }
      yield { type: "usage", usage: { semantics: "cumulative", stage: "final", source: "provider", inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } };
      yield { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage }; yield { type: "message_stop" };
    } catch (error: unknown) { throw unknownError(error, this.options.apiKey); }
  }
  public async countTokens(request: ProviderMessageRequest): Promise<TokenCount> { return { inputTokens: Math.ceil(JSON.stringify(request).length / 4), source: "estimated", exact: false }; }
  public async close(): Promise<void> { await this.options.stateStore?.close?.(); }
}

function toResponsesRequest(request: ProviderMessageRequest, state: ProtocolState | undefined): Record<string, unknown> {
  const replay = hasToolResult(request) ? state?.continuations.flatMap((entry) => arr(entry.payload)) ?? [] : [];
  return {
    model: request.model,
    input: [...replay, ...responseInput(request)],
    ...(systemText(request.system) === undefined ? {} : { instructions: systemText(request.system) }),
    stream: true,
    ...(Array.isArray(request.tools) ? { tools: request.tools.filter(isTool).map((tool) => ({ type: "function", name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), parameters: tool.input_schema })) } : {}),
    ...(responseToolChoice(request.tool_choice)),
    ...(typeof request.max_tokens === "number" ? { max_output_tokens: request.max_tokens } : {}),
  };
}

function systemText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((block) => isRecord(block) && typeof block.text === "string" ? [block.text] : []).join("\n");
  return text.length === 0 ? undefined : text;
}

function responseInput(request: ProviderMessageRequest): unknown[] {
  return request.messages.flatMap((item) => {
    const message = asAnthropicMessage(item); if (!message) return [];
    if (typeof message.content === "string") return [{ role: message.role, content: message.content }];
    const content: unknown[] = [];
    const calls: unknown[] = [];
    for (const block of message.content) {
      if (block.type === "text") content.push({ type: message.role === "assistant" ? "output_text" : "input_text", text: block.text });
      else if (block.type === "image") content.push({ type: "input_image", image_url: `data:${block.source.media_type};base64,${block.source.data}` });
      else if (block.type === "tool_use") calls.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      else if (block.type === "tool_result") calls.push({ type: "function_call_output", call_id: block.tool_use_id, output: responseToolOutput(block.content) });
    }
    return [...(content.length ? [{ role: message.role, content }] : []), ...calls];
  });
}

function responseToolOutput(content: string | readonly InputBlock[]): string {
  if (typeof content === "string") return content;
  return content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function hasToolResult(request: ProviderMessageRequest): boolean { return request.messages.some((value) => { const message = asAnthropicMessage(value); return Boolean(message && Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")); }); }
function responseToolChoice(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.type !== "string" || value.type === "auto") return {};
  if (value.type === "any") return { tool_choice: "required" };
  if (value.type === "tool" && typeof value.name === "string") return { tool_choice: { type: "function", name: value.name } };
  return {};
}
function start(model: string, id: unknown): CanonicalStreamEvent { return { type: "message_start", message: { id: str(id) ?? `msg_alfacode_${randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }; }
function parse(data: string, secret: string): Record<string, unknown> { try { const value: unknown = JSON.parse(data); if (!isRecord(value)) throw new Error("not an object"); return value; } catch (error: unknown) { throw unknownError(error, secret); } }
function jsonObject(data: string): Record<string, unknown> { try { const value: unknown = JSON.parse(data); return rec(value); } catch { throw new Error("Responses emitted invalid JSON tool arguments"); } }
function asAnthropicMessage(value: unknown): InputMessage | undefined { if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant") || (typeof value.content !== "string" && !Array.isArray(value.content))) return undefined; return value as unknown as InputMessage; }
function isTool(value: unknown): value is InputTool { return isRecord(value) && typeof value.name === "string" && isRecord(value.input_schema); }
function rec(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; } function arr(value: unknown): unknown[] { return Array.isArray(value) ? value : []; } function str(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; } function num(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; } function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
