<div align="center">
  <img src="docs/assets/hero.svg" alt="AlfaCode multi-provider terminal coding agent" width="100%" />

  <p><strong>A polished, multi-provider AI coding agent for the terminal.</strong><br />
  Keep the Claude Code execution engine. Choose the models and providers.</p>

  <p>
    <a href="https://github.com/alfanowski/AlfaCode/actions/workflows/checks.yml"><img src="https://github.com/alfanowski/AlfaCode/actions/workflows/checks.yml/badge.svg" alt="Checks" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-4fd1c5" alt="MIT License" /></a>
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A524-5fa04e?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24 or newer" />
    <img src="https://img.shields.io/badge/status-alpha-8b5cf6" alt="Alpha status" />
  </p>
</div>

AlfaCode is a thin launcher for the real Claude Code CLI. It spawns the actual, unmodified `claude` binary — which renders its own native terminal UI — and, when a provider is configured (or a local Ollama is detected automatically), runs a small local gateway so `claude` can reach non-Anthropic models through its own `/model` picker. Tools, permissions, sessions, subagents, skills, and project settings are all `claude`'s own, unmodified.

```text
alfacode  →  spawns the real claude (its own TUI)  →  local gateway, if configured  →  your providers
```

With no provider available — nothing configured, and no local Ollama running — alfacode behaves identically to running `claude` directly: the child process gets your real environment untouched, including your normal Claude Code login and settings. Only when a gateway actually starts does alfacode point `claude` at an isolated `~/.alfacode/claude` config directory, so that session stays separate from your everyday Claude Code use. AlfaCode's own config file (`~/.alfacode/config.json`) stores only non-secret provider metadata and credential references, never secret bytes.

> [!IMPORTANT]
> AlfaCode is independent, alpha software. It is not affiliated with, endorsed by, or supported by Anthropic, OpenCode, Google, or any model provider. Compatibility with non-Claude models is implemented by AlfaCode and is not guaranteed by Anthropic.

## Why AlfaCode

| | What you get |
| --- | --- |
| **One coding agent, many providers** | Connect Google AI Studio, OpenCode Zen, Anthropic, OpenAI-compatible endpoints (including Ollama), and dynamically discovered compatible providers at the same time. |
| **No hardcoded model list** | Provider catalogs are refreshed at runtime. New models appear automatically; removed models stop being routed. |
| **Real tool calling** | Provider-native adapters preserve function calls, tool results, streaming, reasoning state, and continuation metadata instead of flattening everything into text. |
| **The real Claude Code TUI** | alfacode doesn't reimplement the terminal experience — it spawns the actual `claude` binary, so every UI feature it ships (Markdown, palettes, permission cards, `/model`, themes, and everything else) is already there, kept in sync by Anthropic. |
| **Credentials stay out of chat** | Keys are stored in macOS Keychain via its own secure prompt, or referenced through environment variables for automation — never typed into a chat transcript or command argument. |

## What alfacode actually does

- Loads your configured providers and probes `localhost:11434` for a zero-config local Ollama.
- If nothing is usable, execs `claude` directly and gets out of the way — bare `alfacode` behaves exactly like running `claude` yourself.
- Otherwise, starts a local gateway (loopback-only, ephemeral port and token) that aggregates every usable provider's model catalog, then execs `claude` pointed at it via `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`.
- From there you're in the real, unmodified Claude Code terminal UI. Use its own `/model` to pick any discovered model, including non-Anthropic ones served through the gateway.
- The gateway shuts down when `claude` exits, and alfacode exits with `claude`'s own exit code.

## Quick start

### Requirements

- **macOS** — the currently supported and tested interactive platform
- **Node.js 24 or newer** — check with `node --version`
- **pnpm 10 or newer** — check with `pnpm --version`
- **Git**

If pnpm is missing and Corepack is available:

```bash
corepack enable pnpm
```

### Install from source

AlfaCode is not published to npm yet. The repository installer builds the exact checkout and creates a small launcher in `~/.local/bin`; it does not use `sudo` or change your shell configuration.

```bash
git clone https://github.com/alfanowski/AlfaCode.git
cd AlfaCode
./scripts/install.sh
```

Then start it:

```bash
alfacode
```

