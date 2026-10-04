import {afterEach, expect, it, vi} from 'vitest';
import {createChatShutdown, runTerminalSession} from '../../../src/cli/chat/shutdown.js';

afterEach(() => vi.useRealTimers());
it('shares an ordered, idempotent exit with bounded active work and failed persistence', async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const exit = vi.fn(() => { events.push('exit'); });
  const report = vi.fn();
  const shutdown = createChatShutdown({
    stop: () => { events.push('stop'); },
    abort: () => { events.push('abort'); },
    settle: () => new Promise(() => {}),
    seal: () => { events.push('seal'); },
    flush: async () => { events.push('flush'); throw new Error('synthetic persistence failure'); },
    endLog: async () => { events.push('log'); },
    cleanup: async () => { events.push('cleanup'); },
    exit, report,
  }, 10, 10);
  const first = shutdown();
  expect(shutdown()).toBe(first);
  await vi.runAllTimersAsync();
  await first;
  expect(events).toEqual(['stop', 'abort', 'seal', 'flush', 'log', 'cleanup', 'exit']);
  expect(exit).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['render', 'wait', 'cleanup', 'adopt'])('restores terminal defaults on %s failure', async phase => {
  const restore = vi.fn();
  const shutdown = vi.fn(async () => {});
  const unmount = vi.fn();
  const cleanup = vi.fn(() => { if (phase === 'cleanup') throw new Error('cleanup'); });
  await expect(runTerminalSession({
    adopt: () => { if (phase === 'adopt') throw new Error('adopt'); },
    create: () => {
      if (phase === 'render') throw new Error('render');
      return {waitUntilExit: async () => { if (phase === 'wait') throw new Error('wait'); }, unmount, cleanup};
    },
    shutdown, restore,
  })).rejects.toThrow(phase);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(unmount).toHaveBeenCalledTimes(phase === 'adopt' || phase === 'render' ? 0 : 1);
});
it('quiesces active callbacks before flushing and exiting normally', async () => {
  const events: string[] = [];
  let sealed = false;
  let finish: (() => void) | undefined;
  const active = new Promise<void>(resolve => { finish = resolve; });
  const callback = () => { if (!sealed) events.push('callback'); };
  const shutdown = createChatShutdown({
    stop: () => {}, abort: () => { callback(); finish?.(); }, settle: () => active,
    seal: () => { sealed = true; }, flush: async () => { events.push('flush'); },
    endLog: async () => { events.push('log'); }, cleanup: async () => {},
    exit: () => { events.push('exit'); }, report: vi.fn(),
  });
  await shutdown();
  callback();
  expect(events).toEqual(['callback', 'flush', 'log', 'exit']);
});
