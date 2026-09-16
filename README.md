# sessport

**A passport for your AI coding sessions.** Start a task in Claude Code, continue it in Codex CLI, finish it in Gemini CLI — with the full conversation, resumed natively.

[![CI](https://github.com/lanternsmith/sessport/actions/workflows/ci.yml/badge.svg)](https://github.com/lanternsmith/sessport/actions/workflows/ci.yml)
[![Compatibility](https://github.com/lanternsmith/sessport/actions/workflows/compat.yml/badge.svg)](https://github.com/lanternsmith/sessport/actions/workflows/compat.yml)
[![npm](https://img.shields.io/npm/v/sessport)](https://www.npmjs.com/package/sessport)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[中文说明](README.zh-CN.md)

```console
$ npx sessport list
claude 3f2a91c0  12m ago   Fix flaky auth test
                ~/code/api
codex  0199aaaa  2h ago    Add pagination to GET /users
                ~/code/api

$ npx sessport convert claude:latest --to codex
✓ Wrote Codex CLI session 7c1af1b6-e336-41cd-90c2-d98315c0b36c
  from Claude Code 3f2a91c0-… (42 messages)
  ~/.codex/sessions/2026/09/16/rollout-2026-09-16T11-02-44-7c1af1b6-….jsonl

Resume it with:
  cd ~/code/api && codex resume 7c1af1b6-e336-41cd-90c2-d98315c0b36c
```

## Why

You hit a rate limit, want a second opinion from another model, or your team uses a different agent. Copy-pasting a long transcript loses the structure and burns your time. `sessport` reads each tool's local session files and writes a **real session file for the other tool**, so `claude --resume`, `codex resume` and `gemini --resume` just work.

- **Native resume, not just export.** Converted sessions open in the target CLI like any other session.
- **Verified against the real CLIs.** A [compatibility job](.github/workflows/compat.yml) converts fixtures and resumes them with the latest Claude Code, Codex CLI and Gemini CLI every week (model APIs are mocked, nothing leaves the runner).
- **Safe by default.** Secrets such as API keys, tokens, private keys and URL passwords are scrubbed before anything is written. Existing files are never overwritten.
- **Zero runtime dependencies.** One small Node.js package. Also usable as a library.

## Install

```bash
npm install -g sessport     # or run any command with: npx sessport ...
```

Requires Node.js 20+. Reading Codex's compressed (`.jsonl.zst`) archives needs Node.js 22.15+.

## Commands

| Command | What it does |
|---|---|
| `sessport list [--tool t] [--here]` | All sessions from every tool, newest first. `--here` limits to the current directory. |
| `sessport show <session>` | Print a session as readable Markdown. |
| `sessport export <session> --format md\|json\|handoff -o file` | Save a transcript. |
| `sessport handoff <session>` | Compact briefing (goal, later requests, files touched, where it left off) to paste into any agent. |
| `sessport convert <session> --to claude\|codex\|gemini` | Write a natively resumable copy for another tool. |
| `sessport search <query> [--regex]` | Find the session where you solved something. |
| `sessport doctor` | Show where sessions are looked up and how many were found. |

`<session>` can be an id or id prefix, a file path, `latest`, or `<tool>:latest` / `<tool>:<id>`.

Useful `convert` flags: `--cwd <dir>` (project directory of the new session), `--last <n>` (keep only the last n messages), `--max-output <n>` (truncate tool output, default 4000 chars), `--keep-thinking`, `--no-redact`, `--dry-run`, `--json`.

## Supported tools

| Tool | Read | Write / resume | Where sessions live |
|---|:-:|:-:|---|
| Claude Code | ✅ | ✅ `claude --resume <id>` | `~/.claude/projects/<dir>/<id>.jsonl` (`CLAUDE_CONFIG_DIR`) |
| Codex CLI | ✅ incl. legacy + `.zst` | ✅ `codex resume <id>` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`CODEX_HOME`) |
| Gemini CLI | ✅ incl. legacy `.json` | ✅ `gemini --resume <id>` | `~/.gemini/tmp/<project>/chats/session-*.jsonl` |

Last verified with Claude Code 2.1.273, Codex CLI 0.154.0 and Gemini CLI core 0.60.0. Format details are in [docs/formats.md](docs/formats.md). Cursor, OpenCode and Aider are on the [roadmap](docs/ROADMAP.md).

## How conversion works

1. The source file is parsed into a small tool-neutral model (messages with text, thinking, tool calls, tool results).
2. For the target, tool calls and results are rendered as tagged text (`<tool_call name="Edit">…`). Each CLI has a different tool set, and model APIs reject histories that reference tools they don't have, so text is the reliable way to carry them over.
3. A short preamble tells the new agent where the conversation came from and to re-check files before editing.
4. Turns are merged so roles alternate, secrets are redacted, and the session file is written in the target's native layout (including Gemini's project registry when the directory is new).

Thinking blocks are dropped by default because they are model-specific (and signed, for Claude). Images are replaced by a note.

## Library

```ts
import { resolveSession, convertSession, toHandoff } from 'sessport';

const session = await resolveSession('claude:latest');
console.log(toHandoff(session));
const result = await convertSession(session, { to: 'codex', dryRun: true });
console.log(result.resumeCommand);
```

## Related projects

Good tools already cover parts of this space: [ccusage](https://github.com/ccusage/ccusage) (usage), [claude-code-log](https://github.com/daaain/claude-code-log) and [SpecStory](https://github.com/specstoryai/getspecstory) (transcripts), [cass](https://github.com/Dicklesworthstone/coding_agent_session_search) (search), [continues](https://github.com/yigitkonur/cli-continues) (handoff across many tools), [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer) (native conversion, Rust). sessport focuses on **native, tested conversion in a zero-dependency npm package** that you can also import as a library.

## Contributing

Issues and PRs are welcome — especially format changes in new CLI releases. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
