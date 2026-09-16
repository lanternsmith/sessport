import { adapters } from './adapters/index.js';
import { listSessions, type ListOptions } from './discover.js';
import type { SessionSummary } from './model.js';
import { oneLine } from './util.js';

export interface SearchHit {
  session: SessionSummary;
  role: string;
  snippet: string;
}

export interface SearchOptions extends ListOptions {
  regex?: boolean;
  ignoreCase?: boolean;
  limit?: number;
}

export async function searchSessions(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  const flags = options.ignoreCase === false ? '' : 'i';
  const pattern = options.regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const limit = options.limit ?? 50;
  const hits: SearchHit[] = [];
  for (const summary of await listSessions(options)) {
    let session;
    try {
      session = await adapters[summary.tool].read(summary.path);
    } catch {
      continue;
    }
    // One hit per session: the first matching message.
    outer: for (const m of session.messages) {
      for (const p of m.parts) {
        const text = p.type === 'text' || p.type === 'thinking' ? p.text : p.type === 'tool_result' ? p.output : '';
        const found = pattern.exec(text);
        if (!found) continue;
        const start = Math.max(0, found.index - 50);
        hits.push({ session: summary, role: m.role, snippet: oneLine(text.slice(start, found.index + found[0].length + 70), 140) });
        break outer;
      }
    }
    if (hits.length >= limit) return hits;
  }
  return hits;
}
