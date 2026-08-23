# AlfaCode

AlfaCode runs the real Claude Code runtime as a separate, isolated command while routing model requests through a local multi-provider gateway.

```text
alfacode -> local Anthropic-compatible gateway -> configured AI provider
```

The normal `claude` command and its configuration are left untouched. AlfaCode uses its own Claude config directory, session history, model cache, provider credentials, and gateway process.

> [!WARNING]
> AlfaCode is experimental and not affiliated with or supported by Anthropic. Anthropic does not support routing Claude Code to non-Claude models. Claude Code or provider API updates may require compatibility fixes.

## Goals

- Launch a fully isolated Claude Code instance with `alfacode`.
- Populate Claude Code's `/model` picker from every configured provider.
- Preserve tool calls, tool results, streaming, usage, and provider reasoning state.
- Keep provider credentials outside project files and Claude settings.
- Fail visibly when a provider cannot represent a requested capability.

## Initial provider support

- Google AI Studio / Gemini native API: first-class adapter.
- Additional adapters: planned behind the same provider contract.

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

On first interactive launch, AlfaCode runs a small outer-terminal wizard. It selects a provider, invokes macOS Keychain for the API key, offers a model picker, and only then starts the real Claude Code TUI. The API key is never collected through a Claude prompt, transcript, plugin, or project configuration.

Configure a Google provider explicitly using the macOS Keychain prompt:

```bash
alfacode connect google --id google-personal
```

With no credential flag, AlfaCode asks macOS Keychain to read the API key securely from the terminal. The key is never written to AlfaCode or Claude configuration.

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
alfacode usage [--json]                                  # placeholder until a local ledger ships
alfacode doctor [--json]
```

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

Inside the session, `/model` shows models discovered from configured providers.
Press `d` on a model in Claude Code's picker to make it the default for future AlfaCode sessions; the choice is stored only under `~/.alfacode/claude`.

## Data and cost warning

Requests contain repository context and are sent to the selected provider. Verify employer and client policy before using external models on work repositories. AlfaCode does not enable billing, but it cannot guarantee that a provider project is unbilled; provider-side billing and quota configuration remains authoritative.

## License

MIT.
