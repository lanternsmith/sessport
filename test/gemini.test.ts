import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { geminiAdapter, geminiProjectHash } from '../src/adapters/gemini.js';
import { GEMINI_FILE, GEMINI_HOME, tempDir, tempHome } from './helpers.js';
import type { Session } from '../src/model.js';

describe('gemini adapter: read', () => {
  it('replays JSONL updates and rewinds, and splits tool results out', async () => {
    const s = await geminiAdapter.read(GEMINI_FILE);
    expect(s.id).toBe('9b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d');
    expect(s.cwd).toBe('/Users/dev/site');
    expect(s.title).toBe('Responsive hero section');
    expect(s.model).toBe('gemini-3-pro');
    const flat = JSON.stringify(s.messages);
    expect(flat).not.toContain('WRONG PROMPT');
    expect(flat).not.toContain('/stats');
    expect(flat).not.toContain('Model switched');
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant', 'user']);
    expect(s.messages[1]!.parts.map((p) => p.type)).toEqual(['thinking', 'text', 'tool_call']);
    expect(s.messages[2]!.parts[0]).toMatchObject({ type: 'tool_result', output: '.hero { width: 1200px }' });
    expect(s.messages[5]!.parts[0]).toMatchObject({ type: 'tool_result', output: 'OK' });
  });

  it('lists slug and legacy hash directories with their project paths', async () => {
    const list = await geminiAdapter.list(GEMINI_HOME);
    const byId = Object.fromEntries(list.map((s) => [s.id, s]));
    expect(byId['9b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d']?.cwd).toBe('/Users/dev/site');
    expect(byId['aaaabbbb-0000-4000-8000-000000000000']?.cwd).toBe('/Users/dev/old');
    expect(byId['aaaabbbb-0000-4000-8000-000000000000']?.preview).toBe('legacy gemini prompt');
  });
});

describe('gemini adapter: write', () => {
  const session: Session = {
    tool: 'claude',
    id: 'src',
    path: '/x',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'yo' }] },
    ],
  };

  it('reuses a registered project slug', async () => {
    const home = await tempHome(GEMINI_HOME);
    const r = await geminiAdapter.write(session, { home, cwd: '/Users/dev/site', id: '12345678-aaaa-4bbb-8ccc-000000000000' });
    expect(r.path.startsWith(join(home, 'tmp/site/chats/session-'))).toBe(true);
    expect(r.path.endsWith('-12345678.jsonl')).toBe(true);
    expect(r.sideEffects).toEqual([]);
    const lines = (await readFile(r.path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ sessionId: r.id, projectHash: geminiProjectHash('/Users/dev/site'), kind: 'main' });
    expect(lines.slice(1, -1).map((l) => l.type)).toEqual(['user', 'gemini']);
    expect(lines.at(-1).$set.summary).toContain('[claude]');
    const back = await geminiAdapter.read(r.path);
    expect(back.id).toBe(r.id);
    expect(back.cwd).toBe('/Users/dev/site');
  });

  it('registers a new project the way Gemini CLI does', async () => {
    const home = await tempDir();
    const r = await geminiAdapter.write(session, { home, cwd: '/work/My App' });
    expect(r.path).toContain(join(home, 'tmp/my-app/chats/'));
    const registry = JSON.parse(await readFile(join(home, 'projects.json'), 'utf8'));
    expect(registry.projects['/work/My App']).toBe('my-app');
    expect(await readFile(join(home, 'tmp/my-app/.project_root'), 'utf8')).toBe('/work/My App');
    expect(await readFile(join(home, 'history/my-app/.project_root'), 'utf8')).toBe('/work/My App');
    // a second project with the same basename gets a suffixed slug
    const r2 = await geminiAdapter.write(session, { home, cwd: '/other/my-app' });
    expect(r2.path).toContain(join(home, 'tmp/my-app-1/chats/'));
  });

  it('dry run touches nothing', async () => {
    const home = await tempDir();
    const r = await geminiAdapter.write(session, { home, cwd: '/w/x', dryRun: true });
    expect(r.sideEffects[0]).toContain('would register');
    await expect(readFile(join(home, 'projects.json'), 'utf8')).rejects.toThrow();
  });
});
