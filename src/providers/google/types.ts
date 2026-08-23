export type JsonObject = Record<string, unknown>;

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id?: string; name: string; input: JsonObject }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_result'; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: JsonObject;
}

export interface AnthropicRequest {
  model: string;
  system?: string | Array<{ type: 'text'; text: string }>;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
}

export interface ProviderContext {
  signal?: AbortSignal;
  session: string;
  agent: string;
}

export type CanonicalStreamEvent =
  | { type: 'warning'; message: string }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonObject }
  | { type: 'message_delta'; stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'content_filtered' }
  | {
      type: 'usage'; input_tokens: number; output_tokens: number;
      cached_input_tokens?: number; cache_write_tokens?: number;
      reasoning_tokens?: number; tool_tokens?: number; total_tokens?: number;
    }
  | { type: 'error'; error: { type: string; message: string } };

export interface ProviderModel {
  id: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface GoogleSdkClient {
  models: {
    list(params?: unknown): Promise<AsyncIterable<GoogleModel> | GooglePager<GoogleModel>>;
    generateContentStream(params: GoogleGenerateParameters): Promise<AsyncIterable<GoogleGenerateResponse>>;
    countTokens(params: GoogleCountTokensParameters): Promise<{ totalTokens?: number }>;
  };
}

export interface GooglePager<T> extends AsyncIterable<T> {
  page?: T[];
  hasNextPage?: () => boolean;
  nextPage?: () => Promise<T[]>;
}

export interface GoogleModel {
  name?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedActions?: string[];
}

export interface GooglePart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name?: string; args?: JsonObject };
  functionResponse?: { id?: string; name?: string; response?: JsonObject };
  thought?: boolean;
  thoughtSignature?: string;
}

export interface GoogleContent { role: 'user' | 'model'; parts: GooglePart[] }

export interface GoogleGenerateParameters {
  model: string;
  contents: GoogleContent[];
  config?: {
    abortSignal?: AbortSignal;
    systemInstruction?: { role: 'user'; parts: GooglePart[] };
    tools?: Array<{ functionDeclarations: Array<{ name: string; description?: string; parametersJsonSchema: JsonObject }> }>;
    toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] } };
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
  };
}

export interface GoogleCountTokensParameters {
  model: string;
  contents: GoogleContent[];
  config?: GoogleGenerateParameters['config'];
}

export interface GoogleGenerateResponse {
  candidates?: Array<{ content?: { parts?: GooglePart[] }; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
}
