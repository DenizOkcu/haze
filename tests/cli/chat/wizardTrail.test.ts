import {describe, expect, it} from 'vitest';
import {createWizardTrail} from '../../../src/cli/chat/wizardTrail.js';

describe('wizardTrail (UX-03)', () => {
  it('pops one step at a time and clears when the flow ends in chat', () => {
    const trail = createWizardTrail();
    trail.enter('provider');
    trail.enter('providerAction');
    trail.enter('model');
    expect(trail.steps()).toEqual(['provider', 'providerAction']);
    // Re-entering the same step does not add a stop.
    trail.enter('model');
    expect(trail.steps()).toEqual(['provider', 'providerAction']);
    expect(trail.back()).toBe('providerAction');
    expect(trail.back()).toBe('provider');
    expect(trail.back()).toBeUndefined();
    // A wizard root exits to chat (clearing the trail) before another flow starts.
    trail.enter('chat');
    trail.enter('skills');
    expect(trail.back()).toBeUndefined();
    trail.enter('skillsAction');
    trail.enter('chat');
    expect(trail.steps()).toEqual([]);
  });
});
