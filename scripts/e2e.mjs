#!/usr/bin/env node
/**
 * End-to-end compatibility check against the real CLIs.
 *
 * For each target tool it converts the fixture sessions with sessport, then asks
 * the real tool to resume them. Model APIs are replaced by local mock servers, so
 * no credentials are needed and nothing leaves the machine. A target passes when
 * the tool sends the imported history to the (mock) model.
 *
 *   npm run build && node scripts/e2e.mjs
 *
 * Each target is skipped when its tool is missing: `claude` and `codex` on PATH,
 * and the `@google/gemini-cli-core` package resolvable from this directory.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { resolveSession, convertSession } = await import(join(root, 'dist/index.js'));
const fixtures = join(root, 'test/fixtures');
const homes = { claude: join(fixtures, 'claude-home'), codex: join(fixtures, 'codex-home'), gemini: join(fixtures, 'gemini-home') };
const MARKER = '[sessport] This conversation was imported';
const results = [];

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n')[0].trim() : undefined;
}

/** Async spawn: the mock servers live in this process, so the event loop must stay free. */
function run(bin, args, options) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 120_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/** Starts a mock HTTP server and records request bodies. */
function mock(handler) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      bodies.push(body);
      handler(req, body, res);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, bodies, close: () => server.close() })),
  );
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}

async function convertFrom(from, to, home, cwd) {
  const session = await resolveSession(`${from}:latest`, { homes });
  return convertSession(session, { to, homes: { ...homes, [to]: home }, cwd });
}

const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
const PROMPT = 'Summarize the task in five words.';

// ---- Codex CLI --------------------------------------------------------------
async function checkCodex() {
  const bin = which('codex');
  if (!bin) return results.push(['* -> codex', 'skip', 'codex not on PATH']);
  const version = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim();
  const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
  const server = await mock((req, _body, res) => {
    if (!req.url.includes('/responses')) return res.writeHead(404).end('{}');
    const item = { type: 'message', role: 'assistant', id: 'msg_1', status: 'completed', content: [{ type: 'output_text', text: 'MOCK_OK', annotations: [] }] };
    sse(res, [
      ['response.created', { response: { id: 'resp_1' } }],
      ['response.output_item.done', { output_index: 0, item }],
      ['response.completed', { response: { id: 'resp_1', output: [item], usage } }],
    ]);
  });
  try {
    for (const from of ['claude', 'gemini']) {
      const home = tmp('sessport-codex-');
      writeFileSync(
        join(home, 'config.toml'),
        [
          'model_provider = "mock"',
          'model = "gpt-5.5"',
          '[model_providers.mock]',
          'name = "mock"',
          `base_url = "http://127.0.0.1:${server.port}/v1"`,
          'wire_api = "responses"',
          'env_key = "SESSPORT_MOCK_KEY"',
          '',
        ].join('\n'),
      );
      const cwd = tmp('sessport-proj-');
      const r = await convertFrom(from, 'codex', home, cwd);
      server.bodies.length = 0;
      const res = await run(bin, ['exec', '--skip-git-repo-check', 'resume', r.id, PROMPT], {
        cwd,
        env: { ...env, CODEX_HOME: home, SESSPORT_MOCK_KEY: 'test' },
        timeout: 120_000,
      });
      const ok = res.status === 0 && server.bodies.join('\n').includes(MARKER);
      results.push([`${from} -> codex`, ok ? 'pass' : 'FAIL', ok ? version : `exit ${res.status}: ${res.stderr.slice(-400)}`]);
    }
  } finally {
    server.close();
  }
}

// ---- Claude Code ------------------------------------------------------------
async function checkClaude() {
  const bin = which('claude');
  if (!bin) return results.push(['* -> claude', 'skip', 'claude not on PATH']);
  const version = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim();
  const server = await mock((req, body, res) => {
    const json = (s) => res.writeHead(200, { 'content-type': 'application/json' }).end(s);
    if (!req.url.startsWith('/v1/messages')) return json('{}');
    if (req.url.includes('count_tokens')) return json('{"input_tokens":1}');
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      // ignore
    }
    const msg = { id: 'msg_1', type: 'message', role: 'assistant', model: parsed.model ?? 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!parsed.stream) return json(JSON.stringify({ ...msg, content: [{ type: 'text', text: 'MOCK_OK' }], stop_reason: 'end_turn' }));
    sse(res, [
      ['message_start', { message: msg }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'MOCK_OK' } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
      ['message_stop', {}],
    ]);
  });
  try {
    for (const from of ['codex', 'gemini']) {
      const home = tmp('sessport-claude-');
      const cwd = tmp('sessport-proj-');
      const r = await convertFrom(from, 'claude', home, cwd);
      server.bodies.length = 0;
      const res = await run(bin, ['-p', '--resume', r.id, PROMPT], {
        cwd,
        env: {
          ...env,
          CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
          ANTHROPIC_API_KEY: 'sk-ant-sessport-mock',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        timeout: 120_000,
      });
      const ok = res.status === 0 && server.bodies.join('\n').includes(MARKER);
      results.push([`${from} -> claude`, ok ? 'pass' : 'FAIL', ok ? version : `exit ${res.status}: ${res.stderr.slice(-400)}`]);
    }
  } finally {
    server.close();
  }
}

// ---- Gemini CLI (runs the CLI's own session loader) --------------------------
async function checkGemini() {
  let core;
  let utils;
  try {
    core = await import('@google/gemini-cli-core/dist/src/services/chatRecordingService.js');
    utils = await import('@google/gemini-cli-core/dist/src/utils/sessionUtils.js');
  } catch {
    return results.push(['* -> gemini', 'skip', '@google/gemini-cli-core not installed']);
  }
  for (const from of ['claude', 'codex']) {
    const home = tmp('sessport-gemini-');
    const r = await convertFrom(from, 'gemini', home, tmp('sessport-proj-'));
    const record = await core.loadConversationRecord(r.path);
    const meta = await core.loadConversationRecord(r.path, { metadataOnly: true });
    const history = record ? utils.convertSessionToClientHistory(record.messages) : [];
    const ok =
      record?.sessionId === r.id &&
      meta?.hasResumableContent === true &&
      history.length > 1 &&
      String(history[0]?.content.parts?.[0]?.text).startsWith(MARKER);
    results.push([`${from} -> gemini`, ok ? 'pass' : 'FAIL', ok ? `${history.length} turns loaded` : String(JSON.stringify(record)).slice(0, 300)]);
  }
}

await checkCodex();
await checkClaude();
await checkGemini();

for (const [name, status, detail] of results) console.log(`${status.padEnd(5)} ${name.padEnd(18)} ${detail}`);
if (results.some(([, s]) => s === 'FAIL')) process.exit(1);
