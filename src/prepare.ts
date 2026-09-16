import type { Message, Part, Session } from './model.js';
import { stringifyInput, truncate } from './util.js';
import { redactText } from './redact.js';

export interface PrepareOptions {
  /** Max characters kept from each tool output (0 = unlimited). */
  maxToolOutput?: number;
  /** Keep only the last N messages (0 = all). */
  lastMessages?: number;
  /** Drop thinking blocks (default true: they are tool-specific and often signed). */
  dropThinking?: boolean;
  /** Scrub likely secrets from all text (default true). */
  redact?: boolean;
  /** Tool name of the target, used in the preamble. */
  targetName: string;
}

export interface PreparedMessage {
  role: Message['role'];
  timestamp?: string;
  model?: string;
  text: string;
}

/**
 * Turns a session into plain alternating user/assistant text turns that any
 * target tool accepts.
 *
 * Tool calls are rendered as text on purpose: each CLI has its own tool set,
 * and replaying a foreign tool call as a native one makes model APIs reject
 * the history. Text keeps everything the model needs to continue.
 */
export function prepareMessages(session: Session, options: PrepareOptions): PreparedMessage[] {
  const maxOut = options.maxToolOutput ?? 4000;
  const dropThinking = options.dropThinking ?? true;
  const redact = options.redact ?? true;
  const clean = (s: string): string => (redact ? redactText(s).text : s);

  let messages = session.messages;
  if (options.lastMessages && options.lastMessages > 0 && messages.length > options.lastMessages) {
    messages = messages.slice(-options.lastMessages);
  }

  const rendered: PreparedMessage[] = [];
  for (const message of messages) {
    const chunks: string[] = [];
    for (const part of message.parts) {
      const chunk = renderPart(part, maxOut, dropThinking);
      if (chunk) chunks.push(chunk);
    }
    const text = clean(chunks.join('\n\n')).trim();
    if (!text) continue;
    rendered.push({ role: message.role, timestamp: message.timestamp, model: message.model, text });
  }

  const preamble: PreparedMessage = {
    role: 'user',
    timestamp: rendered[0]?.timestamp ?? session.startedAt,
    text: [
      `[sessport] This conversation was imported from ${toolLabel(session.tool)} into ${options.targetName}.`,
      `Original session: ${session.id}${session.cwd ? ` (cwd: ${session.cwd})` : ''}.`,
      'Tool calls and their results from the original session are shown as plain text; they were already executed there.',
      'Use your own tools from here on, and re-check files before editing because they may have changed.',
    ].join('\n'),
  };

  // Merge consecutive messages with the same role so the history alternates.
  const merged: PreparedMessage[] = [];
  for (const m of [preamble, ...rendered]) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.text = `${last.text}\n\n${m.text}`;
      last.model = last.model ?? m.model;
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}

function renderPart(part: Part, maxOut: number, dropThinking: boolean): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'thinking':
      return dropThinking || !part.text.trim() ? '' : `<previous_thinking>\n${part.text}\n</previous_thinking>`;
    case 'tool_call':
      return `<tool_call name="${part.name}" id="${part.id}">\n${truncate(stringifyInput(part.input), maxOut)}\n</tool_call>`;
    case 'tool_result':
      return `<tool_result for="${part.callId}"${part.isError ? ' error="true"' : ''}>\n${truncate(part.output, maxOut)}\n</tool_result>`;
    case 'image':
      return `[image omitted: ${part.note}]`;
  }
}

export function toolLabel(tool: string): string {
  switch (tool) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex CLI';
    case 'gemini':
      return 'Gemini CLI';
    default:
      return tool;
  }
}
