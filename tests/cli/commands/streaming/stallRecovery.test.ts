import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createIdleTimer} from '../../../../src/cli/commands/streaming/stallRecovery.js';

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
