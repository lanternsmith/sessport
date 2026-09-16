import type { Session, ToolCallPart } from './model.js';
import { toolLabel } from './prepare.js';
import { redactText } from './redact.js';
import { isRecord, oneLine, truncate } from './util.js';

const PATH_KEYS = ['file_path', 'path', 'filePath', 'absolute_path', 'notebook_path', 'target_file', 'filename'];
const WRITE_TOOLS = /edit|write|patch|replace|create|multiedit|notebookedit|apply/i;

/** Pulls file paths out of tool-call inputs, including `apply_patch` bodies. */
export function touchedFiles(session: Session): { edited: string[]; read: string[] } {
  const edited = new Set<string>();
  const read = new Set<string>();
  for (const m of session.messages) {
    for (const p of m.parts) {
      if (p.type !== 'tool_call') continue;
      const paths = pathsFromCall(p);
      const target = WRITE_TOOLS.test(p.name) || /\*\*\* (Update|Add) File:/.test(JSON.stringify(p.input ?? '')) ? edited : read;
      for (const path of paths) target.add(path);
    }
  }
  for (const e of edited) read.delete(e);
  return { edited: [...edited], read: [...read] };
}

function pathsFromCall(call: ToolCallPart): string[] {
  const out: string[] = [];
  const input = call.input;
  if (isRecord(input)) {
    for (const key of PATH_KEYS) {
      const v = input[key];
      if (typeof v === 'string' && v.length < 300) out.push(v);
    }
  }
  const raw = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  for (const m of raw.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/g)) out.push(m[1]!.trim());
  return out;
}

export interface HandoffOptions {
  recentTurns?: number;
  redact?: boolean;
}

/**
 * A compact, deterministic briefing another agent can read to pick up the work.
 * No LLM is involved, so it is free, fast, and reproducible.
 */
export function toHandoff(session: Session, options: HandoffOptions = {}): string {
  const recent = options.recentTurns ?? 6;
  const userTexts = session.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.parts.filter((p) => p.type === 'text').map((p) => (p.type === 'text' ? p.text : '')).join('\n'))
    .filter((t) => t.trim());
  const assistantTexts = session.messages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.parts.filter((p) => p.type === 'text').map((p) => (p.type === 'text' ? p.text : '')).join('\n'))
    .filter((t) => t.trim());
  const { edited, read } = touchedFiles(session);
  const toolCount = session.messages.reduce((n, m) => n + m.parts.filter((p) => p.type === 'tool_call').length, 0);

  const out: string[] = [];
  out.push(`# Handoff: ${oneLine(session.title ?? session.preview ?? session.id, 90)}`);
  out.push('');
  out.push(
    `Source: ${toolLabel(session.tool)} session \`${session.id}\`${session.cwd ? ` in \`${session.cwd}\`` : ''}${session.gitBranch ? ` (branch \`${session.gitBranch}\`)` : ''}.`,
  );
  out.push(`${userTexts.length} user prompts, ${assistantTexts.length} assistant replies, ${toolCount} tool calls.`);
  out.push('');
  out.push('## Original goal');
  out.push('');
  out.push(truncate(userTexts[0] ?? '(no user prompt found)', 1500));
  out.push('');
  if (userTexts.length > 1) {
    out.push('## Later requests');
    out.push('');
    for (const t of userTexts.slice(1).slice(-recent)) out.push(`- ${oneLine(t, 200)}`);
    out.push('');
  }
  if (edited.length || read.length) {
    out.push('## Files');
    out.push('');
    if (edited.length) out.push(`Edited: ${edited.slice(0, 30).map((f) => `\`${f}\``).join(', ')}`);
    if (read.length) out.push(`Read: ${read.slice(0, 30).map((f) => `\`${f}\``).join(', ')}`);
    out.push('');
  }
  out.push('## Where it left off');
  out.push('');
  out.push(truncate(assistantTexts[assistantTexts.length - 1] ?? '(no assistant reply found)', 2500));
  out.push('');
  out.push('## Next step');
  out.push('');
  out.push('Check the current state of the files above (they may have changed), confirm the remaining work with the user, then continue.');
  const text = out.join('\n');
  return options.redact === false ? text : redactText(text).text;
}
