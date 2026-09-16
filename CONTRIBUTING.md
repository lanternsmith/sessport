# Contributing to sessport

Thanks for helping! The most valuable contributions are reports and fixes for **session format changes** in new CLI releases, and **adapters for more tools**.

## Setup

```bash
git clone https://github.com/lanternsmith/sessport
cd sessport
npm install
npm test          # unit tests with fixtures
npm run build
node dist/cli.js doctor
```

## Real-CLI compatibility check

`npm run e2e` converts the fixtures and resumes them with the real CLIs, using local mock model servers (no API keys, no network). It skips any tool that is not installed.

```bash
npm install -g @openai/codex @anthropic-ai/claude-code
npm install --no-save @google/gemini-cli-core
npm run build && npm run e2e
```

## Fixing a format change

1. Add the new record shapes to the fixture under `test/fixtures/<tool>-home/` (synthetic content only — never commit real transcripts).
2. Update the adapter in `src/adapters/<tool>.ts` and keep older formats readable.
3. Update `docs/formats.md` and note the tool version.
4. Run `npm run typecheck && npm test` and, if possible, `npm run e2e`.

## Adding a tool

Implement the `Adapter` interface from `src/model.ts` (`list`, `read`, `write`), register it in `src/adapters/index.ts`, add fixtures and tests, and document the format. Reading support alone is a welcome first PR.

## Style

- TypeScript, strict mode, no runtime dependencies.
- Keep parsers tolerant: skip unknown records instead of throwing.
- Add a line under **Unreleased** in `CHANGELOG.md`.

By contributing you agree that your contributions are licensed under the MIT License and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
