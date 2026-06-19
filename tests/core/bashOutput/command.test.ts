import {describe, expect, it} from 'vitest';
import {commandCandidates, commandMatches} from '../../../src/core/bashOutput/command.js';

describe('bash output command normalization', () => {
  it('matches through env assignments and sudo wrappers', () => {
    expect(commandMatches('NODE_ENV=test sudo -n docker ps', /(^|\s)docker\s+ps\b/)).toBe(true);
  });

  it('exposes simple chained command segments', () => {
    const candidates = commandCandidates('echo before && git -C repo status --short | head -20');
    expect(candidates).toContain('git -C repo status --short');
    expect(candidates).toContain('head -20');
  });
});
