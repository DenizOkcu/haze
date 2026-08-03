import {describe, expect, it} from 'vitest';
import type {SessionSummary} from '../../src/core/session/sessionStore.js';
import {MAX_SESSION_PICKER_RESULTS, sessionActionSuggestions, sessionSuggestions} from '../../src/cli/commands/sessionPicker.js';

function summary(index: number): SessionSummary {
  return {
    id: `session-${index}`,
    createdAt: '2026-08-03T14:00:00.000Z',
    lastActivityAt: '2026-08-03T14:12:00.000Z',
    messageCount: index,
    firstUserPreview: 'fix the flaky session test',
    sizeBytes: 2048,
    lastStatus: 'complete',
    parseErrors: index === 0 ? ['Line 3: bad JSON'] : [],
  };
}

describe('session picker (F02)', () => {
  it('shows date, message count, size, preview, status, and malformed warning metadata', () => {
    const [suggestion] = sessionSuggestions([summary(0)]);
    expect(suggestion?.value).toBe('session-0');
    expect(suggestion?.description).toContain('2026-08-03');
    expect(suggestion?.description).toContain('0 msgs');
    expect(suggestion?.description).toContain('2 KB');
    expect(suggestion?.description).toContain('complete');
    expect(suggestion?.description).toContain('⚠ malformed lines');
    expect(suggestion?.description).toContain('fix the flaky session test');
  });

  it('caps visible sessions and makes resume the default action', () => {
    expect(sessionSuggestions(Array.from({length: MAX_SESSION_PICKER_RESULTS + 5}, (_, index) => summary(index)))).toHaveLength(MAX_SESSION_PICKER_RESULTS);
    expect(sessionActionSuggestions().map(action => action.value)).toEqual(['resume', 'fork']);
  });
});
