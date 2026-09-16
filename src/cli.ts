#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { adapters, normalizeTool } from './adapters/index.js';
import { convertSession } from './convert.js';
import { homeFor, listSessions, resolveSession, type Homes } from './discover.js';
import { toHandoff } from './handoff.js';
import { toMarkdown } from './markdown.js';
import { TOOL_IDS, type ToolId } from './model.js';
import { toolLabel } from './prepare.js';
import { searchSessions } from './search.js';
import { oneLine } from './util.js';

const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint(2);
const bold = paint(1);
const cyan = paint(36);
const green = paint(32);
const yellow = paint(33);
const TOOL_COLOR: Record<ToolId, (s: string) => string> = { claude: paint(35), codex: paint(32), gemini: paint(34) };

const HELP = `${bold('sessport')} ${VERSION} — move AI coding sessions between Claude Code, Codex CLI and Gemini CLI

${bold('Usage')}
  sessport list      [--tool <t>] [--here | --cwd <dir>] [-n <count>] [--json]
  sessport show      <session>            Print a session as Markdown
  sessport export    <session> [--format md|json|handoff] [-o <file>]
  sessport handoff   <session>            Print a compact briefing for another agent
  sessport convert   <session> --to <t>   Write a natively resumable copy for another tool
  sessport search    <query> [--regex] [--tool <t>] [--here]
  sessport doctor                         Show where sessport looks for sessions

${bold('<session>')} is a file path, a session id (prefix ok), ${cyan('latest')}, or ${cyan('<tool>:latest')} / ${cyan('<tool>:<id>')}.
${bold('<t>')} is one of: claude, codex, gemini.

${bold('Convert options')}
  --to <t>             Target tool (required)
  --cwd <dir>          Project directory for the new session (default: the source session's)
  --last <n>           Keep only the last n messages
  --max-output <n>     Truncate each tool output to n characters (default 4000, 0 = no limit)
  --keep-thinking      Include reasoning blocks as text
  --no-redact          Do not scrub API keys and other secrets
  --dry-run            Show what would be written without writing anything

${bold('Common options')}
  --from <t>           Source tool, when a path is ambiguous
  --claude-home, --codex-home, --gemini-home <dir>   Override config directories
  --json               Machine-readable output (list, search, convert)
  -h, --help           Show help      -v, --version   Show version

${bold('Examples')}
  sessport list --here
  sessport convert claude:latest --to codex
  sessport handoff codex:latest > HANDOFF.md
`;

function fail(message: string): never {
  process.stderr.write(`${yellow('error')} ${message}\n`);
  process.exit(1);
}

function asTool(value: string | undefined, flag: string): ToolId | undefined {
  if (value === undefined) return undefined;
  const t = normalizeTool(value);
  if (!(TOOL_IDS as readonly string[]).includes(t)) fail(`${flag} must be one of: ${TOOL_IDS.join(', ')} (got "${value}")`);
  return t as ToolId;
}

function asInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`${flag} must be a non-negative integer`);
  return n;
}

