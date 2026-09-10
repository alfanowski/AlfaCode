# Thin launcher: real Claude Code TUI + multi-provider gateway

- Date: 2026-09-10
- Status: approved for planning
- Branch: `feat/thin-launcher`

## Context

AlfaCode today is a custom Ink/React TUI embedding `@anthropic-ai/claude-agent-sdk`
as its engine, with its own gateway translating Anthropic Messages API traffic to
Anthropic/Google/OpenAI/Zen providers. It works, but it can only ever approximate
Claude Code's real terminal UI, and every UI improvement Anthropic ships has to be
independently rebuilt here.

This session proved, empirically, that the real `claude` CLI binary — unmodified,
the same one already installed — can be redirected through a standalone instance
of AlfaCode's own gateway via environment variables alone:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:<gateway-port>
ANTHROPIC_AUTH_TOKEN=<gateway-token>
CLAUDE_CONFIG_DIR=<isolated dir>
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

Verified end-to-end with a real hosted model (`gemma4:31b` via Ollama Cloud):
`claude --print` accepted a gateway-encoded model id, round-tripped a real request
through the gateway to Ollama Cloud, and returned `"I am running as the gemma4:31b
model provided by ollama."` — proof the mechanism works, not just the theory.

Separately: OpenCode Zen's anonymous `"public"` free-tier key (`src/runtime.ts`,
the `anonymousZen` branch) is now blocked provider-side (`MissingSessionID` /
"OpenCode's free tier can only be used in OpenCode") — confirmed dead even against
the current production AlfaCode app, not just this session's PoCs. It was never a
leaked credential; it's a documented anonymous-tier sentinel, and the block is
Zen's own anti-abuse gate on that tier, unrelated to which model or client sends
the key.

## Goal

Build a launcher that starts a `claude` session backed by the real, unmodified
Claude Code TUI, with additional models available through AlfaCode's existing
gateway/provider stack — nothing more.

## Non-goals (v1)

- No custom TUI, no chat rendering, no in-app model palette beyond `/model`
  itself.
- No automatic model selection or failover between providers. `/model` picks
  manually; if a provider errors, the user switches by hand.
- No Anthropic-passthrough, Google, or generic-OpenAI-compatible providers
  wired into v1 — the code for them stays in the tree, unused, until a real
  need arises.

## v1 provider scope

- **ollama-local** — `localhost:11434`, zero config, auto-detected.
- **ollama-cloud** — `https://ollama.com/v1`, requires Andrea's own API key.
- **zen (OpenCode Go, real account)** — requires Andrea's own paid OpenCode Go
  API key (his call, his subscription; not provisioned by this work). Expected
  to bypass the anonymous-tier `MissingSessionID` block since that block is
  specific to the free/anonymous tier — to be confirmed empirically once a
  real key is available, not assumed.

## Architecture

```
alfacode [claude-args...]
  1. ConfigStore.read() -> configured providers (ollama-cloud, zen key refs)
  2. Probe localhost:11434 (short timeout) -> add ollama-local if reachable
  3. Resolve each configured provider's secret via SecretResolver;
     on failure, warn on stderr and skip that provider (never block launch)
  4. If zero providers ended up available -> skip the gateway entirely,
     exec the real `claude` unmodified (bare install behaves exactly like
     plain Claude Code, no forced setup)
  5. Otherwise: start the gateway (loopback, ephemeral port + token),
     build the claude child-process environment, spawn `claude` with
     inherited stdio and the user's passthrough args
  6. On claude exit: stop the gateway, exit with claude's exit code
```

### Kept unmodified

`gateway.ts`, `provider-contract.ts`, `model-id.ts`, `providers/http.ts`,
`providers/foundation/*`, `providers/openai/*` (covers Ollama's
OpenAI-compatible wire protocol), `providers/zen/*`, `config.ts`, `secrets.ts`,
`claude-launcher.ts` (already built for exactly this), `models-dev-catalog.ts`
and `models-dev-runtime.ts` (still supply per-model capability/context-window
metadata independent of the removed selector).

### Trimmed

`runtime.ts` (`startRuntime`) loses the `AutomaticModelSelector`/pinned-model/
selected-model path — its job shrinks to: build the provider list, start the
gateway, return the address and token. No "selected model" return value.

`provider-descriptors.ts` loses the `allowsAnonymous`-driven wizard-flow
fields; it's repurposed as the small validation table the new `providers`
subcommands use to check a `<type>` argument and know which providers need a
key.

