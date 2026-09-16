import { utimesSync } from 'node:fs';
import { mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const CLAUDE_HOME = join(FIXTURES, 'claude-home');
export const CODEX_HOME = join(FIXTURES, 'codex-home');
export const GEMINI_HOME = join(FIXTURES, 'gemini-home');
export const HOMES = { claude: CLAUDE_HOME, codex: CODEX_HOME, gemini: GEMINI_HOME };

export const CLAUDE_FILE = join(CLAUDE_HOME, 'projects/-Users-dev-app/11111111-2222-4333-8444-555555555555.jsonl');
export const CODEX_FILE = join(
  CODEX_HOME,
  'sessions/2026/09/11/rollout-2026-09-11T16-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl',
);
export const GEMINI_FILE = join(GEMINI_HOME, 'tmp/site/chats/session-2026-09-12T02-00-9b1c2d3e.jsonl');

export async function tempDir(prefix = 'sessport-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Copies a fixture home so tests can write into it. */
export async function tempHome(src: string): Promise<string> {
  const dir = await tempDir();
  await cp(src, dir, { recursive: true });
  return dir;
}

// Give fixture files deterministic modification times (git does not keep them).
const MTIMES: Array<[string, string]> = [
  [CLAUDE_FILE, '2026-09-10T10:00:09Z'],
  [CODEX_FILE, '2026-09-11T08:05:30Z'],
  [join(CODEX_HOME, 'sessions/2025/06/01/rollout-2025-06-01T10-00-00-5973b6c0-94b8-487b-a530-2aeb6098ae0e.jsonl'), '2025-06-01T10:00:00Z'],
  [GEMINI_FILE, '2026-09-12T02:00:09Z'],
  [
    join(GEMINI_HOME, 'tmp/6ea74118923466ac6bf7b4b3437ea6c9212adc6ccf5b0940e82efec52d1b46f9/chats/session-2025-10-01T09-00-aaaabbbb.json'),
    '2025-10-01T09:10:00Z',
  ],
];
for (const [file, iso] of MTIMES) {
  const t = new Date(iso);
  utimesSync(file, t, t);
}
