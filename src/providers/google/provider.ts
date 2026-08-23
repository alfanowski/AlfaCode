import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { FileGoogleStateStore, type GoogleStateStore, type ToolCallState } from './state-store.js';
import type {
  AnthropicContentBlock,
  AnthropicRequest,
  CanonicalStreamEvent,
  GoogleContent,
  GoogleGenerateParameters,
  GoogleGenerateResponse,
  GoogleModel,
  GooglePart,
  GoogleSdkClient,
  JsonObject,
  ProviderContext,
  ProviderModel,
} from './types.js';

export interface GoogleProviderOptions {
  apiKey?: string;
  client?: GoogleSdkClient;
  stateStore?: GoogleStateStore;
  statePath?: string;
}

/** Stateless Generate Content adapter. Conversation metadata is retained only for Gemini tool replay. */
export class GoogleProvider {
  public readonly id = 'google';
  private readonly client: GoogleSdkClient;
  private readonly stateStore: GoogleStateStore;

  public constructor(options: GoogleProviderOptions = {}) {
    this.client = options.client ?? new GoogleGenAI(options.apiKey === undefined ? {} : { apiKey: options.apiKey }) as unknown as GoogleSdkClient;
    this.stateStore = options.stateStore ?? new FileGoogleStateStore(options.statePath ?? '.polycode/google-tool-state.json');
  }

  public async listModels(): Promise<ProviderModel[]> {
    const pager = await this.client.models.list({ config: { pageSize: 100 } });
    const models: ProviderModel[] = [];
    for await (const model of pager) {
      if (!supportsGenerateContent(model)) continue;
      const name = model.name;
      if (!name) continue;
      models.push({
        id: name.replace(/^models\//, ''),
        displayName: model.displayName ?? name,
        ...(model.inputTokenLimit === undefined ? {} : { contextWindow: model.inputTokenLimit }),
        ...(model.outputTokenLimit === undefined ? {} : { maxOutputTokens: model.outputTokenLimit }),
      });
    }
    return models;
  }

  public async *stream(request: AnthropicRequest, context: ProviderContext): AsyncGenerator<CanonicalStreamEvent> {
    try {
      const mapped = await this.mapRequest(request, context);
      for (const warning of mapped.warnings) yield { type: 'warning', message: warning };

      const responseStream = await this.client.models.generateContentStream(mapped.params);
      let sawToolUse = false;
      let finishReason: string | undefined;
      let usage: GoogleGenerateResponse['usageMetadata'];
      const emittedToolCalls = new Set<string>();
      let functionCallOrdinal = 0;

      for await (const chunk of responseStream) {
        usage = chunk.usageMetadata ?? usage;
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;
        finishReason = candidate.finishReason ?? finishReason;
        for (const part of candidate.content?.parts ?? []) {
          if (part.text && !part.thought) yield { type: 'text_delta', text: part.text };
          if (part.functionCall) {
            const tool = await this.normaliseFunctionCall(part, context, functionCallOrdinal);
            functionCallOrdinal += 1;
            // Gemini can repeat a complete function call in a later stream chunk.
            if (!emittedToolCalls.has(tool.id)) {
              emittedToolCalls.add(tool.id);
              sawToolUse = true;
              yield { type: 'tool_use', id: tool.id, name: tool.name, input: tool.input };
            }
          }
        }
      }
      if (usage) yield { type: 'usage', input_tokens: usage.promptTokenCount ?? 0, output_tokens: usage.candidatesTokenCount ?? 0 };
      yield { type: 'message_delta', stop_reason: mapFinishReason(finishReason, sawToolUse) };
    } catch (error: unknown) {
      yield { type: 'error', error: { type: errorName(error), message: safeErrorMessage(error) } };
    }
  }

  public async countTokens(request: AnthropicRequest, model: string, context: ProviderContext): Promise<number> {
    const mapped = await this.mapRequest({ ...request, model }, context);
    const response = await this.client.models.countTokens({
      model,
      contents: mapped.params.contents,
      ...(mapped.params.config === undefined ? {} : { config: mapped.params.config }),
    });
    return response.totalTokens ?? 0;
  }

  public async close(): Promise<void> {
    await this.stateStore.close?.();
  }

  private async mapRequest(request: AnthropicRequest, context: ProviderContext): Promise<{ params: GoogleGenerateParameters; warnings: string[] }> {
    const warnings: string[] = [];
    const contents: GoogleContent[] = [];
    for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
      const message = request.messages[messageIndex];
      if (!message) continue;
      const parts = await this.mapMessage(message.content, message.role, context, messageIndex);
      if (parts.length > 0) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
    }
    const systemText = typeof request.system === 'string'
      ? request.system
      : request.system?.map((block) => block.text).join('\n');
    const config: NonNullable<GoogleGenerateParameters['config']> = {
      ...(context.signal === undefined ? {} : { abortSignal: context.signal }),
      ...(systemText ? { systemInstruction: { role: 'user', parts: [{ text: systemText }] } } : {}),
      ...(request.max_tokens === undefined ? {} : { maxOutputTokens: request.max_tokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.top_p === undefined ? {} : { topP: request.top_p }),
      ...(request.top_k === undefined ? {} : { topK: request.top_k }),
      ...(request.stop_sequences === undefined ? {} : { stopSequences: request.stop_sequences }),
    };
    if (request.tools && request.tools.length > 0) {
      config.tools = [{ functionDeclarations: request.tools.map((tool) => {
        const result = sanitiseSchema(tool.input_schema, `tools.${tool.name}.input_schema`);
        warnings.push(...result.warnings);
        return {
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          parametersJsonSchema: result.schema,
        };
      }) }];
      const choice = request.tool_choice;
      if (choice) {
        const mode = choice.type === 'none' ? 'NONE' : choice.type === 'auto' ? 'AUTO' : 'ANY';
        config.toolConfig = { functionCallingConfig: {
          mode,
          ...((choice.type === 'tool' && choice.name) ? { allowedFunctionNames: [choice.name] } : {}),
        } };
      }
    }
    return { params: { model: request.model, contents, config }, warnings };
  }

  private async mapMessage(content: string | AnthropicContentBlock[], role: 'user' | 'assistant', context: ProviderContext, messageIndex: number): Promise<GooglePart[]> {
    if (typeof content === 'string') return [{ text: content }];
    const parts: GooglePart[] = [];
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex];
      if (!block) continue;
      if (block.type === 'text') parts.push({ text: block.text });
      else if (block.type === 'image') parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
      else if (block.type === 'tool_use') {
        const id = block.id ?? stableToolId(context, messageIndex, blockIndex, block.name, block.input);
        const state = await this.stateStore.get(context.session, context.agent, id);
        parts.push({ functionCall: { id, name: state?.name ?? block.name, args: block.input }, ...(state?.thoughtSignature ? { thoughtSignature: state.thoughtSignature } : {}) });
        if (!state) await this.stateStore.put(context.session, context.agent, id, { id, name: block.name });
      } else if (block.type === 'tool_result') {
        const state = await this.stateStore.get(context.session, context.agent, block.tool_use_id);
        if (!state) throw new Error(`Unknown tool result id '${block.tool_use_id}'; Gemini requires the original function name.`);
        parts.push({ functionResponse: {
          id: state.id,
          name: state.name,
          response: toolResultResponse(block),
        } });
      }
    }
    if (role === 'assistant' && parts.some((part) => part.functionResponse)) {
      throw new Error('Anthropic tool_result blocks must be user messages.');
    }
    return parts;
  }

  private async normaliseFunctionCall(part: GooglePart, context: ProviderContext, ordinal: number): Promise<{ id: string; name: string; input: JsonObject }> {
    const call = part.functionCall;
    if (!call?.name) throw new Error('Gemini returned a function call without a name.');
    const id = call.id ?? stableToolId(context, 0, ordinal, call.name, call.args ?? {});
    const value: ToolCallState = { id, name: call.name, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) };
    await this.stateStore.put(context.session, context.agent, id, value);
    return { id, name: call.name, input: call.args ?? {} };
  }
}

