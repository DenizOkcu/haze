/**
 * Secret-shape redaction for data-at-rest writes (HZA-7 / HZ-9).
 *
 * Sessions and --debug LLM logs persist conversation content in plaintext
 * (permissions are 0600/0700, but injected instructions can make the shell
 * tool print non-protected credentials, which then live on disk indefinitely).
 * These helpers mask common token shapes before persistence: --debug LLM logs
 * always redact; session files redact only when the `redactSessionSecrets`
 * setting opts in (default off, to keep sessions debuggable).
 */

interface SecretPattern {
  kind: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // OpenAI-style API keys (and the many gateways that copy the sk- shape).
  {kind: 'api-key', pattern: /sk-[A-Za-z0-9_-]{16,}/g},
  // GitHub personal access / OAuth tokens.
  {kind: 'github-token', pattern: /gh[po]_[A-Za-z0-9]{20,}/g},
  // AWS access key IDs.
  {kind: 'aws-key', pattern: /AKIA[0-9A-Z]{16}/g},
  // Slack tokens (bot, app, refresh, user tokens).
  {kind: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g},
  // JWTs (three base64url segments starting with a JSON header).
  {kind: 'jwt', pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g},
];

/** Replace common secret token shapes in a string with `[redacted:<kind>]`. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const {kind, pattern} of SECRET_PATTERNS) {
    result = result.replace(pattern, `[redacted:${kind}]`);
  }
  return result;
}

/**
 * Deep redaction for JSON-serializable values: every nested string is passed
 * through `redactSecrets`. Cycles collapse to a marker (same convention as
 * session slimming); non-string leaves pass through untouched.
 */
export function redactUnknown(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactUnknown(item, seen));
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) next[key] = redactUnknown(child, seen);
  return next;
}
