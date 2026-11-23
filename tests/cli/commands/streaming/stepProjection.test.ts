import {describe, expect, it} from 'vitest';
import {projectStepEnd} from '../../../../src/cli/commands/streaming/stepProjection.js';

const base = {
  completedSteps: 1,
  attempt: 1,
  text: 'hello',
  toolCallCount: 0,
  toolResultCount: 0,
  finishReason: 'stop',
  usage: undefined,
  responseModel: undefined,
  previousLastUsage: undefined,
  stepsUsed: 0,
  toolCallsUsed: 0,
};

describe('projectStepEnd (ARCH-06)', () => {
  it('increments the turn-wide step counter and emits a step_end event', () => {
    const p = projectStepEnd(base, () => new Date('2026-11-23T00:00:00Z'));
    expect(p.stepsUsed).toBe(1);
    expect(p.event).toMatchObject({type: 'step_end', attempt: 1, step: 1, finishReason: 'stop', toolCallCount: 0});
    expect(p.log).toMatchObject({type: 'step', stream: 'main', step: 0, text: 'hello', at: '2026-11-23T00:00:00.000Z'});
    expect(p.toolOnlyStep).toBe(false);
    expect(p.debugLine).toContain('step 0 finished: stop');
  });

  it('keeps the previous usage when this step reported an empty usage object', () => {
    const previous = {inputTokens: 100, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 0};
    const p = projectStepEnd({...base, usage: {}, previousLastUsage: previous});
    expect(p.lastUsage).toEqual(previous);
    expect(p.event).toMatchObject({usage: {inputTokens: 0, outputTokens: 0}});
  });

  it('records fresh usage (including cache and reasoning tokens) when present', () => {
    const p = projectStepEnd({...base, usage: {inputTokens: 200, outputTokens: 7, inputTokenDetails: {cacheReadTokens: 50, cacheWriteTokens: 3}, outputTokenDetails: {reasoningTokens: 9}}});
    expect(p.lastUsage).toEqual({inputTokens: 200, outputTokens: 7, cacheReadTokens: 50, cacheWriteTokens: 3});
    expect(p.event).toMatchObject({usage: {inputTokens: 200, outputTokens: 7, cacheReadTokens: 50, reasoningTokens: 9}});
    expect(p.log.usage).toMatchObject({inputTokens: 200, outputTokens: 7, cacheReadTokens: 50, reasoningTokens: 9});
  });

  it('flags tool-only steps and carries the response model id', () => {
    const p = projectStepEnd({...base, text: '  ', toolCallCount: 2, toolResultCount: 2, responseModel: 'gpt-x'});
    expect(p.toolOnlyStep).toBe(true);
    expect(p.event).toMatchObject({toolCallCount: 2, responseModel: 'gpt-x'});
  });
});
