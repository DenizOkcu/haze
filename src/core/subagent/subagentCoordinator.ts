import type {WorkerMode, WorkerTermination} from './contracts.js';
import {isMutationMode, type SubagentExecutionProfile} from './executionProfiles.js';

export type CoordinatorEvent =
  | {type: 'queued'; id: string; mode: WorkerMode; queued: number; running: number}
  | {type: 'started'; id: string; mode: WorkerMode; queueMs: number; running: number}
  | {type: 'terminal'; id: string; mode: WorkerMode; termination: WorkerTermination; execution: 'settled' | 'quarantined'; queueMs: number; durationMs: number; running: number}
  | {type: 'settled'; id: string; mode: WorkerMode; termination: WorkerTermination; queueMs: number; durationMs: number; running: number};

interface Submission<T> {
  id: string;
  mode: WorkerMode;
  sequence: number;
  batch: number;
  submittedAt: number;
  signal?: AbortSignal;
  run: (context: {id: string; signal: AbortSignal; queueMs: number; deadlineExpired: () => boolean}) => Promise<T>;
  terminal: (termination: WorkerTermination, queueMs: number) => T;
  terminationOf: (value: T) => WorkerTermination;
  resolve: (value: T) => void;
  abortListener?: () => void;
}

/**
 * Turn-scoped worker admission. A deadline returns logical control immediately,
 * but an uncooperative underlying execution remains quarantined and continues
 * to consume its real concurrency/mutation slot until it physically settles.
 */
export class SubagentCoordinator {
  private readonly queue: Array<Submission<unknown>> = [];
  private running = 0;
  private mutationRunning = false;
  /** Read-only workers admitted behind a blocked mutation head (RH-010). */
  private bypassRunning = 0;
  private nextId = 1;
  private nextSequence = 1;
  private submissionBatch = 1;
  private admissionScheduled = false;
  peakConcurrency = 0;
  /** Peak read-only workers running concurrently behind a blocked mutation. */
  peakBypass = 0;

  constructor(private readonly profile: SubagentExecutionProfile, private readonly onEvent?: (event: CoordinatorEvent) => void) {}

  createId() { return `worker-${this.nextId++}`; }

  submit<T>(input: Omit<Submission<T>, 'resolve' | 'submittedAt' | 'sequence' | 'batch' | 'abortListener'>): Promise<T> {
    const submittedAt = performance.now();
    return new Promise<T>(resolve => {
      const item: Submission<T> = {...input, sequence: this.nextSequence++, batch: this.submissionBatch, submittedAt, resolve};
      if (input.signal?.aborted) {
        const value = input.terminal('cancelled', 0);
        this.onEvent?.({type: 'terminal', id: input.id, mode: input.mode, termination: 'cancelled', execution: 'settled', queueMs: 0, durationMs: 0, running: this.running});
        resolve(value);
        return;
      }
      if (input.signal) {
        item.abortListener = () => {
          const index = this.queue.indexOf(item as Submission<unknown>);
          if (index < 0) return;
          this.queue.splice(index, 1);
          const queueMs = performance.now() - submittedAt;
          resolve(input.terminal('cancelled', queueMs));
          this.onEvent?.({type: 'terminal', id: input.id, mode: input.mode, termination: 'cancelled', execution: 'settled', queueMs, durationMs: 0, running: this.running});
        };
        input.signal.addEventListener('abort', item.abortListener, {once: true});
      }
      this.queue.push(item as Submission<unknown>);
      this.onEvent?.({type: 'queued', id: input.id, mode: input.mode, queued: this.queue.length, running: this.running});
      this.scheduleAdmission();
    });
  }

  private scheduleAdmission() {
    if (this.admissionScheduled) return;
    this.admissionScheduled = true;
    queueMicrotask(() => {
      this.admissionScheduled = false;
      const batch = this.submissionBatch++;
      // Only reorder calls emitted in the same model batch. Older blocked work
      // always remains ahead of later submissions, preventing starvation.
      this.queue.sort((a, b) => {
        if (a.batch !== b.batch || a.batch !== batch) return a.sequence - b.sequence;
        if (a.mode === 'implement' && b.mode === 'validate') return -1;
        if (a.mode === 'validate' && b.mode === 'implement') return 1;
        return a.sequence - b.sequence;
      });
      this.admit();
    });
  }

