/**
 * Best-effort secret scrubbing. It is deliberately conservative: it targets
 * well-known token shapes and `KEY=value` assignments, and never tries to be
 * clever about arbitrary high-entropy strings (too many false positives in code).
 */

interface Rule {
  name: string;
  pattern: RegExp;
  /** Replacement; `$1` etc. are allowed. */
  replace: string;
}

const RULES: Rule[] = [
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[REDACTED:private-key]',
  },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replace: '[REDACTED:anthropic-key]' },
  { name: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, replace: '[REDACTED:openai-key]' },
  { name: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, replace: '[REDACTED:github-token]' },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: '[REDACTED:aws-access-key]' },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: '[REDACTED:google-api-key]' },
  { name: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: '[REDACTED:slack-token]' },
  { name: 'stripe-key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: '[REDACTED:stripe-key]' },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: '[REDACTED:npm-token]' },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replace: '[REDACTED:jwt]',
  },
  {
    name: 'bearer',
    pattern: /\b(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: '$1[REDACTED:bearer]',
  },
  {
    name: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{3,}(@)/gi,
    replace: '$1[REDACTED:password]$2',
  },
  {
    name: 'env-assignment',
    // FOO_API_KEY=..., SECRET: "...", password = '...'
    pattern:
      /\b([A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[:=]\s*)(["']?)([^\s"'`]{8,})\2/g,
    replace: '$1$2[REDACTED:secret]$2',
  },
];

export interface RedactResult {
  text: string;
  /** Count of replacements per rule name. */
  hits: Record<string, number>;
}

export function redactText(input: string): RedactResult {
  const hits: Record<string, number> = {};
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      if (match.includes('[REDACTED:')) return match;
      hits[rule.name] = (hits[rule.name] ?? 0) + 1;
      // Re-run the single match through String.replace to expand $1..$n.
      return match.replace(new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '')), rule.replace);
    });
  }
  return { text, hits };
}
