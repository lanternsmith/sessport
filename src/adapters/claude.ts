import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { stat } from 'node:fs/promises';
import type { Adapter, Message, Part, Session, SessionSummary, WriteOptions, WriteResult } from '../model.js';
import { prepareMessages, type PrepareOptions } from '../prepare.js';
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

/** Claude Code stores each project under a directory named after its cwd. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function defaultHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

type Rec = Record<string, unknown>;

function blocksOf(message: unknown): unknown[] | string | undefined {
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (typeof content === 'string' || Array.isArray(content)) return content;
  return undefined;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (!isRecord(b)) return '';
      if (b.type === 'text') return str(b.text) ?? '';
      if (b.type === 'image') return '[image]';
      if (b.type === 'tool_reference') return `[tool reference: ${str(b.tool_name) ?? '?'}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function userParts(rec: Rec): Part[] {
  if (rec.isMeta === true) return [];
  const content = blocksOf(rec.message);
  if (typeof content === 'string') {
    return isSyntheticUserText(content) ? [] : [{ type: 'text', text: content }];
  }
  const parts: Part[] = [];
  for (const b of content ?? []) {
    if (!isRecord(b)) continue;
    if (b.type === 'text') {
      const text = str(b.text) ?? '';
      if (!isSyntheticUserText(text)) parts.push({ type: 'text', text });
    } else if (b.type === 'image') {
      parts.push({ type: 'image', note: 'image attached by user' });
    } else if (b.type === 'tool_result') {
      parts.push({
        type: 'tool_result',
        callId: str(b.tool_use_id) ?? '',
        output: toolResultText(b.content),
        isError: b.is_error === true ? true : undefined,
      });
    }
  }
  return parts;
}

function assistantParts(rec: Rec): Part[] {
  const content = blocksOf(rec.message);
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const parts: Part[] = [];
  for (const b of content ?? []) {
    if (!isRecord(b)) continue;
    switch (b.type) {
      case 'text': {
        const text = str(b.text) ?? '';
        if (text) parts.push({ type: 'text', text });
        break;
      }
      case 'thinking': {
        const text = str(b.thinking) ?? '';
        if (text) parts.push({ type: 'thinking', text });
        break;
      }
      case 'tool_use':
      case 'server_tool_use':
        parts.push({ type: 'tool_call', id: str(b.id) ?? '', name: str(b.name) ?? 'tool', input: b.input });
        break;
      case 'web_search_tool_result':
      case 'web_fetch_tool_result':
        parts.push({
          type: 'tool_result',
          callId: str(b.tool_use_id) ?? '',
          output: `[${String(b.type)}]`,
        });
        break;
      default:
        break;
    }
  }
  return parts;
}

/** Follows parentUuid links back from the newest message so rewound branches are skipped. */
function activeChain(records: Rec[]): Rec[] {
  const byUuid = new Map<string, Rec>();
  for (const r of records) {
    const id = str(r.uuid);
    if (id) byUuid.set(id, r);
  }
  const conversational = records.filter((r) => (r.type === 'user' || r.type === 'assistant') && r.isSidechain !== true);
  const leaf = conversational[conversational.length - 1];
  if (!leaf) return [];
  const chain: Rec[] = [];
  const seen = new Set<string>();
  let cur: Rec | undefined = leaf;
  while (cur) {
    const id = str(cur.uuid);
    if (!id || seen.has(id)) break;
    seen.add(id);
    chain.push(cur);
    const parent = str(cur.parentUuid);
    cur = parent ? byUuid.get(parent) : undefined;
  }
  chain.reverse();
  const chainConversational = chain.filter((r) => r.type === 'user' || r.type === 'assistant');
  // A broken chain (e.g. after compaction) can be much shorter than the file; fall back to file order.
  if (chainConversational.length < conversational.length / 2) return conversational;
  return chainConversational;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `claude --resume` looks sessions up by file name, so prefer that over in-file ids. */
function fileId(path: string): string | undefined {
  const name = basename(path).replace(/\.jsonl$/, '');
  return UUID_RE.test(name) ? name : undefined;
}

export function parseClaudeRecords(records: unknown[], path: string): Session {
  const recs = records.filter(isRecord);
  let title: string | undefined;
  let customTitle: string | undefined;
  for (const r of recs) {
    if (r.type === 'custom-title') customTitle = str(r.customTitle) ?? customTitle;
    else if (r.type === 'ai-title') title = str(r.aiTitle) ?? title;
    else if (r.type === 'summary' && !title) title = str(r.summary);
  }

  const messages: Message[] = [];
  let lastAssistantId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let model: string | undefined;
  let id: string | undefined;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;

  for (const r of activeChain(recs)) {
    cwd = cwd ?? str(r.cwd);
    gitBranch = str(r.gitBranch) ?? gitBranch;
    version = str(r.version) ?? version;
    id = id ?? str(r.sessionId);
    const ts = str(r.timestamp);
    if (ts && !startedAt) startedAt = ts;
    updatedAt = maxIso(updatedAt, ts);

    if (r.type === 'assistant') {
      const msg = isRecord(r.message) ? r.message : {};
      const msgId = str(msg.id);
      const msgModel = str(msg.model);
      if (msgModel && msgModel !== '<synthetic>') model = msgModel;
      const parts = assistantParts(r);
      const prev = messages[messages.length - 1];
      // Claude Code writes one line per content block; lines sharing message.id belong together.
      if (prev && prev.role === 'assistant' && msgId && msgId === lastAssistantId) {
        prev.parts.push(...parts);
      } else if (parts.length) {
        messages.push({ role: 'assistant', timestamp: ts, model: msgModel, parts });
      }
      lastAssistantId = msgId;
    } else {
      const parts = userParts(r);
      lastAssistantId = undefined;
      if (parts.length) messages.push({ role: 'user', timestamp: ts, parts });
    }
  }

  const firstPrompt = messages.find((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text'));
  const preview = firstPrompt ? oneLine(firstPrompt.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ')) : undefined;

  return {
    tool: 'claude',
    id: fileId(path) ?? id ?? basename(path),
    path,
    cwd,
    title: customTitle ?? title,
    startedAt,
    updatedAt,
    preview,
    model,
    gitBranch,
    sourceVersion: version,
    messages,
  };
}

export interface ClaudeWriteOptions extends WriteOptions {
  prepare?: Omit<PrepareOptions, 'targetName'>;
  /** Value written to the `version` field of each line. */
  claudeVersion?: string;
}

export function renderClaudeSession(session: Session, options: ClaudeWriteOptions): WriteResult {
  const id = options.id ?? uuid();
  const now = options.now ?? new Date();
  const home = options.home;
  const cwd = options.cwd;
  const path = join(home, 'projects', encodeClaudeProjectDir(cwd), `${id}.jsonl`);
  const prepared = prepareMessages(session, { ...options.prepare, targetName: 'Claude Code' });
  const version = options.claudeVersion ?? '2.1.0';

  const lines: string[] = [];
  let parentUuid: string | null = null;
  const baseTime = now.getTime() - prepared.length * 1000;
  prepared.forEach((m, i) => {
    const lineUuid = uuid();
    // Use strictly increasing synthetic timestamps so Claude Code orders messages reliably.
    const timestamp = new Date(baseTime + i * 1000).toISOString();
    const common = {
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId: id,
      version,
      gitBranch: session.gitBranch ?? '',
    };
    if (m.role === 'user') {
      lines.push(
        JSON.stringify({
          ...common,
          type: 'user',
          message: { role: 'user', content: m.text },
          uuid: lineUuid,
          timestamp,
        }),
      );
    } else {
      lines.push(
        JSON.stringify({
          ...common,
          type: 'assistant',
          message: {
            id: `msg_sessport_${lineUuid.replace(/-/g, '')}`,
            type: 'message',
            role: 'assistant',
            model: m.model ?? session.model ?? 'imported',
            content: [{ type: 'text', text: m.text }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          requestId: `req_sessport_${i}`,
          uuid: lineUuid,
          timestamp,
        }),
      );
    }
    parentUuid = lineUuid;
  });

  const title = `[${session.tool}] ${session.title ?? session.preview ?? session.id}`;
  lines.push(JSON.stringify({ type: 'ai-title', aiTitle: oneLine(title, 100), sessionId: id }));

  return {
    tool: 'claude',
    id,
    path,
    resumeCommand: `cd ${shellQuote(cwd)} && claude --resume ${id}`,
    contents: `${lines.join('\n')}\n`,
    sideEffects: [],
  };
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export const claudeAdapter: Adapter = {
  id: 'claude',
  displayName: 'Claude Code',
  defaultHome,
  async list(home) {
    const root = join(home, 'projects');
    // Only top-level session files; subagent transcripts live in nested folders.
    const files = await walk(root, (n) => n.endsWith('.jsonl'), 1);
    const out: SessionSummary[] = [];
    for (const file of files) {
      if (dirname(dirname(file)) !== root) continue;
      try {
        const head = await readJsonlHead(file, 200);
        const s = parseClaudeRecords(head, file);
        if (!s.messages.length) continue;
        const st = await stat(file);
        out.push({
          tool: 'claude',
          id: s.id,
          path: file,
          cwd: s.cwd,
          title: s.title,
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
    return parseClaudeRecords(parseJsonl(await readText(path)), path);
  },
  async write(session, options) {
    const result = renderClaudeSession(session, options);
    if (!options.dryRun) await writeFileSafely(result.path, result.contents);
    return result;
  },
};
