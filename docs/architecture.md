# Architecture

## Runtime topology

`alfacode` is a thin launcher: it never renders its own UI or embeds an
inference engine. It decides whether a gateway is needed, then execs the
real, unmodified `claude` binary and lets it render its own terminal UI.

```text
alfacode CLI
  ├─ loads non-secret provider configuration
  ├─ probes localhost:11434 for a zero-config local Ollama
  ├─ resolves credentials from the OS keychain or environment
  ├─ if no provider resolves any usable model: exec `claude` with the
  │    parent environment untouched (bare passthrough — see below)
  └─ otherwise: starts a loopback-only gateway on an ephemeral port,
       then execs `claude` with
       ├─ CLAUDE_CONFIG_DIR=~/.alfacode/claude
       ├─ ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
       ├─ ANTHROPIC_AUTH_TOKEN=<ephemeral token>
       └─ CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

In gateway mode, `claude` sends Anthropic Messages API traffic to that single
loopback endpoint, and the gateway aggregates the model catalogs of every
configured (and auto-detected) provider behind it. Model choice is entirely
`claude`'s own `/model` — alfacode does not rank, pin, or fail over between
models or providers.

In passthrough mode (no provider resolved any usable model), `buildClaudeEnvironment`
returns the parent process environment untouched, plus any caller-supplied
`extraEnv`: no isolated `CLAUDE_CONFIG_DIR`, no credential/proxy scrubbing, no
gateway env vars. Bare `alfacode` with nothing configured, or with a
configured provider that turned out to have zero usable models, behaves
identically to running `claude` directly.

## Dynamic catalog

- Provider-owned account catalogs are authoritative for additions and removals.
- AlfaCode verifies availability with non-inference endpoints before routing.
- models.dev supplies refreshable protocol/capability metadata, never credentials.
- AlfaCode never parses a model ID, version, display name, or catalog position to guess a protocol or a default model. There is no automatic selection or failover between providers; `claude`'s own `/model` picks manually, and a failing model or provider is worked around by switching models by hand.
- The context limit `claude` sees for a model comes from that model's own catalog entry, reported by the gateway's `/v1/models`.

## Model identifiers

Claude Code currently retains discovered gateway models only when their ID contains `claude` or `anthropic`. AlfaCode therefore exposes stable routing IDs:

```text
alfacode-anthropic/<provider-id>/<upstream-model-id>
```

The prefix is a compatibility marker, not a claim that the upstream model is an Anthropic model. The model picker uses a provider-qualified display name.

## Components

### Launcher (`src/cli.ts`, `src/claude-launcher.ts`)

- `classicLaunch` loads configuration, probes for a local Ollama, and decides whether a gateway is needed.
- In gateway mode, the child process gets only a process-local environment override: an isolated `CLAUDE_CONFIG_DIR` keeps AlfaCode's own sessions and settings separate from the user's normal Claude Code state, and inherited provider-selection, API-key, and proxy variables are scrubbed so `claude` cannot silently fall back to the user's own credentials instead of the gateway's.
- In passthrough mode, none of the above applies — see Runtime topology.
- `claude` is spawned with inherited stdio; alfacode forwards nothing else and renders nothing itself. The gateway stops when `claude` exits, and alfacode exits with `claude`'s own exit code.

### Gateway

- Binds only to `127.0.0.1` on an ephemeral port.
- Requires a high-entropy per-process credential.
- Implements `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, and `/api/hello`.
- Streams Anthropic SSE events without buffering a complete response.
- Propagates client cancellation (a non-streaming abort returns 499) and translates provider errors into the Anthropic error envelope, with a `retry-after` header on 429. There is no retry or failover — a single failed request surfaces to `claude` as a translated error, once as `application/json` if it fails before any output, or as an `event: error` SSE frame if streaming output had already started.
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
- Refuse symlinked or incorrectly permissioned AlfaCode configuration files.
- Require HTTPS for non-local provider endpoints.
- Keep request and response body logging off unless explicitly enabled.
- Treat authentication bypass, credential exposure, unsafe stream retry, and global Claude mutation as release blockers.

## Compatibility strategy

Claude Code adds protocol capabilities over time. AlfaCode keeps request parsing forward-compatible, reports unsupported fields explicitly, and tests the installed Claude Code binary against a deterministic fake provider. A supported-version matrix is maintained once the first public release is cut.
