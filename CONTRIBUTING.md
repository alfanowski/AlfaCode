# Contributing to AlfaCode

Thanks for taking the time to improve AlfaCode. The project sits on a sensitive boundary between a coding-agent runtime, local credentials, and several incompatible model APIs, so correctness and explicit compatibility matter more than the number of providers or models listed.

## Before you start

- Search existing issues and discussions before opening a duplicate.
- Use an issue template for bugs, provider compatibility reports, and feature proposals.
- Keep security reports private. Follow [SECURITY.md](SECURITY.md).
- Do not include API keys, proprietary code, prompts, customer data, or unredacted request bodies.
- For a substantial design change, open a discussion before investing in a large implementation.

## Development setup

Requirements:

- macOS for the currently supported interactive Keychain workflow;
- Node.js 24 or newer;
- pnpm 10 or newer;
- Git.

```bash
git clone https://github.com/alfanowski/AlfaCode.git
cd AlfaCode
pnpm install --frozen-lockfile
pnpm check
```

Run the development CLI with:

```bash
pnpm dev
```

Run the deterministic embedded-engine smoke test with:

```bash
pnpm smoke:claude
```

The standard test suite uses local mocks and fixtures. It must not require a paid API call or a contributor credential.

## Branches and pull requests

1. Branch from the latest `main`.
2. Keep the branch focused on one coherent change.
3. Add or update tests for behavior changes.
4. Run `pnpm check` before pushing.
5. Complete the pull request template and describe user-visible behavior.
6. Keep generated output, logs, credentials, and local configuration out of the commit.

Use clear, imperative commit subjects. Do not add automated co-author trailers or signatures.

## Engineering expectations

### Provider work

A provider or protocol is not considered supported because it returns text once. New transport work must cover, where applicable:

- fragmented streaming frames;
- text and structured tool-call events;
- parallel function calls;
- tool-result continuation;
- provider-specific reasoning or signature state;
- cancellation and abort propagation;
- token accounting;
- authentication and error normalization;
- credential redaction;
- retry safety before and after the first response byte.

Never infer a wire protocol, capability, or default model from a model name. Discovery must come from a provider-owned catalog or refreshable structured metadata. Unknown capability must remain unknown.

### Terminal UI work

- Preserve keyboard-only operation.
- Test narrow and wide terminal layouts.
- Respect dark, light, reduced-motion, `CI`, and `TERM=dumb` environments.
- Never echo secret input.
- Keep selections and destructive actions explicit.
- Use structured engine contracts for permissions and questions; do not inject synthetic chat text as a substitute.

### Security invariants

- Keep the gateway loopback-only.
- Keep provider keys out of config files, URLs, arguments, logs, model IDs, and transcripts.
- Never mutate the user's normal Claude Code configuration.
- Never retry a different provider after response bytes have been emitted.
- Treat credential disclosure, authentication bypass, unsafe retry, and global configuration mutation as release blockers.

## Code style

- TypeScript is strict; keep it that way.
- Code, identifiers, comments, commits, and public documentation are written in English.
- Prefer small explicit interfaces at provider boundaries.
- Validate untrusted network and disk data.
- Preserve provider-native metadata instead of collapsing it into a lowest-common-denominator message format.
- Avoid hardcoded model IDs, model families, quotas, or release schedules.

## Documentation

Update the README or relevant file in `docs/` when a change affects setup, commands, provider support, security behavior, compatibility, or user-visible interaction. Claims in documentation must match a tested path in the repository.

## License

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE). Do not submit code copied from proprietary products or material you do not have the right to redistribute.
