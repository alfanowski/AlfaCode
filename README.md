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

Configure a Google provider using the macOS Keychain prompt:

```bash
alfacode provider add google --id google-personal
```

With no credential flag, AlfaCode asks macOS Keychain to read the API key securely from the terminal. The key is never written to AlfaCode or Claude configuration.

Or reference an existing environment variable without persisting the key:

```bash
alfacode provider add google --id google-personal --api-key-env GEMINI_API_KEY
```

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