If your shell cannot find the command, add the local bin directory to `PATH` once:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
exec zsh
```

> [!TIP]
> Prefer a different launcher directory? Run `./scripts/install.sh --bin-dir /your/directory`. AlfaCode will refuse to overwrite an unrelated command unless you explicitly add `--force`.

### First launch

A fresh install has no config file and needs none. Just run:

```bash
alfacode
```

With nothing configured, this launches the real `claude` exactly as if you had run `claude` yourself — no forced setup step. If a local Ollama daemon is reachable on `localhost:11434`, it's detected automatically and its models become available through `/model`, still with no configuration at all.

To add another provider:

```bash
alfacode connect <type> [--id <id>] [--api-key-env <name> | --keychain] [--base-url <url>]
```

The key is stored through the macOS Keychain's own secure prompt (or referenced from an environment variable for non-interactive use) — it never passes through argv or a chat transcript. `alfacode providers list` shows what's configured, and `alfacode providers remove <id>` deletes a provider's metadata (add `--delete-keychain` to also remove its Keychain item).

To use Google, create a key at [Google AI Studio](https://aistudio.google.com/apikey), then connect it directly: `alfacode connect google --keychain` (prompts securely) or `alfacode connect google --api-key-env GEMINI_API_KEY`. If a saved provider's credential later becomes invalid or unavailable, alfacode prints a warning at launch and continues without it — it never blocks the launch or forces reconfiguration.

## Providers

| Provider | Authentication | Discovery and transport |
| --- | --- | --- |
| **Google AI Studio** | API key | Native Gemini Generate Content adapter, live account discovery, availability probes, tool calls, and thought-signature replay. |
| **Ollama (local)** | None — auto-detected | `localhost:11434` is probed at every launch; if reachable, its models are added automatically through the OpenAI Chat Completions-compatible route. No `connect` step needed. |
| **Ollama (cloud) / other OpenAI-compatible endpoints** | Base URL and API key reference | `alfacode connect openai-compatible --base-url <url> --api-key-env <name>`. Dynamic `/models` discovery with OpenAI Chat Completions or Responses transport when capability metadata proves the route. |
| **OpenCode Zen** | Your own OpenCode Go API key | Live catalog with explicit per-model protocol metadata. The anonymous free tier no longer works — a real key is required. |
| **Anthropic** | API key | Native Anthropic Messages transport and account-scoped discovery. |
| **models.dev catalog connectors** | Provider-dependent | Provider and protocol metadata refreshed dynamically; no bundled model IDs or credentials. |

All configured providers remain active simultaneously and are merged into one catalog behind the gateway. `defaultProviderId` is recorded as informational metadata only; it does not influence routing — `claude`'s own `/model` picks the model for every request.

AlfaCode never guesses a protocol from a model name. Models with incomplete tool or transport metadata remain visible for diagnostics but are not silently auto-selected. A 429 or 5xx surfaces to `claude` as a translated error (with a `retry-after` header on 429); there is no automatic retry or failover between providers — switch models by hand with `/model` if one is failing.

> [!NOTE]
> Some providers do not expose exact remaining quota. For example, Google AI Studio's model API does not report remaining RPM/TPM/RPD. AlfaCode reports that capacity as unknown instead of inventing a percentage.

### Non-interactive configuration

Reference an environment variable when running in CI or when you do not want to store a key in Keychain:

```bash
export GEMINI_API_KEY="your-key"
alfacode connect google --id google-personal --api-key-env GEMINI_API_KEY
```

Additional examples:

```bash
# Ollama Cloud
alfacode connect openai-compatible --id ollama-cloud --base-url https://ollama.com/v1 --api-key-env OLLAMA_API_KEY

# OpenCode Zen, with your own OpenCode Go API key
alfacode connect zen --id opencode-go --api-key-env OPENCODE_GO_API_KEY

# Anthropic through an environment variable
alfacode connect anthropic --id anthropic-work --api-key-env ANTHROPIC_API_KEY

# A custom OpenAI-compatible endpoint
alfacode connect openai-compatible \
  --id local-gateway \
  --base-url http://127.0.0.1:4000/v1 \
  --api-key-env LOCAL_API_KEY
