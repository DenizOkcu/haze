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
  /** Replacement text; defaults to `[redacted:<kind>]`. */
  replacement?: string;
}

// AWS secret access keys are 40 base64-ish characters, a shape shared with
// SHA-1 digests, so they are only masked next to their access key id: either
// directly (`key = secret`) or behind a short assignment label (`\nLABEL=secret`).
const AWS_PAIR_SEPARATOR = String.raw`(["']?\s*[=:,]?\s*["']?|\s*[A-Za-z0-9_ -]{0,40}[=:] ?)`;
const AWS_SECRET = String.raw`[A-Za-z0-9/+=]{40}`;

const SECRET_PATTERNS: SecretPattern[] = [
  // OpenAI-style API keys (and the many gateways that copy the sk- shape).
  {kind: 'api-key', pattern: /sk-[A-Za-z0-9_-]{16,}/g},
  // GitLab personal access tokens and npm tokens.
  {kind: 'gitlab-token', pattern: /glpat-[A-Za-z0-9_-]{20,}/g},
  {kind: 'npm-token', pattern: /npm_[A-Za-z0-9]{36}/g},
  // AWS access key id + secret access key pairs, in either order. These run
  // before the bare key-id row, which would otherwise break the adjacency.
  {kind: 'aws-secret', pattern: new RegExp(`AKIA[0-9A-Z]{16}${AWS_PAIR_SEPARATOR}(${AWS_SECRET})(?![A-Za-z0-9/+=])`, 'g'), replacement: '[redacted:aws-key]$1[redacted:aws-secret]'},
  {kind: 'aws-secret', pattern: new RegExp(`(?<![A-Za-z0-9/+=])(${AWS_SECRET})${AWS_PAIR_SEPARATOR}AKIA[0-9A-Z]{16}`, 'g'), replacement: '[redacted:aws-secret]$2[redacted:aws-key]'},
  // GitHub personal, OAuth, user-to-server, server-to-server, and refresh tokens.
  {kind: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g},
  // AWS access key IDs.
  {kind: 'aws-key', pattern: /AKIA[0-9A-Z]{16}/g},
  // Slack tokens (bot, app, refresh, user tokens).
  {kind: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g},
  // JWTs (three base64url segments starting with a JSON header). Per-segment
  // minimums cut false positives on short token-shaped strings while still
  // matching real JWTs, whose segments are far longer than this.
  {kind: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g},
  // Opaque bearer credentials; JWT bearers were already masked by the row above.
  {kind: 'bearer-token', pattern: /Bearer [A-Za-z0-9._~+/=-]{20,}/gi},
  // GitHub fine-grained / long-lived personal access tokens (github_pat_ prefix).
  {kind: 'github-token', pattern: /github_pat_[A-Za-z0-9_]{20,}/g},
  // GCP API keys (AIza prefix).
  {kind: 'gcp-api-key', pattern: /AIza[0-9A-Za-z_-]{30,}/g},
  // Google OAuth client secrets (GOCSPX prefix).
  {kind: 'oauth-client-secret', pattern: /GOCSPX-[A-Za-z0-9_-]{20,}/g},
  // Stripe secret keys (sk_live_ / sk_test_) and restricted keys (rk_live_ / rk_test_).
  {kind: 'stripe-key', pattern: /sk_(?:live|test)_[A-Za-z0-9]{16,}/g},
  {kind: 'stripe-key', pattern: /rk_(live|test)_[A-Za-z0-9]{20,}/g},
];

/** Replace common secret token shapes in a string with `[redacted:<kind>]`. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const {kind, pattern, replacement} of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement ?? `[redacted:${kind}]`);
  }
  return result;
}

/** URLs with embedded credentials (`scheme://user:password@host`, user may be empty) are secrets whatever the variable is called (SEC-02). */
const CREDENTIAL_URL_PATTERN = /\/\/[^\s/?#]*:[^\s@/?#]+@/;

/** True when `value` has a known token shape (the same list as `redactSecrets`) or is a URL with embedded credentials (SEC-02). */
export function looksLikeSecret(value: string): boolean {
  return CREDENTIAL_URL_PATTERN.test(value) || redactSecrets(value) !== value;
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
