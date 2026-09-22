import {describe, expect, it, vi} from 'vitest';
import {getEventListeners} from 'node:events';
import {createAbsoluteDeadline, isToolDeadlineExceeded, withToolDeadline} from '../../src/core/deadline.js';

describe('withToolDeadline', () => {
  it.each(['success', 'error', 'sync-error', 'timeout'] as const)('removes abort listeners after %s', async outcome => {
    const controller = new AbortController();
    const execute = () => {
      if (outcome === 'sync-error') throw new Error('sync');
      if (outcome === 'error') return Promise.reject(new Error('async'));
      if (outcome === 'timeout') return new Promise(() => undefined);
      return Promise.resolve('done');
    };
    const result = withToolDeadline(execute, 1, controller.signal);
    if (outcome === 'error' || outcome === 'sync-error') await expect(result).rejects.toThrow();
    else await result;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('returns the underlying value when it settles before the deadline', async () => {
    const result = await withToolDeadline(async () => 'done', 1000);
    expect(result).toBe('done');
  });

  it('resolves with a structured deadline failure when the tool never settles', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<unknown>(() => undefined);
      const promise = withToolDeadline(() => never, 5000);
      await vi.advanceTimersByTimeAsync(5000);
      const result = await promise;
      expect(isToolDeadlineExceeded(result)).toBe(true);
      expect(result).toMatchObject({ok: false});
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates the underlying rejection on real failure', async () => {
    await expect(withToolDeadline(async () => { throw new Error('boom'); }, 1000)).rejects.toThrow('boom');
  });

  it('quarantines late settlement without an unhandled rejection', async () => {
    vi.useFakeTimers();
    try {
      let lateResolve!: (value: unknown) => void;
      const hanging = new Promise<unknown>(resolve => { lateResolve = resolve; });
      const promise = withToolDeadline(() => hanging, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(isToolDeadlineExceeded(result)).toBe(true);
      // Settling the underlying work after timeout must not throw or mutate the result.
      lateResolve({ok: true, sneaky: true});
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toMatchObject({ok: false});
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires immediately when the parent signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => 'unexpected');
    const result = await withToolDeadline(execute, 10000, controller.signal);
    expect(isToolDeadlineExceeded(result)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('createAbsoluteDeadline', () => {
  it('permanently disposes a cleared deadline and its parent listener', () => {
    const controller = new AbortController();
    const onTimeout = vi.fn();
    const deadline = createAbsoluteDeadline({timeoutMs: 10000, signal: controller.signal, onTimeout});
    deadline.clear();
    deadline.clear();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    controller.abort();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('fires once after the timeout and is clearable', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const deadline = createAbsoluteDeadline({timeoutMs: 5000, onTimeout});
      await vi.advanceTimersByTimeAsync(4000);
      expect(onTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      deadline.clear();
    } finally {
      vi.useRealTimers();
    }
  });
});
