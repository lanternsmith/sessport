import { getAdapter } from './adapters/index.js';
import type { Session, ToolId, WriteResult } from './model.js';
import type { PrepareOptions } from './prepare.js';
import { homeFor, type Homes } from './discover.js';

export interface ConvertOptions {
  to: ToolId;
  /** Directory the converted session belongs to; defaults to the source cwd, then process.cwd(). */
  cwd?: string;
  homes?: Homes;
  dryRun?: boolean;
  id?: string;
  now?: Date;
  prepare?: Omit<PrepareOptions, 'targetName'>;
}

export async function convertSession(session: Session, options: ConvertOptions): Promise<WriteResult> {
  const adapter = getAdapter(options.to);
  const cwd = options.cwd ?? session.cwd ?? process.cwd();
  const writeOptions = {
    home: homeFor(adapter.id, options.homes),
    cwd,
    id: options.id,
    now: options.now,
    dryRun: options.dryRun,
    prepare: options.prepare,
  };
  return adapter.write(session, writeOptions);
}
