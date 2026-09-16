# sessport

**AI 编程会话的"护照"。** 在 Claude Code 里开始的任务，可以带着完整对话到 Codex CLI 或 Gemini CLI 里原生续上。

[English](README.md)

```bash
npx sessport list                          # 列出所有工具的会话
npx sessport convert claude:latest --to codex
# → 打印 `cd <项目> && codex resume <id>`，直接续聊
npx sessport handoff codex:latest > HANDOFF.md   # 生成交接摘要
```

## 能做什么

- **原生续聊**：生成目标工具自己的会话文件，`claude --resume` / `codex resume` / `gemini --resume` 直接打开。
- **用真实 CLI 验证**：每周 CI 会用最新版 Claude Code、Codex CLI、Gemini CLI 实际加载转换结果（模型接口用本地 mock，不花钱、不外发数据）。
- **默认脱敏**：写出前自动去除 API key、token、私钥、URL 密码等；不会覆盖已有文件。
- **零运行时依赖**，也可以作为库引用。

## 命令

| 命令 | 作用 |
|---|---|
| `sessport list [--tool t] [--here]` | 列出所有会话，按时间倒序 |
| `sessport show <会话>` | 以 Markdown 打印会话 |
| `sessport export <会话> --format md\|json\|handoff -o 文件` | 导出 |
| `sessport handoff <会话>` | 生成交接摘要（目标、后续需求、改过的文件、停在哪里） |
| `sessport convert <会话> --to claude\|codex\|gemini` | 转成另一个工具可续聊的会话 |
| `sessport search <关键词> [--regex]` | 全文搜索历史会话 |
| `sessport doctor` | 查看会话目录与数量 |

`<会话>` 可以是 id（或前缀）、文件路径、`latest`，或 `工具:latest` / `工具:id`。

## 转换原理

工具调用和结果会被渲染成带标签的文本，因为不同 CLI 的工具集不同，把别家的工具调用当原生调用回放会被模型 API 拒绝。开头会加一段说明，提醒新 agent 这段对话来自哪里、编辑前先重新检查文件。thinking 默认丢弃，图片替换为占位说明。

详细格式见 [docs/formats.md](docs/formats.md)，路线图见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 许可

MIT
