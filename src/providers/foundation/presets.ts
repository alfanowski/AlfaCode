import type { ProviderPreset } from "./types.js";

/** Zen uses four non-interchangeable wire protocols behind one credential. */
export const ZEN_PRESETS: readonly ProviderPreset[] = [
  { id: "zen-responses", displayName: "OpenCode Zen (Responses)", wireProtocol: "openai-responses", baseUrl: "https://opencode.ai/zen/v1", authentication: "bearer", support: "best-effort" },
  { id: "zen-anthropic", displayName: "OpenCode Zen (Messages)", wireProtocol: "anthropic-messages", baseUrl: "https://opencode.ai/zen/v1", authentication: "x-api-key", support: "best-effort" },
  { id: "zen-google", displayName: "OpenCode Zen (Gemini)", wireProtocol: "gemini-generate-content", baseUrl: "https://opencode.ai/zen/v1", authentication: "x-api-key", support: "best-effort" },
  { id: "zen-chat", displayName: "OpenCode Zen (Chat Completions)", wireProtocol: "openai-chat", baseUrl: "https://opencode.ai/zen/v1", authentication: "bearer", support: "best-effort" },
];

/** Use this only for servers that explicitly advertise OpenAI Chat Completions compatibility. */
export const GENERIC_OPENAI_COMPATIBLE_PRESET: ProviderPreset = {
  id: "openai-compatible",
  displayName: "OpenAI-compatible",
  wireProtocol: "openai-chat",
  baseUrl: "",
  authentication: "bearer",
  support: "best-effort",
};
