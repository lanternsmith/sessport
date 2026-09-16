# Session formats

What sessport knows about each tool's local session storage. Versions in brackets are the ones this was last checked against. PRs that keep this page current are very welcome.

## Claude Code [2.1.273]

- Location: `$CLAUDE_CONFIG_DIR` or `~/.claude`, then `projects/<encoded cwd>/<session-id>.jsonl`.
- `<encoded cwd>`: the absolute project path with every non-alphanumeric character replaced by `-` (`/Users/me/app` → `-Users-me-app`).
- Subagent transcripts live in nested folders (`<session-id>/subagents/…`) and are ignored.
- One JSON record per line. Conversation records have `type: "user" | "assistant"`, plus `uuid`, `parentUuid`, `sessionId`, `cwd`, `gitBranch`, `version`, `timestamp`, `isSidechain`.
  - `message` is an Anthropic Messages API message. Assistant turns are written **one content block per line**; lines that share `message.id` belong to the same turn.
  - Tool results are `user` records whose content holds `tool_result` blocks.
  - `isMeta: true` marks injected context; `isSidechain: true` marks subagent traffic.
- Other record types include `attachment`, `queue-operation`, `last-prompt`, `ai-title` (`aiTitle`), `custom-title` (`customTitle`), `summary` (older), `file-history-snapshot`.
- Rewinds create branches: sessport follows `parentUuid` back from the newest message to get the active branch.
- Resume: `claude --resume <session-id>` from the project directory.

## Codex CLI [0.154.0]

- Location: `$CODEX_HOME` or `~/.codex`, then `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread-id>.jsonl` (local time in the name). Cold files may be compressed to `.jsonl.zst`. Reverted threads append `_<rollout-id>` to the name.
- Each line: `{ "timestamp", "type", "payload" }` with `type`:
  - `session_meta`: `id`, `session_id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source`, `model_provider`, `base_instructions`, optional `git`.
  - `turn_context`: per-turn settings including `model` and `cwd`.
  - `response_item`: an OpenAI Responses API item — `message` (roles `user`, `assistant`, `developer`), `reasoning`, `function_call` (`arguments` is a JSON string), `function_call_output`, `custom_tool_call` (e.g. `apply_patch` with a raw `input`), `custom_tool_call_output`, `local_shell_call`, `web_search_call`, …
  - `event_msg`: UI events (`user_message`, `agent_message`, `token_count`, …) that duplicate the conversation for the TUI.
  - `compacted`: summary produced by context compaction.
- User messages that start with `<environment_context>`, `<user_instructions>`, `# AGENTS.md instructions`, … are injected context.
- Legacy (mid-2025) files have no envelope: the first line is the session meta and items follow at the top level.
- `codex resume <id>` looks the id up in its state database and falls back to scanning file names, so a newly written file is found immediately.

## Gemini CLI [core 0.60.0]

- Location: `~/.gemini/tmp/<project>/chats/session-<YYYY-MM-DDTHH-MM>-<first 8 of id>.jsonl`.
- `<project>` is a short slug from `~/.gemini/projects.json` (`{ "projects": { "<abs path>": "<slug>" } }`), with a `.project_root` marker file containing the path in `tmp/<slug>/` and `history/<slug>/`. Older versions used the SHA-256 of the project path as the folder name.
- The JSONL file is an append log:
  - first line: `{ sessionId, projectHash, startTime, lastUpdated, kind }` (`projectHash` is the SHA-256 of the project root);
  - message records with `id`, `timestamp`, `type` (`user`, `gemini`, `info`, `error`, `warning`) and `content` (a Gemini `PartListUnion`). A record with an existing `id` replaces the earlier one;
  - `{ "$set": { … } }` metadata updates (may include a full `messages` checkpoint);
  - `{ "$rewindTo": "<id>" }` drops that message and everything after it.
- `gemini` messages may carry `toolCalls` (`id`, `name`, `args`, `result`, `status`), `thoughts` and `model`.
- User messages starting with `/` or `?` are commands and are not replayed.
- Legacy sessions are a single JSON object with a `messages` array in a `.json` file.
- Resume: `gemini --resume <session-id>` from the project directory (it only looks in that project's folder).
