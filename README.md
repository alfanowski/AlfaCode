<div align="center">
  <img src="docs/assets/hero.svg" alt="AlfaCode multi-provider terminal coding agent" width="100%" />

  <p><strong>The real Claude Code terminal agent, with the model choice you want.</strong><br />
  AlfaCode doesn't replace Claude Code — it launches it, and quietly gives it more models to talk to.</p>

  <p>
    <a href="https://github.com/alfanowski/AlfaCode/actions/workflows/checks.yml"><img src="https://github.com/alfanowski/AlfaCode/actions/workflows/checks.yml/badge.svg" alt="Checks" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-4fd1c5" alt="MIT License" /></a>
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A524-5fa04e?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24 or newer" />
    <img src="https://img.shields.io/badge/status-alpha-8b5cf6" alt="Alpha status" />
  </p>
</div>

> [!IMPORTANT]
> AlfaCode is independent, alpha-stage personal software. It is not affiliated with, endorsed by, or supported by Anthropic, OpenCode, Google, Ollama, or any model provider. Compatibility with non-Claude models is implemented by AlfaCode and is not guaranteed by any of them. Read this whole document before using it on anything you care about.

## Table of contents

- [What AlfaCode is](#what-alfacode-is)
- [Why it exists](#why-it-exists)
- [How it actually works](#how-it-actually-works)
- [Requirements](#requirements)
- [Installing it](#installing-it)
- [Your first run](#your-first-run)
- [Connecting providers, one by one](#connecting-providers-one-by-one)
- [Using AlfaCode day to day](#using-alfacode-day-to-day)
- [Full CLI reference](#full-cli-reference)
- [Where everything lives, and how secrets are handled](#where-everything-lives-and-how-secrets-are-handled)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)
- [Known limitations, told straight](#known-limitations-told-straight)
- [Development and contributing](#development-and-contributing)
- [License and trademarks](#license-and-trademarks)

## What AlfaCode is

AlfaCode is a very small program with one job: it starts the **real, unmodified `claude` binary** — the actual Claude Code CLI you already know, with its own real terminal interface — and, if you've told it about other AI providers, it quietly hands `claude` a way to reach them too, right inside its own `/model` picker.

It is **not** a rewrite of Claude Code. It doesn't have its own chat window, its own rendering, or its own idea of what a "message" or a "tool call" looks like. All of that — sessions, permissions, subagents, skills, project settings, the whole interactive experience — is Claude Code's own, completely untouched. AlfaCode's entire job happens *before* you ever see a prompt: it looks at what providers you've configured, starts a tiny local relay if there's anything to relay to, and then gets out of the way.

If you've never configured anything, AlfaCode behaves exactly like typing `claude` yourself. There is nothing to learn, nothing to opt into, and nothing that changes your normal Claude Code experience — until you deliberately ask for more.

## Why it exists

Claude Code is very good at being an agentic coding tool, but it only talks to Anthropic's own models. Sometimes you want to point a task at a different model — because it's free, because it's better at one specific thing, because you already pay for it elsewhere, or just because you're curious what would happen if a sub-agent ran on DeepSeek instead of Claude.

The obvious bad way to do that is to fork Claude Code and try to keep up with every release forever. AlfaCode does the opposite: it changes **nothing** about Claude Code. It sits in front of it, translates traffic when needed, and disappears when it isn't. You always get Claude Code's real, current, fully-supported interface — AlfaCode is a small amount of plumbing in front of it, not a replacement for it.

## How it actually works

```text
you type: alfacode
              │
              ▼
   does any configured provider actually have a usable model right now?
              │
      ┌───────┴────────┐
      │ no              │ yes
      ▼                 ▼
 exec the real       start a tiny local HTTP server
 `claude`, with      (127.0.0.1, random port, random
 your normal,        per-launch token) that knows how
 untouched           to translate requests toward every
 environment         provider you've configured
      │                 │
      │                 ▼
      │           exec the real `claude`, pointed at
      │           that local server via two environment
      │           variables (ANTHROPIC_BASE_URL /
      │           ANTHROPIC_AUTH_TOKEN)
      │                 │
      └───────┬─────────┘
              ▼
   you're inside the real Claude Code terminal UI.
   `/model` now also lists whatever AlfaCode's little
   server discovered — pick anything, switch anytime.
```

A few things follow directly from this design, and they're worth understanding up front because they explain almost everything else in this document:

- **There is exactly one running mode, decided automatically at every launch.** You never choose "gateway mode" vs. "plain mode" yourself — AlfaCode checks whether anything is actually usable and picks for you, every single time you run it.
- **The local server is not a chat app.** It doesn't store conversations, doesn't render anything, and doesn't make decisions about which model to use. It only accepts one very specific kind of HTTP request (the same shape Claude Code always sends), figures out which real provider a request is meant for, forwards it, and streams the answer back untouched.
- **Model choice always happens inside Claude Code's own `/model`, never inside AlfaCode.** AlfaCode has no opinion about which model is "best" and will never auto-select one for you.
- **When nothing is configured, none of the above exists.** No server starts, no port opens, nothing is isolated — `claude` runs exactly as if you'd typed it yourself, using your real login and your real settings.

## Requirements

- **macOS.** This is the only platform AlfaCode is built and tested for right now.
- **[Claude Code](https://claude.com/claude-code) already installed and logged in**, reachable on your `PATH` as `claude`. AlfaCode does not install, bundle, or manage Claude Code in any way — it just runs whatever `claude` it finds. Check with:
  ```bash
  claude --version
  ```
- **Node.js 24 or newer.** Check with:
  ```bash
  node --version
  ```
  If you don't have it, install it from [nodejs.org](https://nodejs.org) or with a version manager like `nvm`/`fnm`/`mise`.
- **pnpm 10 or newer.** Check with:
  ```bash
  pnpm --version
  ```
  If you have Node but not pnpm, the easiest path is:
  ```bash
  corepack enable pnpm
  ```
- **Git**, to clone the repository (AlfaCode isn't published to npm yet, so this is the only way to install it today).

Optional, only if you plan to use the corresponding provider:

- **[Ollama](https://ollama.com/download)**, if you want a locally-running model available with zero configuration (see the [known limitations](#known-limitations-told-straight) section before you count on this one).
- An API key or account with whichever hosted provider you want to add (Google AI Studio, OpenCode Zen / OpenCode Go, Ollama Cloud, Anthropic directly, or any OpenAI-compatible endpoint).

## Installing it

Clone the repository and run the installer:

```bash
git clone https://github.com/alfanowski/AlfaCode.git
cd AlfaCode
./scripts/install.sh
```

Here is exactly what that script does, so nothing about it is a surprise:

1. Checks that your `node` is version 24 or newer, and fails clearly if it isn't.
2. Runs `pnpm install --frozen-lockfile` inside the cloned repository — this installs AlfaCode's own dependencies, not anything system-wide.
3. Builds AlfaCode with `pnpm build`, producing a compiled `dist/cli.js`.
4. Writes one small launcher script to `~/.local/bin/alfacode` — a shell wrapper that just runs `node` on that compiled file. It creates `~/.local/bin` if it doesn't already exist.

It never uses `sudo`, never touches system directories, never edits your shell configuration files, and never installs anything globally. If a file already exists at the target location and it wasn't created by a previous run of this same installer, it refuses to overwrite it — you'd need to pass `--force` explicitly to replace it.

Once it finishes, you should be able to run:

```bash
alfacode --help
```

### If the command isn't found

`~/.local/bin` needs to be on your shell's `PATH`. If `alfacode --help` says "command not found," add it once:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
exec zsh
```

(If you use bash instead of zsh, write to `~/.bash_profile` or `~/.bashrc` instead, and `exec bash` at the end.)

### Installing somewhere other than `~/.local/bin`

```bash
./scripts/install.sh --bin-dir /your/preferred/directory
```

### Skipping the build (only if you're actively developing AlfaCode itself)

```bash
./scripts/install.sh --skip-build
```

This assumes `dist/cli.js` already exists from a previous `pnpm build` and just (re)writes the launcher script — useful if you're iterating on the installer itself and don't want to rebuild every time.

## Your first run

Right after installing, with nothing configured yet, just run:

```bash
alfacode
```

Nothing special happens — and that's the point. AlfaCode checks whether it has anything to relay to, finds nothing, and hands off directly to the real `claude`. You'll see Claude Code's own interface, using your own real Claude Code login, exactly as if you had typed `claude` instead of `alfacode`. There's no setup wizard, no forced first-run flow, no account to create for AlfaCode itself — because AlfaCode itself doesn't have an account, a login, or a product to sign up for. It's plumbing, not a service.

If you have Ollama already installed and running in the background, AlfaCode will notice it automatically the moment you run `alfacode` — no command needed for that specific case. (Whether any of Ollama's models actually become *usable* through `/model` depends on a detail explained in [known limitations](#known-limitations-told-straight) — read that before you assume it "isn't working.")

To do anything more interesting than that, you need to connect at least one provider — the next section walks through each one.

## Connecting providers, one by one

Every provider is added with one command:

```bash
alfacode connect <type> [--id <name>] [--api-key-env <ENV_VAR> | --keychain] [--base-url <url>]
```

A few things are true for **every** provider you connect, no exceptions:

- Your API key never appears in your shell history, in a chat transcript, or as a command-line argument that other processes on your machine could read. It goes either into **macOS Keychain** (through its own secure system prompt — AlfaCode never sees or stores the raw key itself) or is read from an **environment variable you name explicitly** with `--api-key-env`, for scripting or CI use.
- `--id <name>` lets you give the provider a short label of your choosing (for example `--id work-google` or `--id personal-ollama`). If you don't set one, AlfaCode picks a reasonable default from the provider type.
- You can connect as many providers as you like, of as many types as you like, all at the same time. Nothing about connecting a second provider disturbs the first.
- If a stored credential later stops working (revoked key, expired trial, wrong quota), AlfaCode doesn't crash or block your launch — it prints a one-line warning and quietly continues with whatever providers still work.

Here is every provider type AlfaCode understands today, with copy-pasteable examples.

### Local Ollama — nothing to run

If [Ollama](https://ollama.com/download) is installed and its background service is running (`ollama serve`, which normally starts automatically when you open the Ollama app), AlfaCode detects it by itself on every launch — there is no `connect` command for this one at all, and nothing is ever written to AlfaCode's config file for it. It's genuinely zero-configuration.

```bash
ollama pull llama3.2      # if you haven't pulled anything yet
alfacode
```

**Read [known limitations](#known-limitations-told-straight) before relying on this** — as of this version, locally-run Ollama models are detected but not yet guaranteed to actually be selectable in `/model`, for reasons that have nothing to do with AlfaCode's own code.

### Ollama Cloud

Ollama also offers hosted, pay-as-you-go inference for models too large to run on your own machine ([ollama.com](https://ollama.com)). To use it, create an API key there, then connect it as a generic OpenAI-compatible endpoint:

```bash
alfacode connect openai-compatible \
  --id ollama-cloud \
  --base-url https://ollama.com/v1 \
  --api-key-env OLLAMA_API_KEY
```

(Set `OLLAMA_API_KEY` in your shell first, or drop `--api-key-env` and answer the interactive Keychain prompt instead.)

> [!TIP]
> AlfaCode also auto-generates a more specific connector for Ollama Cloud straight from its live model catalog (see the next section) — run `alfacode connect` with no arguments to see it listed by name, with per-model capability data already attached. Either path works; the generic one above is just simpler to write down.

### OpenCode Zen / OpenCode Go

[OpenCode Zen](https://opencode.ai) is a model marketplace behind a single API. AlfaCode can talk to it with your own **paid OpenCode Go** account (the historical free anonymous tier no longer works — OpenCode closed it — so a real account and key are required now):

```bash
alfacode connect zen --id opencode-go --api-key-env OPENCODE_GO_API_KEY
```

### Google AI Studio

Create a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey), then:

```bash
# Keychain prompt (recommended for everyday use)
alfacode connect google --keychain

# or, non-interactively
alfacode connect google --api-key-env GEMINI_API_KEY
```

### Anthropic, directly

If you have your own Anthropic Console API key (separate from your normal Claude Code login) and specifically want it routed through AlfaCode's gateway alongside other providers:

```bash
alfacode connect anthropic --id anthropic-direct --api-key-env ANTHROPIC_API_KEY
```

### Any other OpenAI-compatible endpoint

Plenty of services — self-hosted model servers, company-internal gateways, smaller inference providers — speak the same OpenAI Chat Completions wire format. Point AlfaCode at any of them:

```bash
alfacode connect openai-compatible \
  --id my-endpoint \
  --base-url https://your-endpoint.example/v1 \
  --api-key-env MY_ENDPOINT_KEY
```

The base URL must be a real `https://` address, or `http://` pointed at `localhost`/`127.0.0.1` — AlfaCode refuses anything else, on purpose, so a typo can't quietly send your API key to the wrong host.

### Every provider models.dev knows about

AlfaCode also reads the community-maintained [models.dev](https://models.dev) catalog at startup and turns every entry it recognizes into its own ready-to-use connector, automatically, with no code changes on AlfaCode's side ever required to "add support" for a new one. There are well over a hundred of these at any given time — see them all with:

```bash
alfacode connect
```

Run without a type, this drops you into an interactive picker (in a real terminal) listing every native provider above *and* every one of these dynamically-discovered ones by name, each already annotated with which of its models have verified tool-calling support. Pick one, and AlfaCode walks you through the rest.

### Checking what's connected

```bash
alfacode providers list
```

Prints every provider you've configured — its id, its type, and whether its key comes from Keychain or an environment variable. Never the key itself.

```bash
alfacode providers remove <id>
```

Removes a provider's configuration. Its Keychain entry (if any) is left alone unless you also pass `--delete-keychain`.

## Using AlfaCode day to day

Once you have at least one provider connected, `alfacode` behaves like `claude`, plus one extra thing: its `/model` list also includes every model AlfaCode discovered from your providers, right alongside the normal Anthropic ones. Switch models the exact same way you always would — Claude Code owns that whole experience, AlfaCode just adds entries to the list.

### Passing arguments straight through to `claude`

Anything AlfaCode doesn't recognize as its own — and anything after a bare `--` — goes straight to the real `claude` binary, unmodified:

```bash
alfacode -- -p "Run the test suite and explain any failures"
alfacode -- --continue
alfacode -- --resume
```

Run `claude --help` for the full list of Claude Code's own flags; AlfaCode doesn't reinterpret or restrict any of them.

### Routing a specific sub-agent to a specific model

This is the feature that makes multi-provider access actually *useful* rather than a novelty: because AlfaCode's gateway exposes every connected provider's models with stable IDs, you can pin one particular sub-agent definition to one particular non-Anthropic model, while your main conversation stays on whatever you're already using — all inside one normal Claude Code session.

Model IDs from AlfaCode's gateway look like this:

```text
alfacode-anthropic/<provider-id>/<upstream-model-id>
```

Run `alfacode models` to see the exact strings for whatever you've connected. Then, in any subagent definition (`.claude/agents/your-agent.md`), set:

```markdown
---
name: my-deepseek-reviewer
description: A code reviewer that runs on DeepSeek instead of Claude.
model: alfacode-anthropic/ollama-cloud/deepseek-v4-flash:0731
---

You are a meticulous code reviewer.
```

Dispatch a task to it the normal way (via Claude Code's Task tool, or by asking Claude to use that subagent), and it runs on the model you named — verified, live, end to end, as part of building this feature.

## Full CLI reference

```text
alfacode [-- claude-args...]          Launch: spawns claude, with a gateway if any provider is usable
alfacode launch [-- claude-args...]   Exact alias for the line above
alfacode connect [type]               Connect a provider (interactive picker if no type is given)
alfacode providers list               List configured providers (non-secret metadata only)
alfacode providers remove <id>        Remove a provider (add --delete-keychain to also drop its key)
alfacode models [provider] [--json]   List the discovered model catalog, optionally filtered
alfacode doctor [--json]              Print a health summary: config path, providers, status
alfacode config path                  Print the path to AlfaCode's own config file
```

Everything else you type after `alfacode` that isn't one of the words above is treated as arguments for the real `claude` and passed through exactly as given.

## Where everything lives, and how secrets are handled

| Path | What's there |
| --- | --- |
| `~/.alfacode/config.json` | Which providers you've connected: an id, a type, and a *reference* to where its credential lives (never the credential itself). Owner-only permissions, atomically written. |
| `~/.alfacode/claude/` | An isolated Claude Code config directory, used **only** during a real gateway launch — kept completely separate from your everyday `~/.claude`, so a provider experiment can never touch your normal sessions, settings, or login. Untouched, and unused, whenever AlfaCode runs in plain passthrough mode. |
| `~/.alfacode/catalog/` | A cached, validated copy of the models.dev catalog, refreshed automatically. |
| `~/.alfacode/state/` | Small bits of per-provider continuation state some adapters need (for example, Gemini's tool-call state across turns). |
| macOS Keychain, service `alfacode` | The actual secret bytes for any provider you connected with `--keychain`. |

Additional security properties, stated plainly:

- The local relay, when one is running, binds only to `127.0.0.1` — it is never reachable from your network, let alone the internet.
- It gets a brand-new random access token every single launch; nothing is reused between sessions.
- AlfaCode never logs or stores the content of your prompts or responses — that traffic only ever exists between `claude` and whichever provider you're talking to at that moment.
- In plain passthrough mode (nothing configured, or nothing usable), AlfaCode doesn't touch your environment or your Claude Code configuration *at all* — it is, deliberately, indistinguishable from running `claude` yourself.

None of this changes what leaves your machine once a request reaches a provider: your code, your prompts, and your project context are still sent to whichever provider you selected, subject to that provider's own policies. Check your employer's or client's data-handling rules before pointing sensitive work at a third-party model, the same as you would for any tool.

## Updating

AlfaCode always runs whatever `claude` binary is currently on your `PATH` — there's nothing bundled or pinned to fall out of date. Updating your normal Claude Code installation takes effect the very next time you run `alfacode`, with no extra step.

To update AlfaCode itself:

```bash
cd /path/to/AlfaCode
git pull --ff-only
./scripts/install.sh
```

## Uninstalling

```bash
cd /path/to/AlfaCode
./scripts/uninstall.sh
```

This removes only the small launcher script created by the installer. It deliberately leaves `~/.alfacode` (your provider configuration) and any Keychain entries in place, so a reinstall later doesn't lose anything. If you also want a specific provider's Keychain entry gone first, run `alfacode providers remove <id> --delete-keychain` before uninstalling.

## Troubleshooting

**`alfacode: command not found`**
`~/.local/bin` (or wherever you installed it) isn't on your `PATH`. See [If the command isn't found](#if-the-command-isnt-found) above.

**AlfaCode launches but I don't see any of my providers' models in `/model`**
Run `alfacode doctor` and `alfacode models` to see what AlfaCode actually discovered and why a given model may not be considered usable. A model has to be both *live* (the provider currently reports it) and have *verified* text and tool-calling support before it's routable — visibility in the list doesn't always mean it's usable yet.

**A provider I connected stopped working**
AlfaCode prints a warning and keeps going rather than blocking your launch. Reconnect it with `alfacode connect <type> --id <same-id> ...` using a fresh credential.

**HTTP 429, or "quota exceeded"**
That's the provider itself telling you you're rate-limited or out of quota — AlfaCode has no quota of its own to give you, and it does not automatically retry or fail over to a different provider. Wait for the window mentioned in the error, switch models with `/model`, or check that provider's own dashboard.

**A model responds but doesn't seem to use tools correctly**
Appearing in the list is not the same as being verified for tool use. Check `alfacode models` for that model's reported capabilities before trusting it with anything that depends on tool calls.

## Known limitations, told straight

This project is honest about what doesn't work yet, on purpose:

- **Locally-run Ollama models are detected, but most of them won't currently show up as usable.** AlfaCode only trusts a model with real tool-calling once an external catalog ([models.dev](https://models.dev)) has verified that capability for it — and that catalog only tracks **hosted** providers, including Ollama's own cloud service, not arbitrary models you've pulled onto your own machine. Practically, this means: the daemon is found, its models are listed, but none of them typically become selectable in `/model` today. Fixing this the right way means deciding whether AlfaCode should trust a locally-run model's *self-reported* capabilities instead of requiring third-party verification — a real security-and-reliability tradeoff, not yet made. Ollama Cloud (a hosted provider) does not have this problem.
- **No automatic model selection or failover.** If a provider fails, you switch models by hand with `/model`. AlfaCode will not silently retry your request against a different provider.
- **macOS only**, for now.
- **Alpha software.** Expect rough edges, especially around less common provider/model combinations. Please file reproducible issues rather than private reports where possible — see [SECURITY.md](SECURITY.md) specifically for anything sensitive.

## Development and contributing

```bash
git clone https://github.com/alfanowski/AlfaCode.git
cd AlfaCode
pnpm install --frozen-lockfile
pnpm check       # typecheck + test + build
pnpm dev         # run from source, no build step
```

Further reading:

- [Architecture](docs/architecture.md) — how the pieces fit together internally
- [Provider foundation](docs/providers.md) — how a new provider adapter is built
- [Research and design decisions](docs/research.md)
- [Legal and distribution notes](docs/legal-distribution.md)
- [Contributing guide](CONTRIBUTING.md) — please read this before opening a pull request
- [Security policy](SECURITY.md) — please read this before reporting a vulnerability

The test suite performs no paid inference; provider adapters are exercised against local fixtures.

## License and trademarks

AlfaCode's own source code is available under the [MIT License](LICENSE).

Claude Code is Anthropic's own product, not covered by AlfaCode's license, and governed entirely by Anthropic's own terms — AlfaCode just launches it. The same goes for every other provider named in this document: names are used only to describe factual compatibility, not to claim any affiliation or endorsement. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [legal and distribution notes](docs/legal-distribution.md) for the full detail.

---

<div align="center">
  <strong>One terminal you already know. The models you choose to add to it.</strong>
</div>
