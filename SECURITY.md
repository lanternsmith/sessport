# Security Policy

sessport reads and writes local session files that can contain source code and secrets.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](../../security/advisories/new) instead of a public issue. You can expect a first response within 7 days.

## What sessport does to protect you

- Redacts common secrets (API keys, tokens, private keys, URL passwords, `*_SECRET=` style assignments) before writing converted sessions, exports or handoffs. Use `--no-redact` only when you are sure.
- Never overwrites an existing session file.
- Makes no network requests.

Redaction is best-effort. Review exported transcripts before sharing them publicly.
