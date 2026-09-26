import {describe, expect, it} from 'vitest';
import {formatSessionReport, summarizeSessionEntries} from '../../src/core/session/sessionReport.js';
import type {SessionEntry} from '../../src/core/session/sessionStore.js';
import {prepareSessionEntryForWrite} from '../../src/core/session/sessionSlimming.js';

describe('session report', () => {
  it('summarizes goal and validation evidence without echoing inputs or output', () => {
    const entries: SessionEntry[] = [
      {type: 'header', id: 'one', cwd: '/private/work', createdAt: 'now', hazeVersion: '1.4.0'},
      {type: 'ui_message', at: 'now', role: 'user', text: 'private user request'},
      {type: 'event', at: 'now', name: 'reasoning_policy', text: JSON.stringify({effective: 'high'})},
      {type: 'event', at: 'now', name: 'step_end', text: JSON.stringify({responseModel: 'local-small', usage: {inputTokens: 8192}})},
      {type: 'event', at: 'now', name: 'tool_end', text: JSON.stringify({name: 'shell', success: false, output: {command: 'secret command', validationSummary: {kind: 'test', status: 'failed'}, stdout: {text: 'private tool output'}}})},
      {type: 'goal', at: 'now', goalId: 'goal-1', phase: 'goal_end', request: 'private user request', requestHash: '0123456789abcdef', intent: 'implement', cycle: 2, mutationCount: 3, validationOutcome: 'failed', progressSignature: '', status: 'failed', taskCounts: {total: 3, pending: 1, inProgress: 0, completed: 2}},
    ];
    const report = summarizeSessionEntries(entries);
    expect(report).toMatchObject({model: 'local-small', peakInputTokens: 8192, steps: 1, failedToolCalls: 1, failedValidations: {test: 1}, goals: [{status: 'failed', openTasks: 1}]});
    const text = formatSessionReport(report);
    expect(text).not.toMatch(/private|secret|\/private\/work/);
  });

  it('counts a failed validation when its large tool output was slimmed', () => {
    const raw: SessionEntry = {type: 'event', at: 'now', name: 'tool_end', text: JSON.stringify({name: 'shell', success: false, output: {validationSummary: {kind: 'build', status: 'failed', summaryText: 'private error'}, stdout: 'private'.repeat(10_000)}})};
    const prepared = prepareSessionEntryForWrite(raw);
    expect(prepared?.type).toBe('event');
    if (prepared?.type !== 'event') return;
    const report = summarizeSessionEntries([prepared]);
    expect(report.failedValidations).toEqual({build: 1});
    expect(formatSessionReport(report)).not.toContain('private error');
  });
});
