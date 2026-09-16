# Roadmap

Ideas, roughly in priority order. Comment on or upvote the matching issue to influence the order.

## 0.2
- `sessport pick`: interactive picker (arrow keys) for `show` / `convert`.
- `convert --open`: launch the target CLI right after converting.
- `handoff --copy`: copy the briefing to the clipboard.
- Windows path handling and CI.

## 0.3 — more tools
- OpenCode (read + write)
- Cursor agent chats (read)
- Aider (`.aider.chat.history.md`, read)
- GitHub Copilot CLI (read)

## Later
- `sessport watch`: keep a Markdown mirror of every session in the repo (`.sessions/`).
- Optional native tool-call mapping for tools with equivalent built-ins (e.g. shell ↔ Bash).
- Plugin API so other tools can ship their own adapter.
- Sync between machines (export bundle / import bundle).
