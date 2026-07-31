import {describe, expect, it} from 'vitest';
import {subagentInvocationScenarios} from '../fixtures/subagentInvocationScenarios.js';

describe('subagent invocation scenario fixtures', () => {
  it('covers direct, one-worker, and multiple-worker policy labels deterministically', () => {
    expect(new Set(subagentInvocationScenarios.map(item => item.expected))).toEqual(new Set(['direct', 'one-worker', 'multiple-workers']));
    expect(subagentInvocationScenarios).toHaveLength(9);
    for (const scenario of subagentInvocationScenarios) {
      expect(scenario.name).toMatch(/^[a-z0-9-]+$/);
      expect(scenario.request.length).toBeGreaterThan(10);
      expect(scenario.reason.length).toBeGreaterThan(3);
    }
  });
});
