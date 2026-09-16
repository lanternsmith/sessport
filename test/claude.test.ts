import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { claudeAdapter, encodeClaudeProjectDir, renderClaudeSession } from '../src/adapters/claude.js';
import { CLAUDE_FILE, CLAUDE_HOME, tempDir } from './helpers.js';
import type { Session } from '../src/model.js';

describe('claude adapter: read', () => {
  it('parses the active chain, merges content blocks, and skips meta, sidechain and rewound lines', async () => {
    const s = await claudeAdapter.read(CLAUDE_FILE);
    expect(s.id).toBe('11111111-2222-4333-8444-555555555555');
    expect(s.cwd).toBe('/Users/dev/app');
    expect(s.title).toBe('Fix failing login test');
    expect(s.gitBranch).toBe('main');
    expect(s.model).toBe('claude-sonnet-4-5');
    expect(s.sourceVersion).toBe('2.1.200');

    const flat = JSON.stringify(s.messages);
    expect(flat).not.toContain('ABANDONED BRANCH');
    expect(flat).not.toContain('SIDECHAIN');
    expect(flat).not.toContain('injected context');

    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    const first = s.messages[1]!;
    expect(first.parts.map((p) => p.type)).toEqual(['thinking', 'text', 'tool_call']);
    expect(s.messages[2]!.parts[0]).toMatchObject({ type: 'tool_result', callId: 'toolu_1' });
    expect(s.messages[4]!.parts[0]).toMatchObject({ type: 'tool_result', output: 'File updated' });
    expect(s.preview).toBe('Fix the failing login test in src/auth.ts');
  });

  it('lists only top-level session files', async () => {
    const list = await claudeAdapter.list(CLAUDE_HOME);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ tool: 'claude', cwd: '/Users/dev/app', title: 'Fix failing login test' });
  });
});

describe('claude adapter: write', () => {
  const session: Session = {
    tool: 'codex',
    id: 'src-1',
    path: '/x',
    cwd: '/Users/dev/My Project',
    title: 'Demo',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'shell', input: { cmd: 'ls' } }] },
      { role: 'user', parts: [{ type: 'tool_result', callId: 'c1', output: 'a.txt' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
    ],
  };

  it('encodes the project directory like Claude Code', () => {
    expect(encodeClaudeProjectDir('/Users/dev/My Project')).toBe('-Users-dev-My-Project');
    expect(encodeClaudeProjectDir('C:\\code\\app')).toBe('C--code-app');
  });

  it('renders a valid parentUuid chain with alternating roles', () => {
    const r = renderClaudeSession(session, { home: '/h', cwd: '/Users/dev/My Project', id: 'abc' });
    expect(r.path).toBe('/h/projects/-Users-dev-My-Project/abc.jsonl');
    expect(r.resumeCommand).toBe("cd '/Users/dev/My Project' && claude --resume abc");
    const lines = r.contents.trim().split('\n').map((l) => JSON.parse(l));
    const convo = lines.filter((l) => l.type === 'user' || l.type === 'assistant');
    expect(convo[0].parentUuid).toBeNull();
    for (let i = 1; i < convo.length; i++) {
      expect(convo[i].parentUuid).toBe(convo[i - 1].uuid);
      expect(convo[i].type).not.toBe(convo[i - 1].type);
      expect(convo[i].timestamp > convo[i - 1].timestamp).toBe(true);
    }
    expect(convo[0].type).toBe('user');
    expect(convo.every((l) => l.sessionId === 'abc' && l.cwd === '/Users/dev/My Project')).toBe(true);
    const assistant = convo.find((l) => l.type === 'assistant');
    expect(assistant.message.content[0].type).toBe('text');
    expect(assistant.message.content[0].text).toContain('<tool_call name="shell"');
    expect(lines.at(-1)).toMatchObject({ type: 'ai-title', sessionId: 'abc' });
  });

  it('round-trips through its own reader', async () => {
    const home = await tempDir();
    const r = await claudeAdapter.write(session, { home, cwd: '/tmp/proj' });
    const back = await claudeAdapter.read(r.path);
    expect(back.id).toBe(r.id);
    expect(back.cwd).toBe('/tmp/proj');
    expect(back.messages.at(-1)!.parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('done') });
    const listed = await claudeAdapter.list(home);
    expect(listed.map((x) => x.id)).toContain(r.id);
    // refuses to overwrite
    await expect(claudeAdapter.write(session, { home, cwd: '/tmp/proj', id: r.id })).rejects.toThrow();
    expect((await readFile(r.path, 'utf8')).length).toBeGreaterThan(0);
  });
});
