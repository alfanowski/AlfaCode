# Security policy

AlfaCode handles provider credentials, coding-agent tool calls, and repository context. Security reports must never contain real API keys, private source code, prompts, customer data, or other secrets.

## Supported versions

AlfaCode is currently alpha software and has not published a stable release line. Security fixes are applied to the latest commit on `main`; older commits are not supported.

## Reporting a vulnerability

Use [GitHub Private Vulnerability Reporting](https://github.com/alfanowski/AlfaCode/security/advisories/new). Do not open a public issue for a suspected vulnerability.

Include only the minimum information needed to reproduce the problem:

- affected commit or version;
- impact and attack preconditions;
- safe reproduction steps or a minimal proof of concept;
- suggested mitigation, if known.

Redact credentials, repository content, prompts, responses, environment dumps, and provider request bodies. If a secret was exposed while investigating, revoke it immediately before continuing.

You should receive an initial acknowledgement within seven days. Timelines for validation, remediation, and disclosure depend on severity and whether an upstream provider or runtime is involved. Please allow a reasonable remediation window before public disclosure.

## Security model

AlfaCode is designed around these invariants:

- the gateway listens only on loopback;
- each process uses an ephemeral high-entropy gateway credential;
- provider secrets are stored in macOS Keychain or resolved from explicitly named environment variables;
- config files store credential references, not secret bytes;
- prompts and responses are excluded from AlfaCode logs and usage records;
- provider cancellation is propagated and failover stops after response bytes are emitted;
- the normal Claude Code configuration directory is never mutated;
- local configuration is owner-only, atomically written, and rejected when symlinked or insecurely permissioned.

These controls do not prevent the selected model provider from receiving request content. Users remain responsible for provider access, account security, data-processing terms, and repository policy.

## Out of scope

- Provider-side outages, quota exhaustion, billing disputes, or account suspension.
- Vulnerabilities in an unmodified third-party dependency without an AlfaCode-specific exploit path.
- Reports that require access to the reporter's own unlocked machine or already-compromised account.
- Social engineering, spam, or denial-of-service testing against public provider services.
- Scanner output without a reproducible security impact.
