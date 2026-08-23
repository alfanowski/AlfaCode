# AlfaCode terminal UX

AlfaCode owns the complete terminal surface while the Claude Code engine remains headless underneath it. This is a native Ink application, not a Claude Code skin or plugin. Provider choices come from live descriptors: Google AI Studio, OpenCode Zen, Anthropic, custom endpoints, and compatible models.dev catalog providers.

## Trust boundary

The API key never enters a Claude prompt, transcript, skill, plugin, project setting, or command argument. A masked Ink input writes the value directly to the native macOS Keychain binding. Automated environments use an environment-variable reference stored in the non-secret AlfaCode config.

Interactive deletion requires a confirmation card and removes only the selected provider plus its AlfaCode-owned Keychain record. The compatibility CLI keeps credential deletion behind `--delete-keychain`.

## Interaction modes

| Environment | Behaviour |
| --- | --- |
| Interactive TTY | Native chat, safe Markdown, `/` palette, contextual prompt suggestions, searchable provider/model pickers, masked credentials, usage, interactive questions, permissions, tools, and subagent status. |
| `NO_COLOR` or `TERM=dumb` | Text-only output. No color carries meaning. |
| No TTY / CI | No prompts or Keychain setup. Use `connect --api-key-env NAME` then `run --non-interactive`. |

No color or symbol carries meaning alone. Ctrl-C before config writing leaves no partial config because writes are atomic.

Motion is deliberately limited to status affordances such as thinking, connection verification, and running tools. It is disabled by `ALFACODE_REDUCED_MOTION=1`, `CI`, or `TERM=dumb`. The default dark/light palette is inferred from `COLORFGBG`; `ALFACODE_THEME=dark|light` provides an explicit override.

## Conversation surface

The composer supports cursor-aware insertion and deletion, Home/End, prompt history, bracketed paste, `Ctrl+U`, `Ctrl+K`, `Ctrl+W`, and `Shift+Enter` multiline input. Typing `/` opens a searchable palette that merges AlfaCode actions with the engine's dynamically reported commands and skills. When the engine emits a predicted next prompt after a turn, AlfaCode displays it as ghost text and accepts it with `Tab`.

The footer distinguishes approximate draft tokens (`~`) from exact context occupancy returned by the engine. Local usage refreshes after each completed turn without making a model request.

Assistant text is tokenized as GFM and rendered into Ink components rather than converted to HTML. Control sequences are stripped before rendering. Wide tables use terminal-aware column sizing and narrow tables fall back to stacked records.

`AskUserQuestion` is not treated as a generic permission prompt. AlfaCode renders all 1–4 questions, single or multiple selection, descriptions, safe Markdown previews, and the automatic free-text “Other” option. The final question-to-answer map is returned in `updatedInput.answers`, which preserves Claude Code's native tool lifecycle for main agents and subagents.

## Engine boundary

The pinned Claude Code engine receives only a loopback gateway URL and a process-local, short-lived gateway token. AlfaCode renders SDK events itself. `/usage` combines live context occupancy with the local content-free provider ledger; it contains no credentials, prompts, or response bodies.

## Model discovery and pins

Discovery runs before each native session across every configured provider. `/model` searches the combined verified tool-capable catalog. `alfacode default <model-id>` writes an explicit pin; `alfacode default auto` returns control to automatic selection.

## Legacy import

`~/.polycode/config.json` is considered only when the new config is absent. AlfaCode copies validated non-secret provider metadata into `~/.alfacode/config.json`; references to the legacy Keychain service remain references to that service. This deliberately avoids reading or moving a secret value during migration.
