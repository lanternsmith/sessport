import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { stat } from 'node:fs/promises';
import type { Adapter, Message, Part, Session, SessionSummary, WriteOptions, WriteResult } from '../model.js';
import { prepareMessages, type PrepareOptions } from '../prepare.js';
import { shellQuote } from './claude.js';
import {
  isRecord,
  isSyntheticUserText,
  maxIso,
  oneLine,
  parseJsonl,
  readJsonlHead,
  readText,
  str,
  uuid,
  walk,
  writeFileSafely,
} from '../util.js';

function defaultHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

type Rec = Record<string, unknown>;

const ROLLOUT_RE = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f-]{36})(?:_[0-9a-f-]+)?\.jsonl(?:\.zst)?$/i;

const RESPONSE_ITEM_TYPES = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'local_shell_call',
  'web_search_call',
  'tool_search_call',
  'tool_search_output',
]);

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (!isRecord(c)) return '';
      if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') return str(c.text) ?? '';
      if (c.type === 'input_image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function outputText(output: unknown): string {
  if (typeof output === 'string') {
    // Older rollouts stored `{"output": "...", "metadata": {...}}` as a JSON string.
    try {
      const parsed: unknown = JSON.parse(output);
      if (isRecord(parsed) && typeof parsed.output === 'string') return parsed.output;
    } catch {
      // plain text
    }
    return output;
  }
  if (Array.isArray(output)) return contentText(output);
  if (isRecord(output)) {
    if (typeof output.content === 'string') return output.content;
    if (Array.isArray(output.content)) return contentText(output.content);
  }
  return '';
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function itemParts(item: Rec): { role: Message['role']; parts: Part[] } | undefined {
  switch (item.type) {
    case 'message': {
      const role = str(item.role);
      const text = contentText(item.content);
      if (role === 'user') {
        return isSyntheticUserText(text) ? undefined : { role: 'user', parts: [{ type: 'text', text }] };
      }
      if (role === 'assistant') return text ? { role: 'assistant', parts: [{ type: 'text', text }] } : undefined;
      return undefined; // developer / system instructions
    }
    case 'reasoning': {
      const summary = Array.isArray(item.summary)
        ? item.summary.map((s) => (isRecord(s) ? (str(s.text) ?? '') : '')).join('\n')
        : '';
      return summary.trim() ? { role: 'assistant', parts: [{ type: 'thinking', text: summary }] } : undefined;
    }
    case 'function_call':
      return {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: str(item.call_id) ?? '', name: str(item.name) ?? 'function', input: parseArgs(item.arguments) }],
      };
    case 'custom_tool_call':
      return {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: str(item.call_id) ?? '', name: str(item.name) ?? 'tool', input: item.input }],
      };
    case 'local_shell_call': {
      const action = isRecord(item.action) ? item.action : {};
      return {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: str(item.call_id) ?? str(item.id) ?? '', name: 'local_shell', input: action }],
      };
    }
    case 'web_search_call': {
      const action = isRecord(item.action) ? item.action : {};
      return {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: str(item.id) ?? '', name: 'web_search', input: action }],
      };
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
      return {
        role: 'user',
        parts: [
          {
            type: 'tool_result',
            callId: str(item.call_id) ?? '',
            name: str(item.name),
            output: outputText(item.output),
          },
        ],
      };
    default:
      return undefined;
  }
}