### Removed

`chat-tui.tsx`, `setup-tui.tsx`, `agent-session.ts`, all of `ui/*`,
`model-selection.ts`, `model-selection-state.ts`, `usage-ledger.ts`,
`terminal-ui.ts`, `notifications.ts`, `spellcheck.ts`, `session-history.ts`,
`transcript-export.ts`. Dependencies dropped: `ink`, `ink-testing-library`,
`react`, `@types/react`, `@anthropic-ai/claude-agent-sdk`, `marked`.

### New

`launcher.ts` — orchestrates the 6 steps above (mostly wiring already-existing
`runtime.ts` + `claude-launcher.ts` together). A `providers` command group
(`add`/`list`/`remove`) replacing `setup-tui.tsx`.

## CLI surface

- `alfacode [claude-args...]` — the launch flow above; with no args, interactive.
- `alfacode providers list` — non-secret metadata only (id, type, status).
- `alfacode providers add <type> [--id <id>]` — prompts for a key on stdin when
  the type needs one (ollama-cloud, zen); ollama-local needs nothing. Key never
  touches argv, goes straight to Keychain via the existing `secrets.ts`.
- `alfacode providers remove <id>` — deletes from config + Keychain.

## Error handling

- Any provider failing to initialize (bad/expired key, unreachable endpoint):
  warn on stderr, skip it, continue with whatever else is available. Same
  policy for all three v1 providers — no special-casing.
- Gateway fails to bind: hard fail before spawning `claude`, clear stderr
  message, non-zero exit.
- `claude` not found on `PATH`: clear error pointing at installing Claude Code
  (no longer bundled/embedded via the SDK dependency).
- Upstream provider errors (429/5xx): no automatic failover in v1; the error
  reaches `claude`'s own error rendering, already proven to translate cleanly
  through the gateway's Anthropic-error-envelope mapping.

## Testing

- **Unmodified, should still pass as-is**: `gateway.test.ts`, `providers/*.test.ts`,
  `config.test.ts`, `secrets.test.ts`, `engine-compatibility.test.ts`,
  `claude-launcher.test.ts`.
- **Updated**: `runtime.test.ts`, `providers/runtime-factory.test.ts` — trimmed
  to the simplified `startRuntime` contract (no selected-model return value).
- **Removed**: every TUI-only test file (`chat-tui*`, `setup-tui`, `theme`,
  `vim-mode`, `screen-reader*`, `status-bar`, `markdown`, `model-picker`,
  `usage-ledger`, `model-selection*`, `motion`, `mouse-select`,
  `input-editor`, `dropped-paths`, `clipboard-*`, `mentions`, `notifications`,
  `session-history`, `transcript-export`, `spellcheck`, `background-tasks-panel`,
  `todo-panel`, `tool-output`, `primitives`).
- **New**: round-trip tests for `providers add/list/remove` (same pattern as
  `config.test.ts`).

## Acceptance criteria (manual checklist)

1. Bare `alfacode`, no config, no Ollama running → behaves identically to
   plain `claude`.
2. Ollama local running with a pulled model → `/model` lists it, dispatch works.
3. Ollama Cloud configured (real key) → `/model` lists `gemma4:31b`, dispatch
   works (already proven this session against the standalone gateway).
4. Zen configured with a real OpenCode Go key → confirms `MissingSessionID`
   is gone with a paid account, `/model` lists the Zen catalog, dispatch works.
5. **A real Task-tool subagent** (`.claude/agents/*.md` with `model:` set to a
   gateway-encoded id) dispatched by the main conversation while the main
   conversation itself stays on an Anthropic model — this is the original goal
   this whole investigation started from, and none of this session's PoCs
   tested it (they only tested the main/`--print` model directly). Not
   optional for calling v1 done.

## Rollout

Work happens on `feat/thin-launcher`. PR against `main` when the acceptance
checklist passes — no direct push, per standing git workflow. The current
installed `~/.local/bin/alfacode` stays untouched until Andrea decides to
reinstall from this branch.

## Open follow-ups (explicitly out of scope for v1)

- Anthropic-passthrough, Google, and generic-OpenAI-compatible providers:
  code stays as-is, unused, until a real need shows up.
- Automatic model selection/failover: dropped for v1; revisit only if manual
  `/model` switching across 3 providers turns out to be annoying in practice.
