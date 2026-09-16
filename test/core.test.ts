import { describe, expect, it } from 'vitest';
import { prepareMessages } from '../src/prepare.js';
import { redactText } from '../src/redact.js';
import { toMarkdown } from '../src/markdown.js';
import { toHandoff, touchedFiles } from '../src/handoff.js';
import { listSessions, resolveSession } from '../src/discover.js';
import { searchSessions } from '../src/search.js';
import { convertSession } from '../src/convert.js';
import { adapters } from '../src/adapters/index.js';
import { CLAUDE_FILE, CODEX_FILE, HOMES, tempDir } from './helpers.js';

describe('redact', () => {
  it.each([
    ['sk-proj-abcdefghijklmnopqrstuvwxyz123456', 'openai-key'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'anthropic-key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github-token'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['AIzaSyA1234567890abcdefghijklmnopqrstuv', 'google-api-key'],
    ['postgres://admin:hunter2secret@db:5432/app', 'url-credentials'],
    ['DATABASE_PASSWORD=correcthorsebattery', 'env-assignment'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'bearer'],
  ])('scrubs %s', (secret, rule) => {
    const { text, hits } = redactText(`before ${secret} after`);
    expect(text).not.toContain(secret);
    expect(text).toContain('before');
    expect(hits[rule]).toBeGreaterThan(0);
  });

  it('keeps ordinary code alone', () => {
    const code = 'const token = getToken();\nfunction skip() { return "sk-short"; }';
    expect(redactText(code).text).toBe(code);
  });
});

describe('prepareMessages', () => {
  it('produces alternating turns that start with a preamble and render tools as text', async () => {
    const s = await adapters.claude.read(CLAUDE_FILE);
    const out = prepareMessages(s, { targetName: 'Codex CLI' });
    expect(out[0]!.role).toBe('user');
    expect(out[0]!.text).toContain('imported from Claude Code into Codex CLI');
    for (let i = 1; i < out.length; i++) expect(out[i]!.role).not.toBe(out[i - 1]!.role);
    const all = out.map((m) => m.text).join('\n');
    expect(all).toContain('<tool_call name="Read"');
    expect(all).toContain('<tool_result for="toolu_1">');
    expect(all).not.toContain('Let me look at the test first'); // thinking dropped by default
    expect(all).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz123456');
  });

  it('honours lastMessages, maxToolOutput, dropThinking and redact=false', async () => {
    const s = await adapters.claude.read(CLAUDE_FILE);
    const out = prepareMessages(s, { targetName: 'X', dropThinking: false, redact: false, maxToolOutput: 10 });
    const all = out.map((m) => m.text).join('\n');
    expect(all).toContain('Let me look at the test first');
    expect(all).toContain('more characters truncated');
    const tail = prepareMessages(s, { targetName: 'X', lastMessages: 2 });
    expect(tail).toHaveLength(2);
    expect(tail[0]!.text).toContain('[sessport]');
    expect(tail[0]!.text).toContain('also add a regression test');
    expect(tail.at(-1)!.text).toBe('Added tests/login.test.ts.');
  });
});

describe('markdown and handoff', () => {
  it('renders markdown with metadata and redaction', async () => {
    const md = toMarkdown(await adapters.claude.read(CLAUDE_FILE));
    expect(md).toContain('# Fix failing login test');
    expect(md).toContain('| Directory | `/Users/dev/app` |');
    expect(md).toContain('## 🧑 User');
    expect(md).toContain('[REDACTED:');
  });

  it('extracts touched files including apply_patch bodies', async () => {
    const codex = await adapters.codex.read(CODEX_FILE);
    expect(touchedFiles(codex).edited).toEqual(['src/routes.ts']);
    const claude = await adapters.claude.read(CLAUDE_FILE);
    expect(touchedFiles(claude)).toEqual({ edited: ['/Users/dev/app/src/auth.ts'], read: [] });
  });

  it('builds a handoff briefing', async () => {
    const h = toHandoff(await adapters.codex.read(CODEX_FILE));
    expect(h).toContain('## Original goal');
    expect(h).toContain('Add pagination to GET /users');
    expect(h).toContain('- Now document it in README');
    expect(h).toContain('README updated.');
  });
});

describe('discovery, search and convert', () => {
  it('lists across tools, newest first, with cwd filter', async () => {
    const all = await listSessions({ homes: HOMES });
    expect(new Set(all.map((s) => s.tool))).toEqual(new Set(['claude', 'codex', 'gemini']));
    const scoped = await listSessions({ homes: HOMES, cwd: '/Users/dev/api' });
    expect(scoped.map((s) => s.tool)).toEqual(['codex']);
  });

  it('resolves ids, prefixes, tool:latest and paths', async () => {
    expect((await resolveSession('11111111', { homes: HOMES })).tool).toBe('claude');
    expect((await resolveSession('codex:latest', { homes: HOMES })).tool).toBe('codex');
    expect((await resolveSession(CODEX_FILE, { homes: HOMES })).id).toBe('0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee');
    await expect(resolveSession('does-not-exist', { homes: HOMES })).rejects.toThrow(/No session found/);
  });

  it('searches message text', async () => {
    const hits = await searchSessions('max-width', { homes: HOMES });
    expect(hits.map((h) => h.session.tool)).toEqual(['gemini']);
    const re = await searchSessions('pagination|regression', { homes: HOMES, regex: true });
    expect(new Set(re.map((h) => h.session.tool))).toEqual(new Set(['codex', 'claude']));
  });

  it.each([
    ['claude', 'codex'],
    ['claude', 'gemini'],
    ['codex', 'claude'],
    ['codex', 'gemini'],
    ['gemini', 'claude'],
    ['gemini', 'codex'],
  ] as const)('converts %s -> %s and the result reads back', async (from, to) => {
    const src = await resolveSession(`${from}:latest`, { homes: HOMES });
    const target = await tempDir();
    const r = await convertSession(src, { to, homes: { [to]: target } });
    const back = await adapters[to].read(r.path);
    expect(back.tool).toBe(to);
    expect(back.id).toBe(r.id);
    expect(back.cwd).toBe(src.cwd);
    const text = JSON.stringify(back.messages);
    expect(text).toContain(`imported from`);
    const lastSrc = src.messages.filter((m) => m.role === 'assistant').at(-1)!;
    const lastText = lastSrc.parts.find((p) => p.type === 'text');
    if (lastText && lastText.type === 'text') expect(text).toContain(JSON.stringify(lastText.text).slice(1, 20));
  });
});
