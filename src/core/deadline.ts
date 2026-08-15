const TOOL_DEADLINE_EXCEEDED = '__hazeToolDeadlineExceeded';

/** True when a tool result is the structured "deadline exceeded" placeholder. */
export function isToolDeadlineExceeded(output: unknown): boolean {
  return typeof output === 'object' && output !== null && TOOL_DEADLINE_EXCEEDED in output;
}

/**
 * Run an underlying tool `execute` under a deadline. The wrapper resolves
 * promptly when the deadline (or an optional parent abort signal) fires, even
 * if the underlying work ignores cancellation. The still-pending work is
 * quarantined so its eventual settlement cannot produce an unhandled rejection
 * or mutate caller state (RH-004).
 *
 * - Normal completion → resolves with the underlying value.
 * - Underlying rejection → rejects with that error (let the SDK classify it).
 * - Deadline / parent abort → resolves with a structured bounded failure.
 */
export function withToolDeadline(execute: () => Promise<unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const handle: {timer: ReturnType<typeof setTimeout> | undefined} = {timer: undefined};
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (handle.timer) clearTimeout(handle.timer);
      action();
    };
    const quarantineLate = () => {
      // Swallow the eventual resolution/rejection of an abort-ignoring tool so
      // it cannot surface as an unhandled rejection after the wrapper returned.
      work.catch(() => undefined);
    };
    const fire = (message: string) => settle(() => {
      quarantineLate();
      resolve({ok: false, [TOOL_DEADLINE_EXCEEDED]: true, error: message});
    });

    const work = execute();
    handle.timer = setTimeout(() => fire(`Tool execution exceeded the ${timeoutMs}ms deadline.`), timeoutMs);
    if (signal) {
      if (signal.aborted) return fire('Tool execution was aborted.');
      signal.addEventListener('abort', () => fire('Tool execution was aborted.'), {once: true});
    }
    work.then(value => settle(() => resolve(value)), error => settle(() => reject(error)));
  });
}

/**
 * Create a clearable absolute deadline that fires `onTimeout` once after
 * `timeoutMs`, unless `clear()` is called first. An already-aborted parent
 * signal fires immediately. Used for the absolute main-turn bound (RH-004).
 */
export interface AbsoluteDeadline {
  clear: () => void;
}
export function createAbsoluteDeadline(input: {timeoutMs: number; signal?: AbortSignal; onTimeout: () => void;}): AbsoluteDeadline {
  const {timeoutMs, signal, onTimeout} = input;
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    if (fired) return;
    fired = true;
    if (timer) clearTimeout(timer);
    onTimeout();
  };
  timer = setTimeout(fire, timeoutMs);
  if (signal) {
    if (signal.aborted) fire();
    else signal.addEventListener('abort', fire, {once: true});
  }
  return {
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
