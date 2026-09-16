import { createHash } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import type { Adapter, Message, Part, Session, SessionSummary, WriteOptions, WriteResult } from '../model.js';
import { prepareMessages, type PrepareOptions } from '../prepare.js';
import { shellQuote } from './claude.js';
import {
  exists,
  isRecord,
  isSyntheticUserText,
  maxIso,
  oneLine,
  parseJsonl,
  readText,
  str,
  uuid,
  writeFileSafely,
} from '../util.js';

function defaultHome(): string {
  return join(homedir(), '.gemini');
}

type Rec = Record<string, unknown>;

const SESSION_FILE_RE = /^session-.*\.jsonl?$/;
const PROJECT_ROOT_FILE = '.project_root';

export function geminiProjectHash(projectRoot: string): string {
  return createHash('sha256').update(projectRoot).digest('hex');
}

function normalizeProjectPath(p: string): string {
  const r = resolve(p);
  return platform() === 'win32' ? r.toLowerCase() : r;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'project'
  );
}

async function readRegistry(home: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(home, 'projects.json'), 'utf8'));
    if (isRecord(parsed) && isRecord(parsed.projects)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.projects)) if (typeof v === 'string') out[k] = v;
      return out;
    }
  } catch {
    // missing or corrupt registry
  }
  return {};
}

async function readMarker(dir: string): Promise<string | undefined> {
  try {
    return (await readFile(join(dir, PROJECT_ROOT_FILE), 'utf8')).trim();
  } catch {
    return undefined;
  }
}

/** Maps a directory under ~/.gemini/tmp (slug or legacy sha256) back to its project path. */
async function projectDirResolver(home: string): Promise<(dirName: string) => Promise<string | undefined>> {
  const registry = await readRegistry(home);
  const bySlug = new Map<string, string>();
  const byHash = new Map<string, string>();
  for (const [path, slug] of Object.entries(registry)) {
    bySlug.set(slug, path);
    byHash.set(geminiProjectHash(path), path);
  }
  return async (dirName) =>
    (await readMarker(join(home, 'tmp', dirName))) ?? bySlug.get(dirName) ?? byHash.get(dirName);
}

function partsOf(content: unknown): Rec[] {
  if (typeof content === 'string') return [{ text: content }];
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? { text: p } : p)).filter(isRecord);
  if (isRecord(content)) return [content];
  return [];
}

function resultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const lines: string[] = [];
  for (const p of partsOf(result)) {
    if (typeof p.text === 'string') lines.push(p.text);
    else if (isRecord(p.functionResponse)) {
      const resp = p.functionResponse.response;
      if (isRecord(resp)) {
        if (typeof resp.output === 'string') lines.push(resp.output);
        else if (typeof resp.error === 'string') lines.push(`Error: ${resp.error}`);
        else lines.push(JSON.stringify(resp));
      }
    } else if (isRecord(p.inlineData)) lines.push('[binary data]');
  }
  return lines.join('\n');
}

