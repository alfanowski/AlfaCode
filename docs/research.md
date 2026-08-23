# Research and product decisions

Research snapshot: 2026-08-23. AlfaCode intentionally wraps the installed Claude Code executable; it does not copy or reimplement its terminal UX.

## Verified Claude Code contract

- Claude Code officially supports an Anthropic Messages gateway selected by `ANTHROPIC_BASE_URL`, while Anthropic explicitly does not support non-Claude models behind third-party gateways.
- The required inference endpoint is `POST /v1/messages`. `POST /v1/messages/count_tokens`, `HEAD /api/hello`, and `GET /v1/models?limit=1000` cover token counting, warm-up, and model discovery.
- Inference must be streamed as SSE. Silent streams time out after 300 seconds, so the gateway emits pings during upstream pauses.
- Discovery has a three-second deadline, follows no redirects, and accepts only IDs containing `claude` or `anthropic`. AlfaCode therefore prewarms model catalogs and uses `alfacode-anthropic/<provider>/<model>` routing IDs.
- `x-claude-code-session-id` and `x-claude-code-agent-id` provide the stable scope required for provider-side reasoning and tool metadata.
- `CLAUDE_CONFIG_DIR` relocates sessions, settings, plugins, and the discovered-model cache, allowing complete isolation from the normal `claude` command.

Primary references:

- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
- [Claude Code gateway overview](https://code.claude.com/docs/en/llm-gateway)

## Why a focused gateway instead of an existing universal proxy

Existing projects prove the route is viable: Claude Code Router and AnyClaude translate Claude Code traffic to several providers; LiteLLM exposes a broad proxy; OpenRouter exposes an Anthropic-compatible endpoint. They are useful references, but not the initial dependency boundary here.

The first release stays deliberately small and auditable:

- no daemon, dashboard, remote listener, telemetry, or provider-side account;
- no plaintext credentials in Claude settings;
- native provider adapters own lossy translation decisions;
- a deterministic smoke test runs the locally installed Claude Code binary;
- dependencies are pinned by a lockfile and reviewed as part of the release process.

This also avoids inheriting a large gateway supply chain. Anthropic currently warns that LiteLLM versions 1.82.7 and 1.82.8 were compromised; that does not make all broad gateways unsafe, but it makes dependency minimization a concrete requirement rather than aesthetic preference.

References:

- [Claude Code Router](https://github.com/musistudio/claude-code-router)
- [AnyClaude](https://github.com/coder/anyclaude)
- [OpenRouter Claude Code integration](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration)

## Google adapter decisions

The initial provider uses the official `@google/genai` SDK and the stateless Generate Content API. Claude Code already sends full history, so stateless translation is natural and does not require a remote conversation store.

Gemini thought signatures are the hard compatibility edge. Gemini 3 requires the signature from a function-call response to be replayed in the exact part on the next tool step; parallel calls carry the signature only on the first function call. AlfaCode persists that opaque metadata by Claude session, agent, and tool-call ID using atomic mode-0600 files.

References:

- [Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)

## Privacy and cost constraints

AlfaCode never enables billing and does not implement fallback routing that could silently select a paid provider. Costs and quotas remain controlled by each provider account.

Google's current terms distinguish unpaid and paid processing. In the EEA, Switzerland, and the UK, paid-service data terms apply even to unpaid quota; outside those regions, unpaid-service prompts and responses may be used for product improvement and reviewed by humans. Repository content must therefore never be sent until its employer/client policy permits that provider and account.

References:

- [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)

## Adapter roadmap

The provider boundary is intentionally independent of Fastify and the Google SDK. Planned adapters can be added without touching the launcher or model picker:

1. Anthropic-compatible upstreams: direct streaming pass-through with open header/body forwarding.
2. OpenAI Responses: preserve reasoning item identity and encrypted reasoning state, not just Chat Completions text.
3. Ollama: prefer its native Anthropic endpoint when available; use translation only for missing capabilities.
4. OpenAI-compatible providers: capability profiles for tools, images, JSON schema, reasoning, and token accounting.

Before adding automatic fallback or per-task routing, the runtime needs explicit cost policy, retry idempotency, session affinity, and provider capability negotiation. Silent fallback is rejected because it can leak repository context to a provider the user did not select and can create unexpected spend.