function supportsGenerateContent(model: GoogleModel): boolean {
  return model.supportedActions?.some((action) => action === 'generateContent' || action === 'generate_content') ?? false;
}

function toolResultResponse(block: Extract<AnthropicContentBlock, { type: 'tool_result' }>): JsonObject {
  const text = typeof block.content === 'string' ? block.content : block.content
    .filter((entry): entry is Extract<AnthropicContentBlock, { type: 'text' }> => entry.type === 'text')
    .map((entry) => entry.text).join('\n');
  return block.is_error ? { error: text } : { output: text };
}

function stableToolId(context: ProviderContext, messageIndex: number, blockIndex: number, name: string, input: JsonObject): string {
  const hash = createHash('sha256').update(JSON.stringify([context.session, context.agent, messageIndex, blockIndex, name, input])).digest('hex').slice(0, 24);
  return `toolu_google_${hash}`;
}

function mapFinishReason(reason: string | undefined, sawToolUse: boolean): Extract<CanonicalStreamEvent, { type: 'message_delta' }>['stop_reason'] {
  if (sawToolUse || reason === 'STOP' && sawToolUse) return 'tool_use';
  switch (reason) {
    case 'MAX_TOKENS': return 'max_tokens';
    case 'STOP_SEQUENCE': return 'stop_sequence';
    case 'SAFETY':
    case 'RECITATION': return 'content_filtered';
    default: return 'end_turn';
  }
}

const UNSUPPORTED_SCHEMA_KEYS = new Set(['$schema', '$id', 'default', 'examples', 'title', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'patternProperties', 'dependentRequired']);
function sanitiseSchema(schema: JsonObject, location: string): { schema: JsonObject; warnings: string[] } {
  const warnings: string[] = [];
  const sanitise = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((entry, index) => sanitise(entry, `${path}[${index}]`));
    if (!isRecord(value)) return value;
    const output: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(key)) {
        warnings.push(`Google Gemini does not support JSON Schema '${key}' at ${path}; it was omitted.`);
        continue;
      }
      output[key] = sanitise(child, `${path}.${key}`);
    }
    return output;
  };
  return { schema: sanitise(schema, location) as JsonObject, warnings };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'GoogleProviderError';
}

function safeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // API keys are never sent in URLs by this adapter and must not escape through an SDK error either.
  return text.replace(/(?:AIza|api[_-]?key[=:]\s*)[^\s'"&]+/gi, '[REDACTED]');
}
