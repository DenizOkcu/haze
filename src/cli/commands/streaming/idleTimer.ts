/**
 * An idle timer for the main agent turn.
 *
 * The turn is considered "idle" (and aborted) after `timeoutMs` with no stream
 * activity — UNLESS a tool call is currently executing (`isBusy()` returns
 * true). Concurrent subagents can run for many minutes while emitting no stream
 * parts; that is legitimate work, not a dead stream, so the timer defers (rearms)
 * while any tool is in flight. This prevents a long subagent wave from being
 * mistaken for a hung turn.
 *
 * Note: there is intentionally no upper bound on how long a single tool may run
 * while in flight — a genuinely hung tool would defer indefinitely. A per-tool
 * hard timeout is a separate concern; the idle timer only guards against a turn
 * that is producing no model output AND doing no tool work.
 */
export interface IdleTimer {
  /** Clear any pending deadline and rearm it for a fresh idle window. */
  reset: () => void;
  /** Cancel the pending deadline without rearming. */
  clear: () => void;
}

export function createIdleTimer(input: {timeoutMs: number; isBusy: () => boolean; onTimeout: () => void;}): IdleTimer {
  const {timeoutMs, isBusy, onTimeout} = input;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fire = () => {
    if (isBusy()) {
      // Tools are executing — that is activity. Defer by rearming.
      timer = setTimeout(fire, timeoutMs);
      return;
    }
    onTimeout();
  };

  return {
    reset: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, timeoutMs);
    },
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
