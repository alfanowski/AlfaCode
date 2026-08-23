# AlfaCode outer terminal UX

AlfaCode owns provider configuration outside Claude Code. Its terminal UI is intentionally a small line-oriented wizard rather than an embedded Claude plugin or a custom TUI inside Claude Code. Provider choices come from descriptors: Google AI Studio, OpenCode Zen, Anthropic, and custom OpenAI-compatible endpoints.

## Trust boundary

The API key never enters a Claude prompt, transcript, skill, plugin, project setting, or command argument. On macOS, a Keychain-backed connection invokes `/usr/bin/security add-generic-password -w` with `-w` as the final argument so the system process prompts securely. Automated environments use an environment-variable reference stored in the non-secret AlfaCode config.

`providers remove` keeps credentials by default. `--delete-keychain` is an explicit, irreversible request and only applies to the referenced Keychain record.

## Interaction modes

| Environment | Behaviour |
| --- | --- |
| Interactive TTY | First-run onboarding can select a provider, choose a provider id, and ask Keychain for a key. Model selection remains automatic unless the user later pins one with `alfacode default`. |
| `NO_COLOR` or `TERM=dumb` | Text-only output. No color carries meaning. |
| No TTY / CI | No prompts or Keychain setup. Use `connect --api-key-env NAME` then `run --non-interactive`. |

The UI uses numbered selections and text prompts, not terminal cursor control, spinners, or emoji-only status. Ctrl-C before config writing leaves no partial config because writes are atomic.

## Claude Code boundary

AlfaCode does not inject provider forms, a usage dashboard, or secret management into Claude Code's TUI. Claude receives only a loopback gateway URL and a process-local, short-lived gateway token. The separate `usage` command queries the local content-free usage ledger; it reports token accounting without provider credentials, prompts, transcripts, or billing data.

## Model discovery and pins

Discovery is injected at the outer CLI boundary. A platform implementation can return model availability, advertised capabilities, quota state, and context/output headroom; AlfaCode renders every supplied field and does not contain a model allowlist. `alfacode default <model-id>` writes an explicit pin in AlfaCode metadata. `alfacode default auto` deletes that pin and returns control to the platform selector for later launches.

## Legacy import

`~/.polycode/config.json` is considered only when the new config is absent. AlfaCode copies validated non-secret provider metadata into `~/.alfacode/config.json`; references to the legacy Keychain service remain references to that service. This deliberately avoids reading or moving a secret value during migration.
