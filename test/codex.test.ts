import { describe, expect, it } from 'vitest';
import { codexAdapter, renderCodexSession } from '../src/adapters/codex.js';
import { CODEX_FILE, CODEX_HOME, tempDir } from './helpers.js';
import type { Session } from '../src/model.js';

describe('codex adapter: read', () => {
  it('parses current rollouts and ignores instructions, env context and event duplicates', async () => {
    const s = await codexAdapter.read(CODEX_FILE);
    expect(s.id).toBe('0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee');
    expect(s.cwd).toBe('/Users/dev/api');
    expect(s.gitBranch).toBe('feature/x');
    expect(s.model).toBe('gpt-5.5-codex');
    expect(s.sourceVersion).toBe('0.140.0');
    expect(s.preview).toBe('Add pagination to GET /users');

    const flat = JSON.stringify(s.messages);
    expect(flat).not.toContain('AGENTS.md');
    expect(flat).not.toContain('environment_context');
    expect(flat).not.toContain('permissions instructions');

    const roles = s.messages.map((m) => m.role);
    expect(roles[0]).toBe('user');
    const calls = s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_call');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ name: 'exec_command', input: { cmd: 'rg -n "users" src/routes.ts' } });
    const results = s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result');
    expect(results[1]).toMatchObject({ output: expect.stringContaining('Success. Updated') });
    expect(flat).toContain('compacted');
    expect(s.messages.at(-1)!.parts[0]).toMatchObject({ type: 'text', text: 'README updated.' });
  });

  it('reads legacy rollouts and lists both', async () => {
    const list = await codexAdapter.list(CODEX_HOME);
    expect(list.map((x) => x.id).sort()).toEqual(['0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', '5973b6c0-94b8-487b-a530-2aeb6098ae0e']);
    const legacy = list.find((x) => x.id.startsWith('5973'))!;
    const s = await codexAdapter.read(legacy.path);
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('codex adapter: write', () => {
  const session: Session = {
    tool: 'claude',
    id: 'src',
    path: '/x',
    cwd: '/w',
    gitBranch: 'main',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ],
  };

  it('writes the file layout and records `codex resume` can find', () => {
    const now = new Date(2026, 8, 16, 9, 5, 7);
    const r = renderCodexSession(session, { home: '/c', cwd: '/w', id: '0199bbbb-0000-7000-8000-000000000001', now });
    expect(r.path).toBe('/c/sessions/2026/09/16/rollout-2026-09-16T09-05-07-0199bbbb-0000-7000-8000-000000000001.jsonl');
    const lines = r.contents.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      type: 'session_meta',
      payload: { id: r.id, session_id: r.id, cwd: '/w', source: 'cli', git: { branch: 'main' } },
    });
    for (const l of lines) expect(typeof l.timestamp).toBe('string');
    const items = lines.filter((l) => l.type === 'response_item').map((l) => l.payload);
    expect(items[0]).toMatchObject({ type: 'message', role: 'user', content: [{ type: 'input_text' }] });
    expect(items[1]).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] });
    const events = lines.filter((l) => l.type === 'event_msg').map((l) => l.payload.type);
    expect(events).toEqual(['user_message', 'agent_message']);
    expect(r.resumeCommand).toBe(`cd /w && codex resume ${r.id}`);
  });

  it('round-trips through its own reader', async () => {
    const home = await tempDir();
    const r = await codexAdapter.write(session, { home, cwd: '/w' });
    const back = await codexAdapter.read(r.path);
    expect(back.id).toBe(r.id);
    expect(back.cwd).toBe('/w');
    expect(back.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect((await codexAdapter.list(home)).map((x) => x.id)).toEqual([r.id]);
  });
});
