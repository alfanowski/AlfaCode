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
| OpenAI Responses | `OpenAIResponsesAdapter` | Streaming/tool continuation transport; contract coverage still grows |
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

- The catalog endpoint/API metadata selects the transport; there is no family or
  version-name fallback.

Explicit endpoint/API/NPM metadata is mandatory; AlfaCode never falls back to model-name heuristics. All Zen and
generic OpenAI-compatible presets are `best-effort` until their exact model
passes the contract suite. A matching API key does **not** imply protocol
compatibility.

## Integration

`createWireProvider` is the composable runtime boundary for catalog-defined
providers. A dynamic catalog supplies its base URL, secret, model descriptors,
and explicit wire protocol; it does not require a new runtime provider-type
case. Unrecognised protocols are represented as unavailable descriptors and
are never sent to a guessed adapter.

Runtime discovery calls the account-scoped `/models` endpoint for Anthropic and
OpenAI-compatible endpoints, with a short cache keyed by a one-way key digest.
The public catalog response is strictly validated; a prior validated entry is
used only as a bounded fallback. `modelMetadata` is the explicit enrichment
seam for dynamic metadata services. Until it proves a model tool-capable, a
callable model remains an `unknown` candidate and is not routed or selected.
Google follows the same rule after its non-inference `countTokens` probe.

Adapters accept injected `fetch` implementations. Unit and contract tests use
only local `Response`/`ReadableStream` mocks; no test requires a paid key or
performs inference.

## Contract tests

The provider test suite covers split SSE frames, native Anthropic tool blocks,
fragmented and parallel OpenAI Chat tool calls, abort propagation, credential
redaction, and Zen discovery/authentication failures. New wire families need
the same fixture coverage before a preset can be relabeled `contract-tested`.
