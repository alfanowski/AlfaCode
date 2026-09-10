# Legal and distribution boundary

This document records the project's distribution constraints. It is an
engineering policy, not legal advice.

## Public repository boundary

The public repository may contain AlfaCode's original source, tests,
documentation, lockfile, and references to external packages. It must not
contain:

- Anthropic binaries or extracted proprietary source;
- copied Claude Code UI code, assets, logos, or branding;
- provider credentials, OAuth tokens, session tokens, or private transcripts;
- claims of affiliation, endorsement, or official compatibility;
- a service that resells or intermediates model usage.

## Runtime boundary

AlfaCode spawns an unmodified `claude` binary published by Anthropic and may
configure the documented `ANTHROPIC_BASE_URL` gateway interface. AlfaCode owns
its gateway implementation; it does not implement its own terminal UI —
`claude` renders its own, unmodified.

Every user authenticates directly with a provider using credentials they own.
AlfaCode must never offer Claude.ai OAuth login, capture Claude.ai credentials,
or route consumer subscription credentials through `claude`.

## Branding

The product and command are named AlfaCode. Plain-text references to Claude
Code describe technical interoperability only. Anthropic names and logos must
not appear in AlfaCode's product name, logo, or presentation in a way that
implies sponsorship.

## Release checks

Before every public release:

1. Run secret scanning across the complete Git history.
2. Verify that Anthropic dependencies are not vendored into tracked files.
3. Review current Anthropic legal/compliance and trademark pages.
4. Review current provider terms and regional restrictions.
5. Verify all users bring their own credentials and usage is never resold.
6. Confirm the compatibility suite passes against the installed `claude` binary.

Relevant primary sources, checked on 2026-08-23:

- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/llm-gateway
- https://www.anthropic.com/legal/commercial-terms
- https://www.anthropic.com/legal/trademark-guidelines
- https://ai.google.dev/gemini-api/terms
- https://opencode.ai/legal/terms-of-service