  private admit() {
    // FIFO admission from the queue head. A mutation at the head blocks behind
    // another running mutation; everything else is admitted in order while
    // slots remain free.
    while (this.running < this.profile.maxConcurrency) {
      const item = this.queue[0];
      if (!item || (isMutationMode(item.mode) && this.mutationRunning)) break;
      this.queue.shift();
      if (item.signal && item.abortListener) item.signal.removeEventListener('abort', item.abortListener);
      this.start(item, false);
    }
    // Bounded read-only bypass: while a mutation is blocked at the head, let
    // read-only work waiting behind it consume otherwise-idle slots. The cap is
    // maxConcurrency - 1 so a serialized mutation always retains a free slot
    // the moment the running mutation settles, preventing starvation (RH-010).
    const bypassCap = Math.max(0, this.profile.maxConcurrency - 1);
    while (this.running < this.profile.maxConcurrency && this.bypassRunning < bypassCap) {
      const head = this.queue[0];
      if (!head || !(isMutationMode(head.mode) && this.mutationRunning)) break;
      const index = this.queue.findIndex(item => !isMutationMode(item.mode));
      if (index === -1) break;
      const [item] = this.queue.splice(index, 1);
      if (item.signal && item.abortListener) item.signal.removeEventListener('abort', item.abortListener);
      this.start(item, true);
    }
  }

  private start(item: Submission<unknown>, bypass: boolean) {
    const mutation = isMutationMode(item.mode);
    this.running++;
    if (bypass) {
      this.bypassRunning++;
      this.peakBypass = Math.max(this.peakBypass, this.bypassRunning);
    }
    if (mutation) this.mutationRunning = true;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.running);
    const queueMs = performance.now() - item.submittedAt;
    const controller = new AbortController();
    let abortSource: 'parent' | 'deadline' | undefined;
    let terminalDelivered = false;
    let deliveredTermination: WorkerTermination | undefined;
    const startedAt = performance.now();

    const deliverTerminal = (termination: WorkerTermination, execution: 'settled' | 'quarantined', value?: unknown) => {
      if (terminalDelivered) return;
      terminalDelivered = true;
      deliveredTermination = termination;
      const terminalValue = value ?? item.terminal(termination, queueMs);
      this.onEvent?.({type: 'terminal', id: item.id, mode: item.mode, termination, execution, queueMs, durationMs: performance.now() - startedAt, running: execution === 'settled' ? this.running - 1 : this.running});
      item.resolve(terminalValue);
    };
    const abort = (source: 'parent' | 'deadline', reason: unknown) => {
      if (abortSource) return;
      abortSource = source;
      const termination = source === 'deadline' ? 'deadline_exceeded' : 'cancelled';
      controller.abort(reason);
      // Restore caller control now, without pretending the underlying execution
      // or its real admission/mutation slot has been released.
      deliverTerminal(termination, 'quarantined');
    };
    const parentAbort = () => abort('parent', item.signal?.reason);
    item.signal?.addEventListener('abort', parentAbort, {once: true});
    if (item.signal?.aborted) parentAbort();
    const timer = setTimeout(() => abort('deadline', 'subagent deadline exceeded'), this.profile.deadlineMs);
    this.onEvent?.({type: 'started', id: item.id, mode: item.mode, queueMs, running: this.running});

    void Promise.resolve().then(() => item.run({id: item.id, signal: controller.signal, queueMs, deadlineExpired: () => abortSource === 'deadline'}))
      .then(value => deliverTerminal(item.terminationOf(value), 'settled', value))
      .catch(() => deliverTerminal(abortSource === 'deadline' ? 'deadline_exceeded' : abortSource === 'parent' ? 'cancelled' : 'provider_error', 'settled'))
      .finally(() => {
        clearTimeout(timer);
        item.signal?.removeEventListener('abort', parentAbort);
        this.running--;
        if (bypass) this.bypassRunning--;
        if (mutation) this.mutationRunning = false;
        if (deliveredTermination && abortSource) {
          this.onEvent?.({type: 'settled', id: item.id, mode: item.mode, termination: deliveredTermination, queueMs, durationMs: performance.now() - startedAt, running: this.running});
        }
        this.admit();
      });
  }
}
