import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createIdleTimer, createStreamStallGuard} from '../../../../src/cli/commands/streaming/stallRecovery.js';
import {createUserAbortCause} from '../../../../src/cli/commands/streaming/abortCause.js';
import type {AgentEvent} from '../../../../src/core/agent/events.js';

describe('createIdleTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires onTimeout after the idle window when nothing is in flight', () => {
    const onTimeout = vi.fn();
    createIdleTimer({timeoutMs: 5_000, isBusy: () => false, onTimeout}).reset();
    vi.advanceTimersByTime(4_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('reset() pushes the deadline back on activity', () => {
    const onTimeout = vi.fn();
    const timer = createIdleTimer({timeoutMs: 5_000, isBusy: () => false, onTimeout});
    timer.reset();
    vi.advanceTimersByTime(4_000);
    timer.reset(); // a stream part arrived → rearm
    vi.advanceTimersByTime(4_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('defers while a tool is in flight (a long subagent wave is not a dead stream)', () => {
    let inFlight = true;
    const onTimeout = vi.fn();
    const timer = createIdleTimer({timeoutMs: 5_000, isBusy: () => inFlight, onTimeout});
    timer.reset();
    // Five minutes pass with no stream parts, but a subagent is still executing.
    vi.advanceTimersByTime(5_000); // fires → busy → defer + rearm, NO abort
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000); // still executing → defer again
    expect(onTimeout).not.toHaveBeenCalled();
    // The subagent finishes; its tool-result stream part resets the timer.
    inFlight = false;
    timer.reset();
    vi.advanceTimersByTime(4_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('clear() cancels the pending deadline', () => {
    const onTimeout = vi.fn();
    const timer = createIdleTimer({timeoutMs: 5_000, isBusy: () => false, onTimeout});
    timer.reset();
    timer.clear();
    vi.advanceTimersByTime(10_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('aborts once tools finish and the stream truly goes idle', () => {
    // Even after a long busy wave, once in-flight drains and no parts arrive,
    // the turn is genuinely idle and must abort.
    let inFlight = true;
    const onTimeout = vi.fn();
    const timer = createIdleTimer({timeoutMs: 5_000, isBusy: () => inFlight, onTimeout});
    timer.reset();
    vi.advanceTimersByTime(5_000); // defer (busy)
    vi.advanceTimersByTime(3_000); // still busy, mid-window
    inFlight = false; // tools drained, but no reset() call (no new stream part)
    vi.advanceTimersByTime(2_000); // completes the deferred window → fires, not busy → abort
    expect(onTimeout).toHaveBeenCalledTimes(1);
    void timer;
  });
});

function guardDeps(overrides: Partial<Parameters<typeof createStreamStallGuard>[0]> = {}) {
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  return {
    base: {
      controller,
      abortCause: createUserAbortCause(),
      retryAttempt: 0,
      classifyEmission: () => 'none' as const,
      isToolInFlight: () => false,
      provider: () => 'prov',
      model: () => 'model',
      workPhase: () => 'main',
      stepsUsed: () => 0,
      onEvent: (event: AgentEvent) => events.push(event),
      debugLog: () => {},
      ...overrides,
    },
    events,
  };
}

describe('createStreamStallGuard retry pool', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is retry-eligible on the default pool while attempts remain', () => {
    const {base} = guardDeps();
    const guard = createStreamStallGuard(base);
    guard.rearm();
    vi.advanceTimersByTime(5 * 60_000);
    expect(base.controller.signal.aborted).toBe(true);
    expect(guard.retryEligible).toBe(true);
    expect(guard.stallEmission).toBe('none');
  });

  it('honours a raised `modelRetries` setting (maxRetries=5)', () => {
    // retryAttempt 3 with a pool of 5 is still eligible; the default pool of 2 would not be.
    const {base} = guardDeps({retryAttempt: 3, maxRetries: 5});
    const guard = createStreamStallGuard(base);
    guard.rearm();
    vi.advanceTimersByTime(5 * 60_000);
    expect(guard.retryEligible).toBe(true);
  });

  it('honours `modelRetries: 0` (retries disabled → pause, not auto-retry)', () => {
    const {base, events} = guardDeps({maxRetries: 0});
    const guard = createStreamStallGuard(base);
    guard.rearm();
    vi.advanceTimersByTime(5 * 60_000);
    expect(guard.retryEligible).toBe(false);
    const timeout = events.find(event => event.type === 'timeout');
    expect(timeout && timeout.type === 'timeout' && timeout.maxRetries).toBe(0);
  });

  it('reports the effective pool size in the timeout event', () => {
    const {base, events} = guardDeps({maxRetries: 4});
    const guard = createStreamStallGuard(base);
    guard.rearm();
    vi.advanceTimersByTime(5 * 60_000);
    const timeout = events.find(event => event.type === 'timeout');
    expect(timeout && timeout.type === 'timeout' && timeout.maxRetries).toBe(4);
    guard.clear();
  });

  it('exhausts the default pool at retryAttempt >= 2', () => {
    const {base} = guardDeps({retryAttempt: 2});
    const guard = createStreamStallGuard(base);
    guard.rearm();
    vi.advanceTimersByTime(5 * 60_000);
    expect(guard.retryEligible).toBe(false);
  });
});
