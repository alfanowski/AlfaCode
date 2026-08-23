# Architecture

## Runtime topology

```text
polycode CLI
  ├─ loads non-secret provider configuration
  ├─ resolves credentials from the OS keychain or environment
  ├─ starts a loopback-only gateway on an ephemeral port
  └─ launches the real Claude Code binary
       ├─ CLAUDE_CONFIG_DIR=~/.polycode/claude
       ├─ ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
       ├─ ANTHROPIC_AUTH_TOKEN=<ephemeral token>
       └─ CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

Claude Code sends Anthropic Messages API traffic to a single endpoint. The gateway aggregates model catalogs and routes each inference request using the model ID selected in `/model`.

## Model identifiers

Claude Code currently retains discovered gateway models only when their ID contains `claude` or `anthropic`. Polycode therefore exposes stable routing IDs:

```text
polycode-anthropic/<provider-id>/<upstream-model-id>
```

The prefix is a compatibility marker, not a claim that the upstream model is an Anthropic model. The model picker uses a provider-qualified display name.

## Components

### Launcher

- Uses process-local environment overrides only.
- Keeps Polycode sessions and settings separate through `CLAUDE_CONFIG_DIR`.
- Scrubs inherited provider-selection and API-key variables from the child process.
- Forwards user arguments and signals to the real Claude Code process.
- Stops the gateway when the child exits.

### Gateway

- Binds only to `127.0.0.1` on an ephemeral port.
- Requires a high-entropy per-process credential.
- Implements `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, and `/api/hello`.
- Streams Anthropic SSE events without buffering a complete response.
- Propagates client cancellation and never retries after response bytes have been emitted.
- Logs request metadata only; prompts and responses are disabled by default.

### Provider contract

Every provider implements:

- model discovery;
- message streaming;
- token counting;
- capability reporting;
- error normalization;
- shutdown.

Provider-specific metadata must survive translation. A lowest-common-denominator message structure is insufficient for state such as Gemini thought signatures.

### Google adapter

The initial Google adapter uses the native Generate Content API. It maps:

- Anthropic system and message content to Gemini `Content` and `Part` objects;
- client tools to Gemini function declarations;
- `tool_use` and `tool_result` to function calls and responses;
- Gemini chunks to Anthropic content-block events;
- token usage and finish reasons to Anthropic message metadata.

Gemini thought signatures and synthetic function-call IDs are stored durably by Claude session and agent identity, then restored when Claude Code replays tool history.

## Security invariants

- Never bind a gateway to a non-loopback interface.
- Never place provider keys in model IDs, URLs, command arguments, logs, or Claude settings.
- Never mutate the normal Claude config directory.
- Refuse symlinked or incorrectly permissioned Polycode configuration files.
- Require HTTPS for non-local provider endpoints.
- Keep request and response body logging off unless explicitly enabled.
- Treat authentication bypass, credential exposure, unsafe stream retry, and global Claude mutation as release blockers.

## Compatibility strategy

Claude Code adds protocol capabilities over time. Polycode keeps request parsing forward-compatible, reports unsupported fields explicitly, and tests the installed Claude Code binary against a deterministic fake provider. A supported-version matrix is maintained once the first public release is cut.
