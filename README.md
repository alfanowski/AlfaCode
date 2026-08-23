# AlfaCode

AlfaCode is an independent terminal coding agent with its own UI, provider manager, and multi-provider gateway. Its execution engine is the pinned Claude Agent SDK/Claude Code runtime, so tools, permissions, sessions, subagents, skills, and project settings retain Claude Code semantics without reusing Claude Code's terminal UI.

```text
AlfaCode TUI -> pinned Claude Code engine -> local gateway -> any configured provider
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
- Aggregate every configured provider in AlfaCode's live `/model` picker.
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
- macOS for native Keychain-backed interactive credential storage

```bash
pnpm install
pnpm check
pnpm build
pnpm smoke:claude
```

For this checkout, install a local `alfacode` launcher in a directory already on `PATH`, pointing it at `dist/cli.js`. A packaged installer is intentionally deferred until the release scope is final.

## Configure and launch

On first launch, AlfaCode opens its own provider screen. Credentials are entered in a masked TUI field, saved directly to macOS Keychain, verified, and never sent through a model prompt or transcript. After setup, `alfacode` opens the native AlfaCode chat UI. `/connect`, `/providers`, `/model`, `/usage`, `/agents`, and `/permissions` all stay inside that UI.

OpenCode Zen supports two clearly separated connection modes:

- **Free public models**: no account, billing setup, or API key. AlfaCode uses Zen's public access token and admits only currently listed free models with verified protocol and tool metadata.
- **Zen API key**: optional account-scoped catalog and billing limits controlled by OpenCode.

All configured providers are active simultaneously. Automatic selection ranks the combined live catalog, records failures and usage locally, and can fail over to another model/provider before output begins. “Preferred provider” only controls an explicit persisted pin; it does not disable the others.

Configure a Google provider explicitly using the macOS Keychain prompt:

```bash
alfacode connect google --id google-personal
```

With no credential flag, `alfacode connect` opens the same native connection flow used by `/connect`. Add, reconnect, select, or delete providers from `/providers`; deleting requires confirmation and also removes AlfaCode's matching Keychain record. The key is never written to AlfaCode or Claude configuration and never enters a model transcript. `--id` accepts only a local label; values that look like credentials are rejected before anything is stored.

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
alfacode connect zen                            # choose public access or an API key in the TUI
alfacode connect anthropic --id anthropic --api-key-env ANTHROPIC_API_KEY
alfacode connect openai-compatible --id local --base-url http://127.0.0.1:4000/v1 --api-key-env LOCAL_API_KEY
```

`/model` and `alfacode models` display the dynamically discovered catalog; no model ID is bundled or hardcoded. Automatic selection first uses provider-reported normalized remaining capacity when it exists, then proven compatibility, rolling local usage, failures, and fair scheduling. A 404 removes a model from consideration. A 429 or retryable 5xx applies a cooldown and transparently tries the next eligible model before any response content is emitted. Google AI Studio does not expose exact remaining RPM/TPM/RPD through its model API, so AlfaCode deliberately reports that quota as unknown instead of inventing a number.

`alfacode` starts the native UI. `alfacode launch` is an explicitly named compatibility escape hatch that opens Anthropic's original terminal UI against the same gateway. `alfacode run` is the non-interactive compatibility alias; use `--` before Claude flags that could otherwise be interpreted by AlfaCode.

### Configuration migration

If `~/.alfacode/config.json` does not exist, the first AlfaCode command imports compatible metadata from `~/.polycode/config.json`. This migration is non-destructive: it leaves the legacy file untouched and preserves Keychain references such as `service: polycode` without retrieving, copying, or writing secret bytes. Reconnect a provider later if you want a new `alfacode` Keychain item.

Configuration directories and files are owner-only (`0700`/`0600`), written atomically, and rejected when symlinked or group/world-readable.

### Terminal behavior

The native Ink UI uses a restrained cyan/magenta AlfaCode palette, keyboard navigation, searchable models, masked secret entry, explicit permission cards, live tool/subagent events, and a local content-free usage view. Interactive setup refuses to run outside a TTY; CI keeps the environment-variable workflow.

Launch the isolated runtime:

```bash
alfacode
alfacode -- --model alfacode-anthropic/google-personal/<model-id>
```

Inside the session, `/model` shows only currently callable, tool-capable models discovered from all configured providers.
Use `alfacode default <model-id>` to persist a manual AlfaCode pin, or `alfacode default auto` to return to automatic selection.

AlfaCode appends an authoritative runtime identity with the actual provider and model to every request, including requests retried through automatic failover.

The Agent SDK and embedded Claude Code binary are exact-pinned together. A normal global `claude` update therefore cannot silently change AlfaCode. AlfaCode upgrades the pin only after its compatibility suite passes; an unexpected engine version is surfaced in the UI instead of being accepted implicitly.

## Data and cost warning

Requests contain repository context and are sent to the selected provider. Verify employer and client policy before using external models on work repositories. AlfaCode does not enable billing, but it cannot guarantee that a provider project is unbilled; provider-side billing and quota configuration remains authoritative. `alfacode usage` reads local privacy-preserving token accounting, not a provider billing invoice.

## License

AlfaCode's original source code is licensed under the MIT License. Anthropic's
Claude Code and Claude Agent SDK are proprietary software and are not licensed
under AlfaCode's MIT License. They remain governed by Anthropic's applicable
terms. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
