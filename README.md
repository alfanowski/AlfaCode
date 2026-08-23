# AlfaCode

AlfaCode runs the real Claude Code runtime as a separate, isolated command while routing model requests through a local multi-provider gateway.

```text
alfacode -> local Anthropic-compatible gateway -> configured AI provider
```

The normal `claude` command and its configuration are left untouched. AlfaCode uses its own Claude config directory, session history, model cache, provider credentials, and gateway process.

> [!WARNING]
> AlfaCode is an independent, experimental project. It is not affiliated with,
> endorsed by, or supported by Anthropic, OpenCode, Google, or any model
> provider. Claude Code, the Claude Agent SDK, and provider APIs remain subject
> to their respective owners' terms. Gateway compatibility with non-Claude
> models is not guaranteed by Anthropic.

## Goals

- Launch a fully isolated Claude Code instance with `alfacode`.
- Populate Claude Code's `/model` picker from every configured provider.
- Preserve tool calls, tool results, streaming, usage, and provider reasoning state.
- Keep provider credentials outside project files and Claude settings.
- Fail visibly when a provider cannot represent a requested capability.

## Provider support

- Google AI Studio: native Gemini Generate Content adapter, live account discovery, non-inference availability probes, tool/thought-signature replay.
- OpenCode Zen: live multi-protocol discovery; models without explicit wire metadata stay visible but are never guessed.
- Anthropic Messages, OpenAI Responses, and OpenAI Chat Completions compatible APIs.
- A models.dev-backed connector catalog, refreshed automatically, currently covering compatible providers without bundling model IDs.

AlfaCode contains no model allowlist, version table, name-family heuristic, or positional default. Provider catalogs are refreshed at runtime. Newly listed models appear automatically; removed or non-callable models disappear from the Claude picker. Account-visible models without verified text/tool metadata remain diagnostic entries in `alfacode models` but are not auto-selected.

## Development

Requirements:

- Node.js 24 or newer
- pnpm
- Claude Code installed as `claude`

```bash
pnpm install
pnpm check
pnpm build
pnpm smoke:claude
```

For this checkout, install a local `alfacode` launcher in a directory already on `PATH`, pointing it at `dist/cli.js`. A packaged installer is intentionally deferred until the release scope is final.

## Configure and launch

On first interactive launch, AlfaCode runs a small outer-terminal wizard. It selects a provider, invokes macOS Keychain for the API key, and then starts the real Claude Code TUI with automatic model selection. Pin a model later only when you need a stable override. The API key is never collected through a Claude prompt, transcript, plugin, or project configuration.

Configure a Google provider explicitly using the macOS Keychain prompt:

```bash
alfacode connect google --id google-personal
```

With no credential flag, AlfaCode opens its interactive provider picker, allocates a short local provider label automatically, and asks macOS Keychain to read the API key securely from the terminal. To add another provider later, exit the Claude runtime and run `alfacode connect` again. The key is never written to AlfaCode or Claude configuration and never enters a model transcript. `--id` accepts only a local label; values that look like credentials are rejected before anything is stored.

Or reference an existing environment variable without persisting the key:

```bash
alfacode connect google --id google-personal --api-key-env GEMINI_API_KEY
```

Non-interactive environments must use a secret reference rather than a prompt:

```bash
GEMINI_API_KEY=... alfacode connect google --id ci --api-key-env GEMINI_API_KEY
alfacode run --non-interactive -- -p "Run the test suite"
```

Useful outer CLI commands:

```text
alfacode providers list
alfacode providers default google-personal
alfacode providers remove google-personal                 # leaves the Keychain item intact
alfacode providers remove google-personal --delete-keychain
alfacode models [provider]
alfacode default [alfacode-anthropic/provider/model]
alfacode default auto
alfacode usage [--provider id] [--model id] [--json]
alfacode doctor [--json]
```

Provider choices are descriptor-driven rather than model-hardcoded:

```bash
alfacode connect google --id personal
alfacode connect zen --id zen --api-key-env OPENCODE_API_KEY
alfacode connect anthropic --id anthropic --api-key-env ANTHROPIC_API_KEY
alfacode connect openai-compatible --id local --base-url http://127.0.0.1:4000/v1 --api-key-env LOCAL_API_KEY
```

`alfacode models` displays live availability, advertised capabilities, quota state, and context/output headroom. Automatic selection first uses provider-reported normalized remaining capacity when it exists, then rolling local usage and fair scheduling. A 404 removes a model from consideration. A 429 applies the provider's precise `Retry-After` delay when available, otherwise a conservative fallback cooldown, and transparently tries the next eligible model before any response content is emitted. Google AI Studio does not expose exact remaining RPM/TPM/RPD through its model API, so AlfaCode deliberately reports that quota as unknown instead of inventing a number.

`alfacode` and `alfacode launch` pass subsequent Claude Code arguments through unchanged. `alfacode run` is the non-interactive alias; use `--` before Claude flags that could otherwise be interpreted by AlfaCode.

### Configuration migration

If `~/.alfacode/config.json` does not exist, the first AlfaCode command imports compatible metadata from `~/.polycode/config.json`. This migration is non-destructive: it leaves the legacy file untouched and preserves Keychain references such as `service: polycode` without retrieving, copying, or writing secret bytes. Reconnect a provider later if you want a new `alfacode` Keychain item.

Configuration directories and files are owner-only (`0700`/`0600`), written atomically, and rejected when symlinked or group/world-readable.

### Terminal behavior

The outer UI is deliberately conservative: it is line-oriented, supports `NO_COLOR` and `TERM=dumb`, and refuses interactive credential setup outside a TTY. This keeps setup usable over SSH, tmux, screen, basic terminals, and screen readers. It does not replace or alter Claude Code's own TUI.

Launch the isolated runtime:

```bash
alfacode
alfacode -- --model alfacode-anthropic/google-personal/<model-id>
```

Inside the session, `/model` shows only currently callable, tool-capable models discovered from configured providers.
Use `alfacode default <model-id>` to persist a manual AlfaCode pin, or `alfacode default auto` to return to automatic selection.

Claude Code may still print that a project `.claude/settings.json` model pin applies on restart. That message describes Claude's own project setting; AlfaCode's launch-time `ANTHROPIC_MODEL` has higher precedence and automatic selection is recalculated on the next AlfaCode launch. AlfaCode also appends an authoritative runtime identity with the actual provider and model to every request, including requests retried through automatic failover.

## Data and cost warning

Requests contain repository context and are sent to the selected provider. Verify employer and client policy before using external models on work repositories. AlfaCode does not enable billing, but it cannot guarantee that a provider project is unbilled; provider-side billing and quota configuration remains authoritative. `alfacode usage` reads local privacy-preserving token accounting, not a provider billing invoice.

## License

AlfaCode's original source code is licensed under the MIT License. Anthropic's
Claude Code and Claude Agent SDK are proprietary software and are not licensed
under AlfaCode's MIT License. They remain governed by Anthropic's applicable
terms. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