function relTime(iso: string | undefined): string {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return '';
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function shortPath(p: string | undefined): string {
  if (!p) return '';
  const home = process.env.HOME;
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      tool: { type: 'string', short: 't' },
      from: { type: 'string' },
      to: { type: 'string' },
      here: { type: 'boolean' },
      cwd: { type: 'string' },
      n: { type: 'string', short: 'n' },
      format: { type: 'string', short: 'f' },
      output: { type: 'string', short: 'o' },
      last: { type: 'string' },
      'max-output': { type: 'string' },
      'keep-thinking': { type: 'boolean' },
      thinking: { type: 'boolean' },
      'no-tools': { type: 'boolean' },
      'no-redact': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      regex: { type: 'boolean' },
      'case-sensitive': { type: 'boolean' },
      'claude-home': { type: 'string' },
      'codex-home': { type: 'string' },
      'gemini-home': { type: 'string' },
    },
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const [command, ...rest] = positionals;
  if (values.help || !command || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  const homes: Homes = {
    claude: values['claude-home'],
    codex: values['codex-home'],
    gemini: values['gemini-home'],
  };
  const cwdFilter = values.here ? process.cwd() : command === 'convert' ? undefined : values.cwd;
  const redact = !values['no-redact'];

  switch (command) {
    case 'list':
    case 'ls': {
      const tool = asTool(values.tool, '--tool');
      const limit = asInt(values.n, '-n') ?? 20;
      const sessions = (await listSessions({ tools: tool ? [tool] : undefined, homes, cwd: cwdFilter })).slice(0, limit || undefined);
      if (values.json) {
        process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
        return;
      }
      if (!sessions.length) {
        process.stdout.write('No sessions found. Run `sessport doctor` to check the search locations.\n');
        return;
      }
      for (const s of sessions) {
        const label = TOOL_COLOR[s.tool](s.tool.padEnd(6));
        const title = oneLine(s.title ?? s.preview ?? '(untitled)', 60);
        process.stdout.write(`${label} ${cyan(s.id.slice(0, 8))}  ${relTime(s.updatedAt).padEnd(9)} ${title}\n`);
        process.stdout.write(`${' '.repeat(16)}${dim(shortPath(s.cwd) || '(no directory recorded)')}\n`);
      }
      process.stdout.write(dim(`\n${sessions.length} session(s). Use an id prefix, e.g. \`sessport show ${sessions[0]!.id.slice(0, 8)}\`.\n`));
      return;
    }

    case 'show':
    case 'export':
    case 'handoff': {
      const ref = rest[0] ?? fail(`usage: sessport ${command} <session>`);
      const session = await resolveSession(ref, { tool: asTool(values.from, '--from'), homes, cwd: cwdFilter });
      const format = command === 'handoff' ? 'handoff' : command === 'show' ? 'md' : (values.format ?? 'md');
      let text: string;
      if (format === 'md' || format === 'markdown') {
        text = toMarkdown(session, {
          includeThinking: values.thinking || values['keep-thinking'],
          includeTools: !values['no-tools'],
          maxToolOutput: asInt(values['max-output'], '--max-output'),
          redact,
        });
      } else if (format === 'json') {
        text = JSON.stringify(session, null, 2);
      } else if (format === 'handoff') {
        text = toHandoff(session, { redact });
      } else {
        fail('--format must be md, json or handoff');
      }
      if (values.output) {
        await writeFile(values.output, `${text}\n`, 'utf8');
        process.stderr.write(`${green('✓')} wrote ${values.output}\n`);
      } else {
        process.stdout.write(`${text}\n`);
      }
      return;
    }

    case 'convert': {
      const ref = rest[0] ?? fail('usage: sessport convert <session> --to <tool>');
      const to = asTool(values.to, '--to') ?? fail('--to is required (claude, codex or gemini)');
      const session = await resolveSession(ref, { tool: asTool(values.from, '--from'), homes });
      if (session.tool === to) fail(`That session already belongs to ${toolLabel(to)}. Resume it there directly.`);
      if (!session.messages.length) fail('The session has no messages to convert.');
      const result = await convertSession(session, {
        to,
        cwd: values.cwd,
        homes,
        dryRun: values['dry-run'],
        prepare: {
          lastMessages: asInt(values.last, '--last'),
          maxToolOutput: asInt(values['max-output'], '--max-output'),
          dropThinking: !values['keep-thinking'],
          redact,
        },
      });
      if (values.json) {
        const { contents, ...meta } = result;
        process.stdout.write(`${JSON.stringify({ ...meta, bytes: Buffer.byteLength(contents), dryRun: !!values['dry-run'] }, null, 2)}\n`);
        return;
      }
      const verb = values['dry-run'] ? 'Would write' : 'Wrote';
      process.stdout.write(
        `${green('✓')} ${verb} ${toolLabel(to)} session ${cyan(result.id)}\n` +
          `  from ${toolLabel(session.tool)} ${session.id} (${session.messages.length} messages)\n` +
          `  ${dim(shortPath(result.path))}\n`,
      );
      for (const extra of result.sideEffects) process.stdout.write(`  ${dim(shortPath(extra))}\n`);
      process.stdout.write(`\nResume it with:\n  ${bold(result.resumeCommand)}\n`);
      const targetCwd = values.cwd ?? session.cwd;
      if (targetCwd && !existsSync(targetCwd)) {
        process.stdout.write(yellow(`\nNote: ${targetCwd} does not exist on this machine. Pass --cwd <dir> to attach the session to another directory.\n`));
      }
      if (!session.cwd && !values.cwd) {
        process.stdout.write(dim(`\nNote: the source session had no directory, so ${process.cwd()} was used. Pass --cwd to change it.\n`));
      }
      return;
    }

    case 'search':
    case 'grep': {
      const query = rest.join(' ') || fail('usage: sessport search <query>');
      const tool = asTool(values.tool, '--tool');
      const hits = await searchSessions(query, {
        tools: tool ? [tool] : undefined,
        homes,
        cwd: cwdFilter,
        regex: values.regex,
        ignoreCase: !values['case-sensitive'],
        limit: asInt(values.n, '-n') ?? 30,
      });
      if (values.json) {
        process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
        return;
      }
      if (!hits.length) {
        process.stdout.write('No matches.\n');
        return;
      }
      for (const h of hits) {
        process.stdout.write(
          `${TOOL_COLOR[h.session.tool](h.session.tool.padEnd(6))} ${cyan(h.session.id.slice(0, 8))} ${dim(h.role.padEnd(9))} ${h.snippet}\n`,
        );
      }
      return;
    }

    case 'doctor': {
      process.stdout.write(`${bold('sessport')} ${VERSION} on Node.js ${process.version}\n\n`);
      for (const tool of TOOL_IDS) {
        const home = homeFor(tool, homes);
        const found = existsSync(home);
        const count = found ? (await adapters[tool].list(home)).length : 0;
        process.stdout.write(
          `${found ? green('✓') : yellow('–')} ${toolLabel(tool).padEnd(12)} ${shortPath(home).padEnd(28)} ${found ? `${count} session(s)` : dim('not found')}\n`,
        );
      }
      process.stdout.write(dim('\nOverride locations with --claude-home / --codex-home / --gemini-home, CLAUDE_CONFIG_DIR or CODEX_HOME.\n'));
      return;
    }

    default:
      fail(`unknown command "${command}". Run \`sessport --help\`.`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
