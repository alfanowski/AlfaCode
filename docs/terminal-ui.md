# AlfaCode terminal UX

AlfaCode owns the complete terminal surface while the Claude Code engine remains headless underneath it. This is a native Ink application, not a Claude Code skin or plugin. Provider choices come from live descriptors: Google AI Studio, OpenCode Zen, Anthropic, custom endpoints, and compatible models.dev catalog providers.

## Trust boundary

The API key never enters a Claude prompt, transcript, skill, plugin, project setting, or command argument. A masked Ink input writes the value directly to the native macOS Keychain binding. Automated environments use an environment-variable reference stored in the non-secret AlfaCode config.

Interactive deletion requires a confirmation card and removes only the selected provider plus its AlfaCode-owned Keychain record. The compatibility CLI keeps credential deletion behind `--delete-keychain`.

## Interaction modes

| Environment | Behaviour |
| --- | --- |
| Interactive TTY | Native chat, searchable provider/model pickers, masked credentials, usage, permissions, tools, and subagent status. |
| `NO_COLOR` or `TERM=dumb` | Text-only output. No color carries meaning. |
| No TTY / CI | No prompts or Keychain setup. Use `connect --api-key-env NAME` then `run --non-interactive`. |

No color or symbol carries meaning alone. Ctrl-C before config writing leaves no partial config because writes are atomic.

## Engine boundary

The pinned Claude Code engine receives only a loopback gateway URL and a process-local, short-lived gateway token. AlfaCode renders SDK events itself. `/usage` combines live context occupancy with the local content-free provider ledger; it contains no credentials, prompts, or response bodies.

## Model discovery and pins

Discovery runs before each native session across every configured provider. `/model` searches the combined verified tool-capable catalog. `alfacode default <model-id>` writes an explicit pin; `alfacode default auto` returns control to automatic selection.

## Legacy import

`~/.polycode/config.json` is considered only when the new config is absent. AlfaCode copies validated non-secret provider metadata into `~/.alfacode/config.json`; references to the legacy Keychain service remain references to that service. This deliberately avoids reading or moving a secret value during migration.
