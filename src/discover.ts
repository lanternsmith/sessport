import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { adapters, getAdapter } from './adapters/index.js';
import type { Session, SessionSummary, ToolId } from './model.js';
import { TOOL_IDS } from './model.js';

export type Homes = Partial<Record<ToolId, string>>;

export function homeFor(tool: ToolId, homes: Homes = {}): string {
  return homes[tool] ?? adapters[tool].defaultHome();
}

export interface ListOptions {
  tools?: ToolId[];
  homes?: Homes;
  /** Only sessions whose cwd equals (or is inside) this directory. */
  cwd?: string;
}

export async function listSessions(options: ListOptions = {}): Promise<SessionSummary[]> {
  const tools = options.tools?.length ? options.tools : [...TOOL_IDS];
  const results = await Promise.all(
    tools.map(async (tool) => {
      const home = homeFor(tool, options.homes);
      if (!existsSync(home)) return [];
      return adapters[tool].list(home);
    }),
  );
  let all = results.flat();
  if (options.cwd) {
    const want = resolve(options.cwd);
    all = all.filter((s) => s.cwd && (resolve(s.cwd) === want || resolve(s.cwd).startsWith(`${want}/`)));
  }
  return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export interface ResolveOptions extends ListOptions {
  /** Tool hint for file paths or ambiguous ids. */
  tool?: ToolId;
}

/**
 * Accepts a file path, a full or partial session id, `latest`, or
 * `<tool>:latest` / `<tool>:<id>`, and loads the full session.
 */
export async function resolveSession(ref: string, options: ResolveOptions = {}): Promise<Session> {
  let tool = options.tool;
  let needle = ref;
  const m = /^(claude|codex|gemini):(.+)$/.exec(ref);
  if (m) {
    tool = m[1] as ToolId;
    needle = m[2]!;
  }

  if (existsSync(needle)) {
    const path = resolve(needle);
    const guessed = tool ?? guessToolFromPath(path);
    if (!guessed) throw new Error(`Cannot tell which tool wrote ${path}. Pass --from claude|codex|gemini.`);
    return getAdapter(guessed).read(path);
  }

  const sessions = await listSessions({ ...options, tools: tool ? [tool] : options.tools });
  let match: SessionSummary | undefined;
  if (needle === 'latest' || needle === 'last') {
    match = sessions[0];
  } else {
    const hits = sessions.filter((s) => s.id === needle || s.id.startsWith(needle));
    if (hits.length > 1 && !hits.some((h) => h.id === needle)) {
      const list = hits
        .slice(0, 5)
        .map((h) => `  ${h.tool}:${h.id}`)
        .join('\n');
      throw new Error(`"${needle}" matches ${hits.length} sessions:\n${list}\nUse a longer id.`);
    }
    match = hits.find((h) => h.id === needle) ?? hits[0];
  }
  if (!match) throw new Error(`No session found for "${ref}". Run \`sessport list\` to see what is available.`);
  return adapters[match.tool].read(match.path);
}

export function guessToolFromPath(path: string): ToolId | undefined {
  const p = path.replace(/\\/g, '/');
  const name = basename(p);
  if (p.includes('/.claude/')) return 'claude';
  if (p.includes('/.codex/') || /^rollout-.*\.jsonl(\.zst)?$/.test(name)) return 'codex';
  if (p.includes('/.gemini/') || /^session-.*\.jsonl?$/.test(name)) return 'gemini';
  if (/^[0-9a-f-]{36}\.jsonl$/i.test(name)) return 'claude';
  return undefined;
}