export function parseCodexRecords(records: unknown[], path: string): Session {
  const messages: Message[] = [];
  let id: string | undefined;
  let cwd: string | undefined;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  let model: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;

  const push = (role: Message['role'], parts: Part[], timestamp?: string): void => {
    const prev = messages[messages.length - 1];
    // Tool outputs are "user" turns in our model but belong to the same exchange;
    // merge adjacent parts of the same role to keep the transcript compact.
    if (prev && prev.role === role && role === 'assistant') prev.parts.push(...parts);
    else if (prev && prev.role === role && parts.every((p) => p.type === 'tool_result') && prev.parts.every((p) => p.type === 'tool_result'))
      prev.parts.push(...parts);
    else messages.push({ role, timestamp, model: role === 'assistant' ? model : undefined, parts });
  };

  records.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const ts = str(raw.timestamp);
    updatedAt = maxIso(updatedAt, ts);

    // Current format: {timestamp, type, payload}. Legacy (2025): items at top level.
    let type = str(raw.type);
    let payload: unknown = raw.payload;
    if (payload === undefined) {
      if (index === 0 && !type && str(raw.id)) {
        type = 'session_meta';
        payload = raw;
      } else if (type && RESPONSE_ITEM_TYPES.has(type)) {
        payload = raw;
        type = 'response_item';
      }
    }
    if (!isRecord(payload)) return;

    switch (type) {
      case 'session_meta':
        id = id ?? str(payload.id);
        cwd = cwd ?? str(payload.cwd);
        startedAt = startedAt ?? str(payload.timestamp) ?? ts;
        version = version ?? str(payload.cli_version);
        if (isRecord(payload.git)) gitBranch = gitBranch ?? str(payload.git.branch);
        break;
      case 'turn_context':
        model = str(payload.model) ?? model;
        cwd = cwd ?? str(payload.cwd);
        break;
      case 'response_item': {
        const got = itemParts(payload);
        if (got) push(got.role, got.parts, ts);
        break;
      }
      case 'compacted': {
        const summary = str(payload.message);
        if (summary) push('user', [{ type: 'text', text: `[Earlier conversation was compacted. Summary:]\n${summary}` }], ts);
        break;
      }
      default:
        break;
    }
  });

  const firstPrompt = messages.find((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text'));
  const preview = firstPrompt ? oneLine(firstPrompt.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ')) : undefined;
  const fromName = ROLLOUT_RE.exec(basename(path));

  return {
    tool: 'codex',
    id: id ?? fromName?.[2] ?? basename(path),
    path,
    cwd,
    startedAt,
    updatedAt,
    preview,
    model,
    gitBranch,
    sourceVersion: version,
    messages,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Codex names rollout files with local time: YYYY-MM-DDThh-mm-ss. */
function fileStamp(d: Date): { stamp: string; y: string; m: string; day: string } {
  const y = String(d.getFullYear());
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  return { stamp: `${y}-${m}-${day}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`, y, m, day };
}

export interface CodexWriteOptions extends WriteOptions {
  prepare?: Omit<PrepareOptions, 'targetName'>;
}

export function renderCodexSession(session: Session, options: CodexWriteOptions): WriteResult {
  const id = options.id ?? uuid();
  const now = options.now ?? new Date();
  const { stamp, y, m, day } = fileStamp(now);
  const path = join(options.home, 'sessions', y, m, day, `rollout-${stamp}-${id}.jsonl`);
  const prepared = prepareMessages(session, { ...options.prepare, targetName: 'Codex CLI' });
  const iso = now.toISOString();

  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      timestamp: iso,
      type: 'session_meta',
      payload: {
        session_id: id,
        id,
        timestamp: iso,
        cwd: options.cwd,
        originator: 'sessport',
        cli_version: '0.0.0',
        source: 'cli',
        model_provider: 'openai',
        base_instructions: null,
        ...(session.gitBranch ? { git: { branch: session.gitBranch } } : {}),
      },
    }),
  );
  for (const msg of prepared) {
    const isUser = msg.role === 'user';
    lines.push(
      JSON.stringify({
        timestamp: iso,
        type: 'response_item',
        payload: {
          type: 'message',
          role: msg.role,
          content: [{ type: isUser ? 'input_text' : 'output_text', text: msg.text }],
        },
      }),
    );
    // event_msg lines drive the history shown in the TUI after resuming.
    lines.push(
      JSON.stringify({
        timestamp: iso,
        type: 'event_msg',
        payload: isUser
          ? { type: 'user_message', message: msg.text, kind: 'plain' }
          : { type: 'agent_message', message: msg.text },
      }),
    );
  }

  return {
    tool: 'codex',
    id,
    path,
    resumeCommand: `cd ${shellQuote(options.cwd)} && codex resume ${id}`,
    contents: `${lines.join('\n')}\n`,
    sideEffects: [],
  };
}

export const codexAdapter: Adapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  defaultHome,
  async list(home) {
    const files = await walk(join(home, 'sessions'), (n) => ROLLOUT_RE.test(n), 4);
    const out: SessionSummary[] = [];
    for (const file of files) {
      try {
        const head = await readJsonlHead(file, 60);
        const s = parseCodexRecords(head, file);
        if (!s.messages.length) continue;
        const st = await stat(file);
        out.push({
          tool: 'codex',
          id: s.id,
          path: file,
          cwd: s.cwd,
          startedAt: s.startedAt,
          updatedAt: st.mtime.toISOString(),
          preview: s.preview,
        });
      } catch {
        continue;
      }
    }
    return out;
  },
  async read(path) {
    return parseCodexRecords(parseJsonl(await readText(path)), path);
  },
  async write(session, options) {
    const result = renderCodexSession(session, options);
    if (!options.dryRun) await writeFileSafely(result.path, result.contents);
    return result;
  },
};
