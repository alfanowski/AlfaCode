# Security policy

Polycode handles provider credentials and repository content. Security reports should not contain real API keys, prompts, source code, or customer data.

## Defaults

- The gateway listens on loopback only.
- Every process uses an ephemeral gateway credential.
- Request and response bodies are not logged.
- Provider credentials are stored in the OS keychain or resolved from environment variables.
- The normal Claude Code configuration is not modified.

## Supported versions

No version is currently supported for production use. The project is pre-release.

## Reporting

Until a private reporting channel is published, do not open a public issue containing exploit details or sensitive data. Contact the repository owner privately.