```

Everything alfacode doesn't recognize (or anything after `--`) is passed straight through to `claude` — its own `--print`/`-p`, `--continue`/`-c`, `--resume`/`-r`, and every other `claude` flag. Run `claude --help` for the full list:

```bash
alfacode -- -p "Run the test suite and explain any failures"
```

## Inside the real Claude Code TUI

Once alfacode hands off, you're using Claude Code's own interface — its own `/model`, `/agents`, `/mcp`, `/permissions`, `/compact`, `/vim`, `/clear`, `/help`, `/exit`, sessions, checkpoints, and everything else it ships. That's Anthropic's product to document, not alfacode's; run `claude --help` or see Anthropic's own Claude Code documentation for its commands and keybindings.

alfacode itself only adds two things on top: extra models available in `/model` when a gateway is running, and its own small set of subcommands (`connect`, `providers`, `models`, `doctor`) documented below.

## CLI reference

```text
alfacode [-- claude-args...]          Launch: spawns claude, with a gateway if any provider is usable
alfacode launch [-- claude-args...]   Same as running alfacode with no subcommand
alfacode connect [type]               Connect a provider (prompts interactively for anything missing)
alfacode providers list               List configured providers (non-secret metadata only)
alfacode providers remove <id>        Remove a provider's metadata (--delete-keychain to also drop its Keychain item)
alfacode models [provider] [--json]   Inspect the discovered catalog
alfacode doctor [--json]              Inspect configuration health
alfacode config path                  Print the active config path
```

Use `alfacode <command> --help` for alfacode's own subcommand flags. Everything else — including `claude`'s own `--print`/`-p`, `--continue`/`-c`, `--resume`/`-r`, and every other flag — is passed straight through unchanged; alfacode does not reinterpret or restrict them. `alfacode launch` is just an explicit alias for the default action; both spawn `claude`.

## Gateway model IDs

When a gateway is running, it exposes stable model IDs in this form:

```text
alfacode-anthropic/<provider-id>/<upstream-model-id>
```

The prefix is a Claude Code gateway compatibility marker — Claude Code only retains discovered models whose ID contains `claude` or `anthropic` — not a claim that the upstream model was made by Anthropic. `claude`'s own `/model` picker shows the real provider and model name; select and switch models there. AlfaCode does not rank, pin, or automatically choose a model for you.

## Security and privacy

- The gateway (when one is running) binds only to `127.0.0.1` on an ephemeral port.
- Every gateway gets a high-entropy ephemeral credential, generated fresh per launch.
- API keys are stored in macOS Keychain or read from explicitly named environment variables.
- Config files contain secret references, never secret bytes.
- AlfaCode does not log or record prompt or response bodies; conversation content flows only between `claude` and the selected provider.
- Configuration files are owner-only, atomically written, and rejected when insecurely permissioned or symlinked.
- AlfaCode never edits your normal Claude Code configuration directory. In passthrough mode (no gateway) it doesn't touch your environment at all beyond what you already have.

Requests still contain repository context and are sent to the selected provider. Verify employer, client, and data-processing policy before using external models on sensitive code. Provider-side pricing, billing, retention, regional restrictions, and acceptable-use terms remain authoritative.

### Local data

| Path | Purpose |
| --- | --- |
| `~/.alfacode/config.json` | Non-secret provider metadata (id, type, credential reference). |
| `~/.alfacode/claude/` | Isolated `claude` config directory, used only when a gateway is running — sessions, settings, and state kept separate from your normal `~/.claude`. |
| `~/.alfacode/catalog/` | Validated dynamic models.dev catalog cache. |
| `~/.alfacode/state/` | Provider continuation state (for example, Gemini tool-call state). |
| macOS Keychain service `alfacode` | Provider secret bytes stored via `connect` (or an environment variable reference instead). |

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Never put real keys, private source, prompts, or customer data in a public issue.

## Updating

alfacode spawns whatever `claude` binary is on `PATH` — there is no bundled or pinned engine version to fall behind. Updating your global Claude Code installation changes what alfacode launches immediately.

To update alfacode itself:

```bash
cd /path/to/AlfaCode
git pull --ff-only
./scripts/install.sh
```

## Uninstalling

From the cloned repository:

```bash
./scripts/uninstall.sh
```

The uninstaller removes only the launcher created by AlfaCode and deliberately keeps `~/.alfacode` and Keychain credentials to prevent accidental data loss. Run `alfacode providers remove <id> --delete-keychain` first if you also want a provider's Keychain item deleted.

## Troubleshooting

### `alfacode: command not found`

Confirm that `~/.local/bin` is on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
alfacode --help
```

### No dynamically discovered model is available

Run:

```bash
alfacode doctor
alfacode models
```

A model must be live and have verified text/tool metadata to be routable. Reconnect the provider (`alfacode connect <type> --id <id> ...`) if its credential changed.

### HTTP 429 or quota exhausted

This is an upstream quota or billing response, surfaced to `claude` as a translated error (with a `retry-after` hint on 429). AlfaCode does not retry or fail over automatically — it cannot create quota either way. Check the provider dashboard, wait for the reported retry window, switch models with `/model`, or connect another provider.

### Empty or malformed streaming response

This usually means an intermediary returned Server-Sent Events to a non-streaming retry, or the endpoint's advertised protocol does not match its wire format. Verify the base URL and protocol metadata; avoid model-name-based compatibility assumptions.

### A model answers but cannot use tools reliably

Visibility does not equal proven compatibility. Inspect `alfacode models`, switch to a model marked tool-capable, and include a redacted compatibility report when opening an issue. Never attach API keys or proprietary prompt contents.

## Development

```bash
git clone https://github.com/alfanowski/AlfaCode.git
cd AlfaCode
pnpm install --frozen-lockfile
pnpm check
pnpm smoke:claude
pnpm dev
```

Useful documentation:

- [Architecture](docs/architecture.md)
- [Provider foundation](docs/providers.md)
- [Research and design decisions](docs/research.md)
- [Legal and distribution notes](docs/legal-distribution.md)
- [Contributing](CONTRIBUTING.md)

Provider adapters are contract-tested with local fixtures; the standard test suite performs no paid inference. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Project status

AlfaCode is an alpha-stage personal project: the architecture and test suite are substantial, but the public compatibility matrix and packaged release channel are not final. Expect sharp edges in provider-specific streaming and tool behavior, and report reproducible failures through the issue templates.

## License and trademarks

AlfaCode's original source is available under the [MIT License](LICENSE).

Anthropic's Claude Code is proprietary third-party software and is not covered by AlfaCode's MIT License. Its use is governed by Anthropic's terms. Product and provider names are used only for factual compatibility descriptions. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [legal and distribution notes](docs/legal-distribution.md).

---

<div align="center">
  <strong>One terminal. The providers you choose.</strong><br />
  <sub>Built independently for developers who want model choice without giving up a serious coding-agent runtime.</sub>
</div>
