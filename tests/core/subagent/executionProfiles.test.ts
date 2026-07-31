import {describe, expect, it} from 'vitest';
import {BUILT_IN_SUBAGENT_PROFILES, COMPATIBILITY_PROFILE, MODE_TOOL_NAMES, resolveExecutionProfile} from '../../../src/core/subagent/executionProfiles.js';

describe('subagent execution profiles', () => {
  it('uses a provider-neutral compatibility baseline without inference', () => {
    expect(resolveExecutionProfile(undefined, undefined)).toEqual(COMPATIBILITY_PROFILE);
    expect(BUILT_IN_SUBAGENT_PROFILES['local-safe']?.maxConcurrency).toBe(1);
    expect(BUILT_IN_SUBAGENT_PROFILES['cloud-fast']?.maxConcurrency).toBe(5);
  });

  it('merges bounded custom fields and rejects unknown explicit profiles', () => {
    expect(resolveExecutionProfile('custom', {custom: {maxConcurrency: 2, maxSteps: 30}})).toMatchObject({name: 'custom', maxConcurrency: 2, maxSteps: 30});
    expect(resolveExecutionProfile('missing', undefined)).toBeUndefined();
    expect(() => resolveExecutionProfile('custom', {custom: {maxConcurrency: 999}})).toThrow();
  });

  it('keeps read-only modes free of bash and mutation tools', () => {
    expect(MODE_TOOL_NAMES.inspect).toEqual(['listFiles', 'readFile', 'grep', 'readToolOutput']);
    expect(MODE_TOOL_NAMES.research).toContain('fetch');
    expect(MODE_TOOL_NAMES.research).not.toContain('bash');
    expect(MODE_TOOL_NAMES.validate).toContain('bash');
    expect(MODE_TOOL_NAMES.validate).not.toContain('writeFile');
  });
});
