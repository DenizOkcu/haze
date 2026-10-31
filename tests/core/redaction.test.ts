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
