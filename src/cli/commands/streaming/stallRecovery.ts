import type {LlmLog} from '../../../core/log/llmLog.js';
import {agentEvent, type AgentEventSink} from '../../../core/agent/events.js';
import {IDLE_TIMEOUT_MS} from '../../../core/agent/budgets.js';
import {compactToolHistory, stripSyntheticControls} from '../../../core/agent/requestAssembly.js';
import type {ModelMessage} from 'ai';
import {abortForTurn, type TurnAbortCause} from './abortCause.js';
import {logEntry} from './turnRuntime.js';

/** Shared bounded retry pool for transient model errors and idle-stream stalls (per turn). */
export const MAX_MODEL_RETRIES = 2;

/** What the stalled step had emitted when the stream went quiet. Only 'none' is auto-retryable. */
type StallEmission = 'none' | 'text' | 'tool';

export function formatIdleMinutes(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Auto-retry an idle stall only while the stalled step emitted nothing visible (no partial text or in-flight tool). */
function idleStallAutoRetryEligible(retryAttempt: number, stallEmission: StallEmission) {
  return stallEmission === 'none' && retryAttempt < MAX_MODEL_RETRIES;
}

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

/**
 * Idle-stall guard for one attempt: the idle timer plus the hoisted stall
 * state the attempt catch needs (last stream event, emission classification,
 * retry eligibility). `onTimeout` classifies the stall from live stream state
 * (via `classifyEmission`), reports it through the timeout event protocol, and
 * aborts the shared controller with the `model-stream-idle` cause. Diagnostics
 * carry safe metadata only (names, timestamps, enums, phases) — never prompt
 * content or credentials.
 */
export interface StreamStallGuard {
  /** Record a consumed stream part (type + timestamp) and rearm the idle window. */
  noteStreamEvent: (type: string) => void;
  /** Rearm the idle window without recording an event (before the first request). */
  rearm: () => void;
  /** Cancel the pending deadline. */
  clear: () => void;
  /** Emission classified by the last timeout; only meaningful after a stall fired. */
  readonly stallEmission: StallEmission;
  /** Whether the last stall rides the bounded model-retry pool. */
  readonly retryEligible: boolean;
}

export interface StreamStallGuardDeps {
  controller: AbortController;
  abortCause: TurnAbortCause;
  retryAttempt: number;
  /** Classify what the stalled step emitted so far: partial text, in-flight tool, or nothing. */
  classifyEmission: () => StallEmission;
  isToolInFlight: () => boolean;
  provider: () => string | undefined;
  model: () => string | undefined;
  workPhase: () => string;
  stepsUsed: () => number;
  onEvent?: AgentEventSink;
  log?: LlmLog;
  debugLog: (line: string) => void;
}

export function createStreamStallGuard(deps: StreamStallGuardDeps): StreamStallGuard {
  let stallEmission: StallEmission = 'none';
  let retryEligible = false;
  let lastStreamEventAt: number | undefined;
  let lastStreamEventType: string | undefined;

  const timer = createIdleTimer({
    timeoutMs: IDLE_TIMEOUT_MS,
    isBusy: () => deps.isToolInFlight(),
    onTimeout: () => {
      if (deps.controller.signal.aborted) return;
      // What the stalled step had emitted when the stream went quiet. Retrying
      // after partial output could duplicate or mangle it, so only 'none' is
      // automatically retryable.
      stallEmission = deps.classifyEmission();
      retryEligible = idleStallAutoRetryEligible(deps.retryAttempt, stallEmission);
      const lastEventAtIso = lastStreamEventAt != null ? new Date(lastStreamEventAt).toISOString() : undefined;
      deps.onEvent?.(agentEvent({
        type: 'timeout',
        phase: 'model-stream',
        timeoutMs: IDLE_TIMEOUT_MS,
        provider: deps.provider(),
        model: deps.model(),
        lastStreamEventAt: lastEventAtIso,
        lastStreamEventType: lastStreamEventType,
        stallEmission: stallEmission,
        workPhase: deps.workPhase(),
        retryEligible: retryEligible,
      }));
      logEntry(deps.log, {at: new Date().toISOString(), type: 'warning', stream: 'main', error: `model-stream idle ${IDLE_TIMEOUT_MS}ms: provider=${deps.provider() ?? 'unknown'} model=${deps.model() ?? 'unknown'} lastEvent=${lastStreamEventType ?? 'none'}@${lastEventAtIso ?? 'never'} stallEmission=${stallEmission} workPhase=${deps.workPhase()} retryEligible=${retryEligible} stepsUsed=${deps.stepsUsed()}`});
      deps.debugLog(`model stream idle for ${IDLE_TIMEOUT_MS}ms (last event: ${lastStreamEventType ?? 'none'}); ${retryEligible ? 'retryable stall' : 'stall not retryable'}`);
      abortForTurn(deps.abortCause, {kind: 'model-stream-idle', timeoutMs: IDLE_TIMEOUT_MS}, deps.controller, 'haze model stream was idle for the configured timeout.');
    },
  });

  return {
    noteStreamEvent: (type: string) => {
      lastStreamEventAt = Date.now();
      lastStreamEventType = type;
      timer.reset();
    },
    rearm: () => timer.reset(),
    clear: () => timer.clear(),
    get stallEmission() {
      return stallEmission;
    },
    get retryEligible() {
      return retryEligible;
    },
  };
}

/**
 * Salvage state shared by the attempt phases: the request messages this
 * attempt sent, and the latest fully completed step's accumulated response
 * messages (captured in `onStepEnd`) that an idle-stall retry resumes from.
 */
export interface AttemptSalvage {
  requestMessages: ModelMessage[];
  accumulated: ModelMessage[];
}

/**
 * Salvage the conversation to the last fully completed step after a stalled or
 * failed stream: completed — possibly mutating — tool work is preserved so an
 * idle retry (or a user resume) continues from there instead of re-running it.
 */
export function salvageConversationToLastStep(callbacks: {setConversation: (messages: ModelMessage[]) => void}, salvage: AttemptSalvage) {
  if (salvage.accumulated.length > 0) {
    callbacks.setConversation(compactToolHistory([...stripSyntheticControls(salvage.requestMessages), ...salvage.accumulated]).messages);
  }
}
