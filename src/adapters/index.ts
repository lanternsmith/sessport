import type { Adapter, ToolId } from '../model.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { geminiAdapter } from './gemini.js';

export const adapters: Record<ToolId, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
};

export function getAdapter(tool: string): Adapter {
  const a = (adapters as Record<string, Adapter | undefined>)[normalizeTool(tool)];
  if (!a) throw new Error(`Unknown tool "${tool}". Use one of: claude, codex, gemini.`);
  return a;
}

export function normalizeTool(tool: string): string {
  const t = tool.toLowerCase();
  if (t === 'claude-code' || t === 'cc') return 'claude';
  if (t === 'codex-cli' || t === 'openai') return 'codex';
  if (t === 'gemini-cli' || t === 'google') return 'gemini';
  return t;
}

export { claudeAdapter, codexAdapter, geminiAdapter };
