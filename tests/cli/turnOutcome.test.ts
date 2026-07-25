import {describe, expect, it} from 'vitest';
import {terminalTurnStatus} from '../../src/cli/commands/streaming/turnOutcome.js';

describe('terminalTurnStatus', () => {
  it('requires a substantive answer after tools and rejects final failures/budget stops', () => {
    expect(terminalTurnStatus({aborted: false, assistantText: 'Done.', sawToolCall: true, lastToolOk: true})).toBe('complete');
    expect(terminalTurnStatus({aborted: false, assistantText: '', sawToolCall: true, lastToolOk: true})).toBe('failed');
    expect(terminalTurnStatus({aborted: false, assistantText: 'Done.', sawToolCall: true, lastToolOk: false})).toBe('failed');
    expect(terminalTurnStatus({aborted: false, assistantText: 'partial', sawToolCall: true, budgetReached: true})).toBe('failed');
    expect(terminalTurnStatus({aborted: true, assistantText: '', sawToolCall: false})).toBe('aborted');
    expect(terminalTurnStatus({aborted: false, assistantText: '', sawToolCall: false, finishReason: 'stop'})).toBe('failed');
  });
});
