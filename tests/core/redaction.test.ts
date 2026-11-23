import {describe, expect, it} from 'vitest';
import {redactSecrets, redactUnknown} from '../../src/core/safety/redaction.js';

describe('redactSecrets', () => {
  it('masks OpenAI-style API keys', () => {
    expect(redactSecrets('key sk-abcdef0123456789abcdef used')).toBe('key [redacted:api-key] used');
  });

  it('masks GitHub personal access and OAuth tokens', () => {
    expect(redactSecrets('ghp_' + 'a1B2c3D4e5F6g7H8i9J0'.repeat(1) + 'extra')).toBe('[redacted:github-token]');
    expect(redactSecrets('token gho_1234567890abcdefghij here')).toBe('token [redacted:github-token] here');
  });

  it('masks AWS access key IDs and Slack tokens', () => {
    expect(redactSecrets('aws AKIAIOSFODNN7EXAMPLE key')).toBe('aws [redacted:aws-key] key');
    expect(redactSecrets('xoxb-1234567890abcdef bot')).toBe('[redacted:slack-token] bot');
    expect(redactSecrets('xoxp-abcdefghij user')).toBe('[redacted:slack-token] user');
  });

  it('masks JWTs (three base64url segments)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactSecrets(`Authorization: Bearer ${jwt}`)).toBe('Authorization: Bearer [redacted:jwt]');
  });

  it('masks GCP, GitHub fine-grained, OAuth client and Stripe restricted keys', () => {
    // Literal tokens split across concatenation so scanners don't flag test fixtures.
    expect(redactSecrets('gcp AIzaSy' + 'A1234567890abcdefghijklmnopqrstuvwx end')).toBe('gcp [redacted:gcp-api-key] end');
    expect(redactSecrets('pat github_pat_11' + 'ABCDEFGHijklmnopqrstuv end')).toBe('pat [redacted:github-token] end');
    expect(redactSecrets('secret GOCSPX-AbCdEf' + 'GhIjKlMnOpQrStUv end')).toBe('secret [redacted:oauth-client-secret] end');
    expect(redactSecrets('key rk_live_' + '1234567890abcdefghijklmnop done')).toBe('key [redacted:stripe-key] done');
  });

  it('masks GitLab, npm, opaque Bearer and AWS secret keys (SEC-09)', () => {
    expect(redactSecrets('git glpat-' + 'A1b2C3d4E5f6G7h8I9j0 end')).toBe('git [redacted:gitlab-token] end');
    expect(redactSecrets('npm_' + 'a1b2c3d4e5f60718' + '293a4b5c6d7e8f9a0123 end')).toBe('[redacted:npm-token] end');
    expect(redactSecrets('Authorization: Bearer ' + 'Qm9ndXNTb3BhcXVlVG9rZW4xMjM0NTY')).toBe('Authorization: [redacted:bearer-token]');
    // AWS secret access keys are only recognizable next to their access key id, in either order.
    expect(redactSecrets('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE AWS_SECRET_ACCESS_KEY=wJalr' + 'XUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toBe('AWS_ACCESS_KEY_ID=[redacted:aws-key] AWS_SECRET_ACCESS_KEY=[redacted:aws-secret]');
    expect(redactSecrets('aws_secret_access_key = wJalr' + 'XUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws_access_key_id = AKIAIOSFODNN7EXAMPLE'))
      .toBe('aws_secret_access_key = [redacted:aws-secret] aws_access_key_id = [redacted:aws-key]');
    // A bare 40-character run (e.g. a SHA-1 digest) is not treated as a secret.
    expect(redactSecrets('commit 35b3d8e7e3d6e5d8b5b1f0a9c8e2d1f0a9b8c7d6')).toBe('commit 35b3d8e7e3d6e5d8b5b1f0a9c8e2d1f0a9b8c7d6');
  });

  it('leaves short or ordinary text untouched', () => {
    expect(redactSecrets('sk-short')).toBe('sk-short');
    expect(redactSecrets('the ski trip costs 250')).toBe('the ski trip costs 250');
    expect(redactSecrets('AKIA123')).toBe('AKIA123');
    expect(redactSecrets('')).toBe('');
  });
});

describe('redactUnknown', () => {
  it('redacts strings nested in objects and arrays', () => {
    const value = {
      system: 'prompt with sk-abcdef0123456789abcdef',
      messages: [
        {role: 'user', content: [{type: 'text', text: 'ghp_1234567890abcdefghij'}]},
        {role: 'tool', content: 'clean'},
      ],
      meta: {count: 3, flag: true, none: null},
    };
    const redacted = redactUnknown(value) as typeof value;
    expect(redacted.system).toBe('prompt with [redacted:api-key]');
    expect((redacted.messages[0]!.content[0] as {text: string}).text).toBe('[redacted:github-token]');
    expect(redacted.messages[1]!.content).toBe('clean');
    expect(redacted.meta).toEqual(value.meta);
  });

  it('passes primitives through and survives circular structures', () => {
    expect(redactUnknown(42)).toBe(42);
    expect(redactUnknown(undefined)).toBeUndefined();
    const circular: Record<string, unknown> = {text: 'sk-abcdef0123456789abcdef'};
    circular.self = circular;
    const redacted = redactUnknown(circular) as {text: string; self: unknown};
    expect(redacted.text).toBe('[redacted:api-key]');
    expect(redacted.self).toBe('[Circular]');
  });
});
