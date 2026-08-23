import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileGoogleStateStore, GoogleProvider, MemoryGoogleStateStore } from '../../../src/providers/google/index.js';
import type { GoogleGenerateParameters, GoogleGenerateResponse, GoogleSdkClient } from '../../../src/providers/google/types.js';

function asyncValues<T>(values: T[]): AsyncIterable<T> {
  return (async function* () { yield* values; })();
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

function client(options: { models?: Array<Record<string, unknown>>; streams?: GoogleGenerateResponse[][]; tokens?: number } = {}): { client: GoogleSdkClient; calls: GoogleGenerateParameters[] } {
  const calls: GoogleGenerateParameters[] = [];
  let streamIndex = 0;
  return {
    calls,
    client: {
      models: {
        list: async () => asyncValues(options.models ?? []),
        generateContentStream: async (params) => {
          calls.push(params);
          return asyncValues(options.streams?.[streamIndex++] ?? []);
        },
        countTokens: async () => ({ totalTokens: options.tokens ?? 0 }),
      },
    },
  };
}

const context = { session: 'session-a', agent: 'agent-a' };
const baseRequest = { model: 'gemini-3-flash', messages: [{ role: 'user' as const, content: 'hello' }] };

describe('GoogleProvider', () => {
  it('maps Anthropic history, image, tools and generation settings', async () => {
    const mock = client({ streams: [[]] });
    const provider = new GoogleProvider({ client: mock.client, stateStore: new MemoryGoogleStateStore() });
    await collect(provider.stream({
      ...baseRequest,
      system: [{ type: 'text', text: 'Be concise.' }],
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'describe this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      ] }],
      max_tokens: 44,
      temperature: 0.2,
      top_p: 0.7,
      top_k: 21,
      stop_sequences: ['END'],
      tools: [{ name: 'weather', description: 'Gets weather', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], default: {} } }],
      tool_choice: { type: 'tool', name: 'weather' },
    }, context));
    expect(mock.calls[0]).toMatchObject({
      config: { systemInstruction: { parts: [{ text: 'Be concise.' }] }, maxOutputTokens: 44, temperature: 0.2, topP: 0.7, topK: 21, stopSequences: ['END'], toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['weather'] } } },
      contents: [{ role: 'user', parts: [{ text: 'describe this' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] }],
    });
    expect(mock.calls[0]?.config?.tools?.[0]?.functionDeclarations[0]?.parametersJsonSchema).not.toHaveProperty('default');
  });

  it('replays thought signatures and function names for tool results', async () => {
    const mock = client({ streams: [
      [{
        candidates: [{
          content: { parts: [{ functionCall: { id: 'call-1', name: 'weather', args: { city: 'Rome' } }, thoughtSignature: 'opaque-signature' }] },
          finishReason: 'STOP',
        }],
      }],
      [],
    ] });
    const provider = new GoogleProvider({ client: mock.client, stateStore: new MemoryGoogleStateStore() });
    const first = await collect(provider.stream(baseRequest, context));
    expect(first).toContainEqual({ type: 'tool_use', id: 'call-1', name: 'weather', input: { city: 'Rome' } });
    await collect(provider.stream({ model: baseRequest.model, messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'weather', input: { city: 'Rome' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'sunny' }] },
    ] }, context));
    expect(mock.calls[1]?.contents).toEqual([
      { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'weather', args: { city: 'Rome' } }, thoughtSignature: 'opaque-signature' }] },
      { role: 'user', parts: [{ functionResponse: { id: 'call-1', name: 'weather', response: { result: 'sunny' } } }] },
    ]);
  });

  it('keeps parallel function calls and emits text, tool, usage and stop events', async () => {
    const mock = client({ streams: [[{
      candidates: [{ content: { parts: [
        { text: 'Checking. ' },
        { functionCall: { id: 'one', name: 'weather', args: { city: 'Rome' } }, thoughtSignature: 's1' },
        { functionCall: { id: 'two', name: 'weather', args: { city: 'Milan' } }, thoughtSignature: 's2' },
      ] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 },
    }]] });
    const provider = new GoogleProvider({ client: mock.client, stateStore: new MemoryGoogleStateStore() });
    expect(await collect(provider.stream(baseRequest, context))).toEqual([
      { type: 'text_delta', text: 'Checking. ' },
      { type: 'tool_use', id: 'one', name: 'weather', input: { city: 'Rome' } },
      { type: 'tool_use', id: 'two', name: 'weather', input: { city: 'Milan' } },
      { type: 'usage', input_tokens: 8, output_tokens: 3 },
      { type: 'message_delta', stop_reason: 'tool_use' },
    ]);
  });

  it('generates deterministic ids for an upstream function call without one', async () => {
    const make = () => client({ streams: [[{ candidates: [{ content: { parts: [{ functionCall: { name: 'weather', args: { city: 'Rome' } } }] } }] }]] });
    const a = make(); const b = make();
    const first = await collect(new GoogleProvider({ client: a.client, stateStore: new MemoryGoogleStateStore() }).stream(baseRequest, context));
    const second = await collect(new GoogleProvider({ client: b.client, stateStore: new MemoryGoogleStateStore() }).stream(baseRequest, context));
    expect(first[0]).toEqual(second[0]);
  });

  it('does not collapse identical parallel calls with missing upstream ids', async () => {
    const mock = client({ streams: [[{ candidates: [{ content: { parts: [
      { functionCall: { name: 'weather', args: { city: 'Rome' } } },
      { functionCall: { name: 'weather', args: { city: 'Rome' } } },
    ] } }] }]] });
    const events = await collect(new GoogleProvider({ client: mock.client, stateStore: new MemoryGoogleStateStore() }).stream(baseRequest, context));
    const toolEvents = events.filter((event) => event.type === 'tool_use');
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]?.id).not.toBe(toolEvents[1]?.id);
  });

  it('filters model pages and maps model metadata', async () => {
    const mock = client({ models: [
      { name: 'models/gemini-good', displayName: 'Good', inputTokenLimit: 1000, outputTokenLimit: 100, supportedActions: ['generateContent'] },
      { name: 'models/embed', supportedActions: ['embedContent'] },
      { name: 'models/also-good', supportedActions: ['generate_content'] },
    ] });
    const provider = new GoogleProvider({ client: mock.client, stateStore: new MemoryGoogleStateStore() });
    expect(await provider.listModels()).toEqual([
      { id: 'gemini-good', displayName: 'Good', contextWindow: 1000, maxOutputTokens: 100 },
      { id: 'also-good', displayName: 'models/also-good' },
    ]);
  });

  it('uses the SDK token counter and redacts accidental API keys from errors', async () => {
    const mock = client({ streams: [], tokens: 17 });
    const provider = new GoogleProvider({ client: mock.client, stateStore: new MemoryGoogleStateStore() });
    expect(await provider.countTokens(baseRequest, 'gemini-3-flash', context)).toBe(17);
    const errorClient = client({ streams: [] });
    errorClient.client.models.generateContentStream = async () => { throw new Error('request failed key=AIzaSecretValue'); };
    const errors = await collect(new GoogleProvider({ client: errorClient.client, stateStore: new MemoryGoogleStateStore() }).stream(baseRequest, context));
    expect(errors).toEqual([{ type: 'error', error: { type: 'Error', message: 'request failed key=[REDACTED]' } }]);
  });

  it('persists state with atomic valid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'polycode-google-'));
    const path = join(dir, 'state.json');
    const store = new FileGoogleStateStore(path);
    await Promise.all([
      store.put('s', 'a', 'one', { id: 'one', name: 'first', thoughtSignature: 'sig-1' }),
      store.put('s', 'a', 'two', { id: 'two', name: 'second', thoughtSignature: 'sig-2' }),
    ]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toBeTypeOf('object');
    expect(await store.get('s', 'a', 'one')).toEqual({ id: 'one', name: 'first', thoughtSignature: 'sig-1' });
    expect(await store.get('s', 'a', 'two')).toEqual({ id: 'two', name: 'second', thoughtSignature: 'sig-2' });
  });
});
