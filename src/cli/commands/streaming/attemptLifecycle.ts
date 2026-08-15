import type {StreamCallbacks} from '../streaming.js';
import type {AgentAttemptResult} from './attemptOutcome.js';

/**
 * Grace window for an aborted attempt to settle on its own (streams normally
 * reject immediately on abort) before the turn forces settlement.
 */
const ATTEMPT_SETTLEMENT_GRACE_MS = 5000;
/** Upper bound for one forced teardown pass; the underlying closes continue even if it expires. */
export const ATTEMPT_TEARDOWN_BOUND_MS = 5000;

/**
 * Exactly-once cleanup registry for one agent attempt. The attempt registers
 * its resource cleanups (MCP clients, LSP pool, stall guard, tool display) as
 * it acquires them; whichever of the attempt's own `finally` or the turn's
 * forced settlement runs first performs the teardown, and the other becomes a
 * no-op. `closeOnce` is bounded and reports truthfully whether every cleanup
 * completed within `timeoutMs` (closes keep settling in the background).
 */
export interface AttemptCleanupRegistry {
  /** Register a cleanup to run once at teardown. Ignored after teardown started. */
  register: (cleanup: () => void | Promise<void>) => void;
  /** Run all registered cleanups exactly once; resolves false when the bound expired. */
  closeOnce: (timeoutMs: number) => Promise<boolean>;
  /** True once teardown has started. */
  readonly closed: boolean;
}

export function createAttemptCleanupRegistry(): AttemptCleanupRegistry {
  const cleanups: Array<() => void | Promise<void>> = [];
  let closePromise: Promise<boolean> | undefined;
  return {
    register: cleanup => {
      if (!closePromise) cleanups.push(cleanup);
    },
    get closed() {
      return closePromise != null;
    },
    closeOnce(timeoutMs: number) {
      if (!closePromise) {
        const settled = Promise.allSettled(cleanups.map(cleanup => cleanup()));
        // The teardown continues even when the bound expires; its eventual
        // settlement must never surface as an unhandled rejection.
        void settled.then(() => undefined, () => undefined);
        closePromise = Promise.race([
          settled.then(() => true),
          new Promise<boolean>(resolve => setTimeout(() => resolve(false), timeoutMs)),
        ]);
      }
      return closePromise;
    },
  };
}

/**
 * Per-turn callback guard for the attempt machinery. After `quarantine()` —
 * run at forced settlement — every state-mutating callback (messages,
 * conversation, busy/goal/work state, events, token usage, logs) becomes a
 * permanent no-op, so a still-running abort-ignoring stream cannot mutate the
 * finished turn's UI, conversation, or session state if it ever wakes up.
 * Diagnostics (`debugLog`) and read-only accessors stay live.
 */
export interface QuarantinableCallbacks {
  callbacks: StreamCallbacks;
  /** Permanently no-op all state-mutating callbacks. */
  quarantine: () => void;
}

export function createQuarantinableCallbacks(callbacks: StreamCallbacks): QuarantinableCallbacks {
  const state = {quarantined: false};
  const whileLive = <Args extends unknown[]>(fn: (...args: Args) => void) => (...args: Args) => {
    if (!state.quarantined) fn(...args);
  };
  // `compactConversation`'s boolean return is consumed by overflow recovery;
  // a quarantined call must answer "not compacted" instead of undefined.
  const whileLiveBoolean = <Args extends unknown[]>(fn: (...args: Args) => boolean) => (...args: Args) => (state.quarantined ? false : fn(...args));
  const guarded: StreamCallbacks = {
    ...callbacks,
    addMessage: whileLive(callbacks.addMessage),
    updateMessage: whileLive(callbacks.updateMessage),
    setConversation: whileLive(callbacks.setConversation),
    setBusy: whileLive(callbacks.setBusy),
    setLastAssistantText: whileLive(callbacks.setLastAssistantText),
    ...(callbacks.setBusyLabel ? {setBusyLabel: whileLive(callbacks.setBusyLabel)} : {}),
    ...(callbacks.setAbortController ? {setAbortController: whileLive(callbacks.setAbortController)} : {}),
    ...(callbacks.setGoalStatus ? {setGoalStatus: whileLive(callbacks.setGoalStatus)} : {}),
    ...(callbacks.onEvent ? {onEvent: whileLive(callbacks.onEvent)} : {}),
    ...(callbacks.compactConversation ? {compactConversation: whileLiveBoolean(callbacks.compactConversation)} : {}),
    ...(callbacks.recordTokenUsage ? {recordTokenUsage: whileLive(callbacks.recordTokenUsage)} : {}),
    ...(callbacks.setWorkState ? {setWorkState: whileLive(callbacks.setWorkState)} : {}),
    ...(callbacks.onTasksChanged ? {onTasksChanged: whileLive(callbacks.onTasksChanged)} : {}),
    get log() {
      return state.quarantined ? undefined : callbacks.log;
    },
    get contextFileSignatures() {
      return callbacks.contextFileSignatures;
    },
  };
  return {callbacks: guarded, quarantine: () => {
    state.quarantined = true;
  }};
}

export interface ForcedSettlementDeps {
  abortController: AbortController;
  cleanup: AttemptCleanupRegistry;
  quarantine: () => void;
  /**
   * Build the synthetic attempt result after forced teardown. Runs with the
   * turn's live (unguarded) callbacks before the abandoned attempt's result
   * (if it ever settles) is discarded.
   */
  onForced: (tornDownCleanly: boolean) => AgentAttemptResult;
}

/**
 * Await one agent attempt, but never let an abort-ignoring attempt defer the
 * turn forever: once the shared controller aborts (user cancel or absolute
 * deadline), the attempt gets a grace window to settle normally; if the grace
 * expires, owned resources are torn down (bounded, exactly once), the attempt's
 * callbacks are quarantined, and the turn resolves with `onForced`'s result.
 * The abandoned attempt keeps running detached; its eventual settlement is
 * discarded and its teardown is a no-op.
 */
export async function awaitAttemptWithForcedSettlement(attempt: Promise<AgentAttemptResult>, deps: ForcedSettlementDeps): Promise<AgentAttemptResult> {
  const {abortController, cleanup, quarantine, onForced} = deps;
  return new Promise<AgentAttemptResult>(resolve => {
    let finished = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: AgentAttemptResult) => {
      if (finished) return;
      finished = true;
      if (graceTimer) clearTimeout(graceTimer);
      resolve(result);
    };
    // runAgentAttempt classifies its own errors, but never let a surprise
    // rejection surface as unhandled after the turn moved on.
    attempt.then(result => finish(result), () => finish({status: 'failed'}));
    const armGrace = () => {
      if (finished || graceTimer) return;
      graceTimer = setTimeout(async () => {
        if (finished) return;
        const tornDown = await cleanup.closeOnce(ATTEMPT_TEARDOWN_BOUND_MS);
        quarantine();
        finish(onForced(tornDown));
      }, ATTEMPT_SETTLEMENT_GRACE_MS);
    };
    if (abortController.signal.aborted) armGrace();
    else abortController.signal.addEventListener('abort', armGrace, {once: true});
  });
}
