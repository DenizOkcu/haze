import {describe, expect, it} from 'vitest';
import {isMalformedToolInputError} from '../../src/cli/commands/streaming/toolCallRecovery.js';

describe('isMalformedToolInputError', () => {
  it('recognizes AI SDK JSON and invalid-input wrappers through causes', () => {
    const error = new Error('Invalid input for tool writeFile');
    error.name = 'AI_InvalidToolInputError';
    error.cause = new Error('AI_JSONParseError: JSON parsing failed');
    expect(isMalformedToolInputError(error)).toBe(true);
  });

  it('ignores execution failures with otherwise valid tool input', () => {
    expect(isMalformedToolInputError(new Error('Command exited with code 1'))).toBe(false);
  });
});
