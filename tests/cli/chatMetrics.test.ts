import {describe, expect, it} from 'vitest';
import {busyDetailLabel, compactHomePath, estimateConversationTokens, nextFleetStatus, statusBarMetrics, toolCallCount} from '../../src/cli/chat/chatMetrics.js';
import {formatTokenCount} from '../../src/utils/format.js';
import {EMPTY_TOKEN_USAGE} from '../../src/cli/chat/turnState.js';
import type {Message} from '../../src/cli/commands/streaming.js';

describe('chat metrics', () => {
  it('prefers the structured toolCount carried by live tool groups', () => {
    const messages: Message[] = [
      {role: 'tool', text: '3 calls · 1 changes · 2s', toolCount: 3},
      {role: 'tool', text: 'any future caption format', toolCount: 5},
      {role: 'assistant', text: 'ignored'},
    ];
    expect(toolCallCount(messages)).toBe(8);
  });

  it('falls back to counting rendered rows for restored historical transcripts', () => {
    const messages: Message[] = [
      {role: 'tool', text: '1 calls · 0 changes · 1s\n  ✓ readFile — ok\n  ✗ grep — error'},
    ];
    expect(toolCallCount(messages)).toBe(2);
  });

  it('formats token counts compactly', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1_500)).toBe('1.5k');
    expect(formatTokenCount(12_500)).toBe('13k');
    expect(formatTokenCount(1_500_000)).toBe('1.5m');
  });

  it('compacts home-relative paths', () => {
    expect(compactHomePath('/Users/me/project', '/Users/me')).toBe('~/project');
    expect(compactHomePath('/tmp/project', '/Users/me')).toBe('/tmp/project');
  });

  it('estimates conversation input and output tokens by role', () => {
    expect(estimateConversationTokens([
      {role: 'user', text: 'abcd'},
      {role: 'tool', text: 'abcd'},
      {role: 'assistant', text: 'abcdefgh'},
    ])).toEqual({input: 3, output: 2});
  });

  it('computes the status-bar detail label from structured metrics', () => {
    const metrics = statusBarMetrics({
      messages: [
        {role: 'assistant', text: 'answer'},
        {role: 'tool', text: '2 calls · 0 changes · 1s', toolCount: 2},
      ],
      tokenUsage: {...EMPTY_TOKEN_USAGE, inputTokens: 100, outputTokens: 50},
      enabledSkillCount: 1,
    });
    expect(metrics.statusDetailLabel).toBe('1 message / 2 tool calls / LLM ↑100 ↓50 / 1 skill');
    expect(metrics.inputEstimated).toBe(false);
    expect(metrics.outputEstimated).toBe(false);
    expect(metrics.hasTokenBreakdown).toBe(true);
  });

  it('shows 0 messages and plural tool calls when the transcript is empty', () => {
    const base = {messages: [], tokenUsage: {...EMPTY_TOKEN_USAGE}, enabledSkillCount: 0};
    expect(statusBarMetrics(base).statusDetailLabel).toBe('0 messages / 0 tool calls / LLM ~↑0 ~↓0 / 0 skills');
  });

  it('shows live background process count only when nonzero (F09)', () => {
    const base = {messages: [], tokenUsage: {...EMPTY_TOKEN_USAGE}, enabledSkillCount: 0};
    expect(statusBarMetrics({...base, backgroundProcessCount: 2}).statusDetailLabel).toContain('⏵ 2 bg');
    expect(statusBarMetrics({...base, backgroundProcessCount: 0}).statusDetailLabel).not.toContain(' bg');
  });
});

describe('fleet status folding', () => {
  it('tracks queue depth and admissions across coordinator events', () => {
    let status = nextFleetStatus(undefined, {type: 'subagent_state', state: 'queued', queued: 4, running: 0});
    expect(status).toEqual({running: 0, queued: 4});
    status = nextFleetStatus(status, {type: 'subagent_state', state: 'started', running: 1});
    expect(status).toEqual({running: 1, queued: 3});
    status = nextFleetStatus(status, {type: 'subagent_state', state: 'terminal', running: 0});
    expect(status).toEqual({running: 0, queued: 3});
    status = nextFleetStatus(status, {type: 'subagent_state', state: 'queued', queued: 2, running: 0});
    expect(status).toEqual({running: 0, queued: 2});
  });

  it('ignores unrelated events and never drops below zero', () => {
    expect(nextFleetStatus({running: 2, queued: 0}, {type: 'turn_start'})).toEqual({running: 2, queued: 0});
    expect(nextFleetStatus({running: 1, queued: 0}, {type: 'subagent_state', state: 'started', running: 2})!.queued).toBe(0);
  });
});

describe('busy detail label', () => {
  it('estimates the live generation rate from the streaming message', () => {
    const now = 10_000;
    const label = busyDetailLabel({now, messages: [
      {role: 'assistant', text: 'done earlier', startedAt: now - 60_000},
      {role: 'assistant', text: 'x'.repeat(400), streaming: true, startedAt: now - 5_000},
    ]});
    expect(label).toContain('~20 tok/s');
  });

  it('appends fleet depth and omits the label when idle', () => {
    const now = 10_000;
    expect(busyDetailLabel({now, messages: [], fleet: {running: 2, queued: 3}})).toBe('workers 2 running, 3 queued');
    expect(busyDetailLabel({now, messages: [], fleet: {running: 1, queued: 0}})).toBe('workers 1 running');
    expect(busyDetailLabel({now, messages: [], fleet: {running: 0, queued: 0}})).toBeUndefined();
  });
});
