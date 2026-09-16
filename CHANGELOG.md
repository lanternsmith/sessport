# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-16

### Added

- Adapters for Claude Code, Codex CLI (current, legacy and `.zst` rollouts) and Gemini CLI (JSONL and legacy JSON sessions).
- `list`, `show`, `export`, `handoff`, `convert`, `search` and `doctor` commands.
- Native conversion between all three tools with resume commands.
- Secret redaction, tool-output truncation, `--last`, `--dry-run`.
- Library API.
- Real-CLI compatibility check (`npm run e2e`) verified with Claude Code 2.1.273, Codex CLI 0.154.0 and Gemini CLI core 0.60.0.
