import type { Session } from './model.js';
import { toolLabel } from './prepare.js';
import { redactText } from './redact.js';
import { stringifyInput, truncate } from './util.js';

export interface MarkdownOptions {
  includeThinking?: boolean;
  includeTools?: boolean;
  maxToolOutput?: number;
  redact?: boolean;
}

function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

export function toMarkdown(session: Session, options: MarkdownOptions = {}): string {
  const includeTools = options.includeTools ?? true;
  const maxOut = options.maxToolOutput ?? 2000;
  const out: string[] = [];
  out.push(`# ${session.title ?? session.preview ?? session.id}`);
  out.push('');
  out.push(`| | |\n|---|---|`);
  out.push(`| Tool | ${toolLabel(session.tool)}${session.sourceVersion ? ` ${session.sourceVersion}` : ''} |`);
  out.push(`| Session | \`${session.id}\` |`);
  if (session.cwd) out.push(`| Directory | \`${session.cwd}\` |`);
  if (session.gitBranch) out.push(`| Branch | \`${session.gitBranch}\` |`);
  if (session.model) out.push(`| Model | ${session.model} |`);
  if (session.startedAt) out.push(`| Started | ${session.startedAt} |`);
  if (session.updatedAt) out.push(`| Updated | ${session.updatedAt} |`);
  out.push('');

  for (const message of session.messages) {
    const body: string[] = [];
    for (const part of message.parts) {
      switch (part.type) {
        case 'text':
          body.push(part.text);
          break;
        case 'thinking':
          if (options.includeThinking) body.push(`<details><summary>Thinking</summary>\n\n${part.text}\n\n</details>`);
          break;
        case 'tool_call':
          if (includeTools) body.push(`**Tool call · \`${part.name}\`**\n\n${fence(truncate(stringifyInput(part.input), maxOut), 'json')}`);
          break;
        case 'tool_result':
          if (includeTools)
            body.push(
              `<details><summary>Tool result${part.isError ? ' (error)' : ''}</summary>\n\n${fence(truncate(part.output, maxOut))}\n\n</details>`,
            );
          break;
        case 'image':
          body.push(`_[image: ${part.note}]_`);
          break;
      }
    }
    if (!body.length) continue;
    const onlyResults = message.parts.every((p) => p.type === 'tool_result');
    const heading = message.role === 'user' ? (onlyResults ? '### ↳ Tool output' : '## 🧑 User') : '## 🤖 Assistant';
    out.push(heading);
    out.push('');
    out.push(body.join('\n\n'));
    out.push('');
  }
  const md = out.join('\n');
  return options.redact === false ? md : redactText(md).text;
}
