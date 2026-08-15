/**
 * Why a turn's AbortController fired.
 *
 * One controller is shared by three abort sites: the model-stream idle timer,
 * the absolute turn deadline (both in this subtree), and the user's cancel
 * action (chat.tsx aborts the controller it holds). All three land in the same
 * catch block in `runAgentAttempt`, so the *cause* is tracked in a per-turn
 * mutable holder set by whichever internal site aborts first. A user abort
 * never sets it and therefore stays `'user'` (the default).
 */
type TurnAbortCauseKind = 'user' | 'turn-deadline' | 'model-stream-idle';

export interface TurnAbortCause {
  kind: TurnAbortCauseKind;
  /** Window of the timer that fired (idle window or turn deadline), for messages and diagnostics. */
  timeoutMs?: number;
}

/** Fresh per-turn cause tracker. An unset cause means the user aborted. */
export function createUserAbortCause(): TurnAbortCause {
  return {kind: 'user'};
}

/**
 * Record `next` as the abort cause and abort `controller`. First aborter wins:
 * a no-op once the controller already aborted, so a user Esc raced against an
 * idle timeout keeps whichever cause actually fired first.
 */
export function abortForTurn(cause: TurnAbortCause, next: TurnAbortCause, controller: AbortController, reason: string): void {
  if (controller.signal.aborted) return;
  cause.kind = next.kind;
  cause.timeoutMs = next.timeoutMs;
  controller.abort(reason);
}
