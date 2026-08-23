# Provider foundation

AlfaCode separates a provider's commercial identity from its wire protocol.
The executable boundary is `src/providers/`; it deliberately does not read the
CLI configuration or any secrets itself.

## Protocol adapters

| Protocol | Adapter | Status |
| --- | --- | --- |
| Anthropic Messages | `AnthropicMessagesAdapter` | Contract-tested native pass-through |
| OpenAI Chat Completions | `OpenAIChatAdapter` | Contract-tested for SSE text/tool streams |
| Gemini Generate Content | `GoogleProvider` | Native adapter already integrated |
| OpenAI Responses | Foundation descriptor only | Not implemented in this milestone |
| Ollama native | Foundation descriptor only | Not implemented in this milestone |

The core API is `CapabilitySet`, `ModelDescriptor`, `ProtocolState`, and
`ProviderRegistry` from `src/providers/foundation`. A model descriptor selects
a wire protocol and capability profile; callers must reject or clearly warn on
capabilities that its selected model does not advertise.

`availability` is independent of discovery. In particular, `deprecated` and
`account-validation-required` models must never be chosen as an implicit
default. `selectDefaultModel` only picks an `available`, contract-tested model;
if none exists, root integration must require an explicit configured choice.

`ProtocolState` is for opaque provider continuation data only (for example,
reasoning signatures and emitted tool records). It must not be repurposed as a
prompt or request log. Gemini's existing state store is the first concrete
implementation of this requirement.

## OpenCode Zen

Zen catalog discovery is performed with `discoverZenModels`. It requests
`GET {baseUrl}/models` and sends the key only in `Authorization: Bearer`.
The endpoint must be queried before creating model-specific adapters because
Zen serves several incompatible protocols:

- Responses: `gpt`, `grok`, and `muse` families.
- Messages: `claude` and `qwen` families.
- Gemini: `gemini` family.
- Chat Completions: remaining compatible models.

Explicit endpoint/API/NPM metadata wins over name heuristics. All Zen and
generic OpenAI-compatible presets are `best-effort` until their exact model
passes the contract suite. A matching API key does **not** imply protocol
compatibility.

## Integration

Root runtime integration should construct an adapter with a resolved secret and
prewarmed `ModelDescriptor[]`, then register it via `ProviderRegistry` or pass
the resulting `Provider` to the existing gateway. It should not add provider
switches to `runtime.ts`.

Adapters accept injected `fetch` implementations. Unit and contract tests use
only local `Response`/`ReadableStream` mocks; no test requires a paid key or
performs inference.

## Contract tests

The provider test suite covers split SSE frames, native Anthropic tool blocks,
fragmented and parallel OpenAI Chat tool calls, abort propagation, credential
redaction, and Zen discovery/authentication failures. New wire families need
the same fixture coverage before a preset can be relabeled `contract-tested`.