function messageParts(msg: Rec): { role: Message['role']; parts: Part[] } | undefined {
  if (msg.type === 'user') {
    const text = partsOf(msg.content)
      .map((p) => str(p.text) ?? '')
      .join('');
    const trimmed = text.trim();
    if (isSyntheticUserText(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('?')) return undefined;
    return { role: 'user', parts: [{ type: 'text', text }] };
  }
  if (msg.type !== 'gemini') return undefined;

  const parts: Part[] = [];
  const results: Part[] = [];
  const seenCalls = new Set<string>();
  const contentParts = partsOf(msg.content);
  const hasThoughtParts = contentParts.some((p) => p.thought === true);

  if (!hasThoughtParts && Array.isArray(msg.thoughts)) {
    for (const t of msg.thoughts) {
      if (!isRecord(t)) continue;
      const subject = str(t.subject);
      const description = str(t.description) ?? '';
      parts.push({ type: 'thinking', text: subject ? `**${subject}** ${description}` : description });
    }
  }
  for (const p of contentParts) {
    if (typeof p.text === 'string') {
      if (!p.text) continue;
      parts.push(p.thought === true ? { type: 'thinking', text: p.text } : { type: 'text', text: p.text });
    } else if (isRecord(p.functionCall)) {
      const id = str(p.functionCall.id) ?? '';
      if (id) seenCalls.add(id);
      parts.push({ type: 'tool_call', id, name: str(p.functionCall.name) ?? 'function', input: p.functionCall.args ?? {} });
    }
  }
  if (Array.isArray(msg.toolCalls)) {
    for (const tc of msg.toolCalls) {
      if (!isRecord(tc)) continue;
      const id = str(tc.id) ?? '';
      const name = str(tc.name) ?? 'tool';
      if (!seenCalls.has(id)) parts.push({ type: 'tool_call', id, name, input: tc.args ?? {} });
      if (tc.result != null) {
        results.push({
          type: 'tool_result',
          callId: id,
          name,
          output: resultText(tc.result),
          isError: tc.status === 'error' ? true : undefined,
        });
      }
    }
  }
  if (!parts.length && !results.length) return undefined;
  // Results are attached to the assistant turn; the adapter splits them out below.
  return { role: 'assistant', parts: [...parts, ...results] };
}

/** Replays a Gemini CLI JSONL session (records, `$set` updates and `$rewindTo`). */
function replayJsonl(records: unknown[]): { meta: Rec; messages: Rec[] } {
  const meta: Rec = {};
  const messages = new Map<string, Rec>();
  for (const r of records) {
    if (!isRecord(r)) continue;
    if (typeof r.$rewindTo === 'string') {
      let found = false;
      for (const key of [...messages.keys()]) {
        if (key === r.$rewindTo) found = true;
        if (found) messages.delete(key);
      }
      if (!found) messages.clear();
    } else if (typeof r.id === 'string') {
      messages.set(r.id, r);
    } else if (isRecord(r.$set)) {
      const { messages: checkpoint, ...rest } = r.$set;
      Object.assign(meta, rest);
      if (Array.isArray(checkpoint)) {
        messages.clear();
        for (const m of checkpoint) if (isRecord(m) && typeof m.id === 'string') messages.set(m.id, m);
      }
    } else if (typeof r.sessionId === 'string') {
      Object.assign(meta, r);
    }
  }
  return { meta, messages: [...messages.values()] };
}

export function parseGeminiContent(text: string, path: string, cwd?: string): Session {
  let meta: Rec = {};
  let rawMessages: Rec[] = [];
  const trimmed = text.trimStart();
  if (path.endsWith('.json') && trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        meta = parsed;
        rawMessages = Array.isArray(parsed.messages) ? parsed.messages.filter(isRecord) : [];
      }
    } catch {
      ({ meta, messages: rawMessages } = replayJsonl(parseJsonl(text)));
    }
  } else {
    ({ meta, messages: rawMessages } = replayJsonl(parseJsonl(text)));
  }

  const messages: Message[] = [];
  let updatedAt = str(meta.lastUpdated);
  let model: string | undefined;
  for (const raw of rawMessages) {
    const got = messageParts(raw);
    const ts = str(raw.timestamp);
    updatedAt = maxIso(updatedAt, ts);
    if (!got) continue;
    const msgModel = str(raw.model);
    if (msgModel) model = msgModel;
    if (got.role === 'assistant') {
      const calls = got.parts.filter((p) => p.type !== 'tool_result');
      const results = got.parts.filter((p) => p.type === 'tool_result');
      if (calls.length) messages.push({ role: 'assistant', timestamp: ts, model: msgModel, parts: calls });
      if (results.length) messages.push({ role: 'user', timestamp: ts, parts: results });
    } else {
      messages.push({ role: 'user', timestamp: ts, parts: got.parts });
    }
  }

  const firstPrompt = messages.find((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text'));
  const preview = firstPrompt ? oneLine(firstPrompt.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ')) : undefined;

  return {
    tool: 'gemini',
    id: str(meta.sessionId) ?? basename(path).replace(/\.jsonl?$/, ''),
    path,
    cwd,
    title: str(meta.summary),
    startedAt: str(meta.startTime),
    updatedAt,
    preview,
    model,
    messages,
  };
}

async function cwdForFile(home: string, file: string): Promise<string | undefined> {
  const projectDir = basename(dirname(dirname(file)));
  const resolver = await projectDirResolver(home);
  return resolver(projectDir);
}

export interface GeminiWriteOptions extends WriteOptions {
  prepare?: Omit<PrepareOptions, 'targetName'>;
}

interface SlugPlan {
  slug: string;
  create: boolean;
}

async function planSlug(home: string, cwd: string): Promise<SlugPlan> {
  const target = normalizeProjectPath(cwd);
  const registry = await readRegistry(home);
  const tmp = join(home, 'tmp');
  const known = registry[target];
  if (known) {
    const owner = await readMarker(join(tmp, known));
    if (!owner || normalizeProjectPath(owner) === target) return { slug: known, create: false };
  }
  let dirs: string[] = [];
  try {
    dirs = await readdir(tmp);
  } catch {
    dirs = [];
  }
  for (const d of dirs) {
    const owner = await readMarker(join(tmp, d));
    if (owner && normalizeProjectPath(owner) === target) return { slug: d, create: true };
  }
  const base = slugify(basename(target) || 'project');
  const taken = new Set(Object.values(registry));
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? base : `${base}-${i}`;
    if (taken.has(candidate)) continue;
    const owner = await readMarker(join(tmp, candidate));
    if (owner && normalizeProjectPath(owner) !== target) continue;
    return { slug: candidate, create: true };
  }
}

async function claimSlug(home: string, cwd: string, slug: string): Promise<string[]> {
  const target = normalizeProjectPath(cwd);
  const touched: string[] = [];
  for (const base of [join(home, 'tmp'), join(home, 'history')]) {
    const marker = join(base, slug, PROJECT_ROOT_FILE);
    if (!(await exists(marker))) {
      await mkdir(dirname(marker), { recursive: true });
      await writeFile(marker, target, { encoding: 'utf8', flag: 'wx' });
      touched.push(marker);
    }
  }
  const registryPath = join(home, 'projects.json');
  const registry = await readRegistry(home);
  if (registry[target] !== slug) {
    registry[target] = slug;
    await writeFile(registryPath, JSON.stringify({ projects: registry }, null, 2), 'utf8');
    touched.push(registryPath);
  }
  return touched;
}

export function renderGeminiSession(session: Session, options: GeminiWriteOptions & { slug: string }): WriteResult {
  const id = options.id ?? uuid();
  const now = options.now ?? new Date();
  const stamp = now.toISOString().slice(0, 16).replace(/:/g, '-');
  const path = join(options.home, 'tmp', options.slug, 'chats', `session-${stamp}-${id.slice(0, 8)}.jsonl`);
  const prepared = prepareMessages(session, { ...options.prepare, targetName: 'Gemini CLI' });
  const iso = now.toISOString();
  const root = resolve(options.cwd);

  const lines: string[] = [
    JSON.stringify({
      sessionId: id,
      projectHash: geminiProjectHash(root),
      startTime: iso,
      lastUpdated: iso,
      kind: 'main',
    }),
  ];
  const baseTime = now.getTime() - prepared.length * 1000;
  prepared.forEach((m, i) => {
    lines.push(
      JSON.stringify({
        id: uuid(),
        timestamp: new Date(baseTime + i * 1000).toISOString(),
        type: m.role === 'user' ? 'user' : 'gemini',
        content: [{ text: m.text }],
      }),
    );
  });
  const title = `[${session.tool}] ${session.title ?? session.preview ?? session.id}`;
  lines.push(JSON.stringify({ $set: { summary: oneLine(title, 100), lastUpdated: iso } }));

  return {
    tool: 'gemini',
    id,
    path,
    resumeCommand: `cd ${shellQuote(options.cwd)} && gemini --resume ${id}`,
    contents: `${lines.join('\n')}\n`,
    sideEffects: [],
  };
}

export const geminiAdapter: Adapter = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  defaultHome,
  async list(home) {
    const tmp = join(home, 'tmp');
    const resolver = await projectDirResolver(home);
    let projectDirs: string[] = [];
    try {
      projectDirs = await readdir(tmp);
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const dir of projectDirs) {
      const chats = join(tmp, dir, 'chats');
      let files: string[];
      try {
        files = (await readdir(chats)).filter((f) => SESSION_FILE_RE.test(f));
      } catch {
        continue;
      }
      const cwd = await resolver(dir);
      for (const f of files) {
        const file = join(chats, f);
        try {
          const s = parseGeminiContent(await readText(file), file, cwd);
          if (!s.messages.length) continue;
          const st = await stat(file);
          out.push({
            tool: 'gemini',
            id: s.id,
            path: file,
            cwd,
            title: s.title,
            startedAt: s.startedAt,
            updatedAt: st.mtime.toISOString(),
            preview: s.preview,
          });
        } catch {
          continue;
        }
      }
    }
    return out;
  },
  async read(path) {
    const home = dirname(dirname(dirname(dirname(path))));
    return parseGeminiContent(await readText(path), path, await cwdForFile(home, path));
  },
  async write(session, options) {
    const plan = await planSlug(options.home, options.cwd);
    const result = renderGeminiSession(session, { ...options, slug: plan.slug });
    if (!options.dryRun) {
      if (plan.create) result.sideEffects.push(...(await claimSlug(options.home, options.cwd, plan.slug)));
      await writeFileSafely(result.path, result.contents);
    } else if (plan.create) {
      result.sideEffects.push(`(would register ${options.cwd} as Gemini project "${plan.slug}")`);
    }
    return result;
  },
};
