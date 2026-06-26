import {describe, expect, it} from 'vitest';
import {accumulateTokenUsage, EMPTY_TOKEN_USAGE, shouldClearCompletedTasks} from '../../src/cli/chat/turnState.js';
import type {Task} from '../../src/core/tasks/taskStorage.js';

describe('turn state helpers', () => {
  it('clears tasks only when all existing tasks are completed', () => {
    expect(shouldClearCompletedTasks([])).toBe(false);
    expect(shouldClearCompletedTasks([{id: '1', title: 'done', status: 'completed', createdAt: 'x', updatedAt: 'x'}])).toBe(true);
    expect(shouldClearCompletedTasks([
      {id: '1', title: 'done', status: 'completed', createdAt: 'x', updatedAt: 'x'},
      {id: '2', title: 'todo', status: 'pending', createdAt: 'x', updatedAt: 'x'},
    ] satisfies Task[])).toBe(false);
  });

  it('accumulates token usage while preserving undefined optional totals', () => {
    expect(accumulateTokenUsage({...EMPTY_TOKEN_USAGE}, {...EMPTY_TOKEN_USAGE, messages: 2, inputTokens: 3})).toMatchObject({messages: 2, inputTokens: 3, outputTokens: undefined});
    expect(accumulateTokenUsage({...EMPTY_TOKEN_USAGE, inputTokens: 3, effectiveNonCachedInput: 4}, {...EMPTY_TOKEN_USAGE, inputTokens: 5, effectiveNonCachedInput: 6})).toMatchObject({inputTokens: 8, effectiveNonCachedInput: 10});
  });
});
