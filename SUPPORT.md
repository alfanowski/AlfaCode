# AlfaCode support

AlfaCode is alpha software maintained as an open-source personal project. There is no guaranteed response time or commercial support agreement.

## Where to ask

- **Setup or usage question:** use [GitHub Discussions](https://github.com/alfanowski/AlfaCode/discussions).
- **Reproducible AlfaCode bug:** open a [bug report](https://github.com/alfanowski/AlfaCode/issues/new?template=bug-report.yml).
- **Provider-specific tool or streaming failure:** open a [provider compatibility report](https://github.com/alfanowski/AlfaCode/issues/new?template=provider-compatibility.yml).
- **Feature proposal:** open a [feature request](https://github.com/alfanowski/AlfaCode/issues/new?template=feature-request.yml).
- **Security vulnerability:** follow [SECURITY.md](SECURITY.md) and use private vulnerability reporting.

Before reporting a problem, update to the latest `main`, rebuild with `./scripts/install.sh`, and run:

```bash
alfacode doctor
node --version
git -C /path/to/AlfaCode rev-parse --short HEAD
```

Include the operating system, terminal, provider type, redacted model identifier, expected behavior, actual behavior, and the smallest safe reproduction. Never include a real API key, private repository content, prompts, customer data, full environment dumps, or unredacted HTTP traffic.

Provider quota, billing, account access, availability, and retention questions belong to that provider's support channel. AlfaCode cannot change an upstream account limit.
