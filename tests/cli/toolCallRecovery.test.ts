import {describe, expect, it} from 'vitest';
import {InvalidToolInputError} from 'ai';
import {isMalformedToolInputError} from '../../src/cli/commands/streaming/toolCallRecovery.js';

describe('isMalformedToolInputError', () => {
  it('recognizes AI SDK JSON and invalid-input wrappers through causes', () => {
    const error = new Error('Invalid input for tool writeFile');
    error.name = 'AI_InvalidToolInputError';
    error.cause = new Error('AI_JSONParseError: JSON parsing failed');
    expect(isMalformedToolInputError(error)).toBe(true);
  });

  it('matches a real InvalidToolInputError instance from the AI SDK', () => {
    // Smoke test: if the SDK ever renames the error class or its message
    // format, this construct will still produce the canonical shape and the
    // regex below must match it. A silent rename otherwise breaks recovery.
    const error = new InvalidToolInputError({toolCallId: 'x', toolName: 'writeFile', input: 'bogus', cause: new SyntaxError('Unexpected token')});
    expect(isMalformedToolInputError(error)).toBe(true);
  });

  it('ignores execution failures with otherwise valid tool input', () => {
    expect(isMalformedToolInputError(new Error('Command exited with code 1'))).toBe(false);
  });
});
