/**
 * The tool-neutral session model every adapter reads into and writes from.
 */

export type ToolId = 'claude' | 'codex' | 'gemini';

export const TOOL_IDS: readonly ToolId[] = ['claude', 'codex', 'gemini'];

export type Role = 'user' | 'assistant';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ThinkingPart {
  type: 'thinking';
  text: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultPart {
  type: 'tool_result';
  callId: string;
  /** Name of the tool, when the source format records it next to the result. */
  name?: string;
  output: string;
  isError?: boolean;
}

export interface ImagePart {
  type: 'image';
  /** Short human-readable note; image bytes are never copied between tools. */
  note: string;
}

export type Part = TextPart | ThinkingPart | ToolCallPart | ToolResultPart | ImagePart;

export interface Message {
  role: Role;
  timestamp?: string;
  model?: string;
  parts: Part[];
}

export interface SessionSummary {
  tool: ToolId;
  id: string;
  path: string;
  cwd?: string;
  title?: string;
  startedAt?: string;
  updatedAt?: string;
  /** First real user prompt, trimmed for display. */
  preview?: string;
}

export interface Session extends SessionSummary {
  model?: string;
  gitBranch?: string;
  sourceVersion?: string;
  messages: Message[];
}

export interface WriteOptions {
  /** Root of the target tool's config dir (e.g. ~/.codex). */
  home: string;
  /** Working directory the new session should belong to. */
  cwd: string;
  /** Session id to assign; a random UUID is used when omitted. */
  id?: string;
  /** Timestamp used for file names and metadata. */
  now?: Date;
  /** Only compute the result; do not touch the file system. */
  dryRun?: boolean;
}

export interface WriteResult {
  tool: ToolId;
  id: string;
  path: string;
  /** Command the user runs to continue the session. */
  resumeCommand: string;
  /** Raw file contents that were (or would be) written. */
  contents: string;
  /** Extra files the adapter created or updated. */
  sideEffects: string[];
}

export interface Adapter {
  id: ToolId;
  displayName: string;
  defaultHome(): string;
  /** Returns cheap summaries of every session found under `home`. */
  list(home: string): Promise<SessionSummary[]>;
  /** Parses one session file. */
  read(path: string): Promise<Session>;
  /** Writes a session in the tool's native format. */
  write(session: Session, options: WriteOptions): Promise<WriteResult>;
}

export function textOf(message: Message): string {
  return message.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}
