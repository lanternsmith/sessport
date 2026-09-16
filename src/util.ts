import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import * as zlib from 'node:zlib';

export const uuid = (): string => randomUUID();

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Recursively collects files under `root` whose name satisfies `match`. */
export async function walk(root: string, match: (name: string) => boolean, maxDepth = 6): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await visit(full, depth + 1);
      } else if (entry.isFile() && match(entry.name)) {
        out.push(full);
      }
    }
  }
  await visit(root, 0);
  return out;
}

type ZstdZlib = { zstdDecompressSync?: (buf: Buffer) => Buffer };

/** Reads a text file, transparently decompressing `.zst` when Node supports it. */
export async function readText(path: string): Promise<string> {
  const buf = await readFile(path);
  if (path.endsWith('.zst')) {
    const z = zlib as unknown as ZstdZlib;
    if (typeof z.zstdDecompressSync !== 'function') {
      throw new Error(`Reading ${path} needs zstd support (Node.js >= 22.15).`);
    }
    return z.zstdDecompressSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

/** Parses JSONL, skipping blank and malformed lines. */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Tools sometimes leave a half-written last line; ignore it.
    }
  }
  return out;
}

/** Reads only the first `maxLines` JSONL records of a plain file. */
export async function readJsonlHead(path: string, maxLines: number): Promise<unknown[]> {
  if (path.endsWith('.zst')) return parseJsonl(await readText(path)).slice(0, maxLines);
  const out: unknown[] = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        continue;
      }
      if (out.length >= maxLines) break;
    }
  } finally {
    rl.close();
  }
  return out;
}

export async function writeFileSafely(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // 'wx' refuses to overwrite an existing session file.
  await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function truncate(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n… [${omitted} more characters truncated by sessport]`;
}

export function stringifyInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}

/** Latest timestamp wins; tolerates undefined. */
export function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * True for user text that tools inject automatically (system reminders,
 * environment context, slash-command wrappers) rather than typed by a human.
 */
export function isSyntheticUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.length === 0 ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('<environment_context>') ||
    t.startsWith('<user_instructions>') ||
    t.startsWith('<permissions instructions>') ||
    t.startsWith('# AGENTS.md instructions') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<local-command-caveat>') ||
    t.startsWith('<session_context>') ||
    t.startsWith('<hook_context>') ||
    t.startsWith('Caveat: The messages below were generated by the user')
  );
}
