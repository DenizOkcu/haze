/**
 * Ordered, backpressure-aware NDJSON sink for headless `--output stream-json`
 * (RH-006). Writes are serialized in arrival order and each line awaits stdout
 * drain when the stream returns false, so a slow/redirected consumer cannot
 * reorder or lose events and the final result line always lands after all
 * streamed events.
 *
 * SU-05: stream errors are captured permanently (an asynchronous error after a
 * `true` return has a listener here), so `flush()` rejects and the caller can
 * report an output-delivery failure instead of exiting 0 with a broken stream.
 */
export interface WritableSink {
  write(chunk: string): boolean;
  once(event: 'drain' | 'error', listener: () => void): unknown;
  off?(event: 'drain' | 'error', listener: () => void): unknown;
}

/** Upper bound on queued lines: an unbounded producer would grow without limit under a stalled consumer. */
const MAX_PENDING_LINES = 1000;

/**
 * Queue a best-effort event write without creating an unhandled rejection.
 * NdjsonSink retains the first delivery error, so the caller's final flush still
 * reports failure and can return a non-zero exit code.
 */
export function queueNdjsonWrite(sink: NdjsonSink, value: unknown): void {
  void sink.write(value).catch(() => undefined);
}

export class NdjsonSink {
  private tail: Promise<void> = Promise.resolve();
  private firstError: Error | undefined;
  private pendingLines = 0;
  private permanentError: Error | undefined;

  constructor(private readonly stream: WritableSink) {
    // Permanent stream-error capture: errors between writes (true returns) or
    // after close also fail the flush instead of vanishing (SU-05).
    stream.once('error', () => {
      this.permanentError ??= new Error('output stream failed');
    });
  }

  /** Serialize one value as an NDJSON line, preserving order and awaiting drain. */
  write(value: unknown): Promise<void> {
    const line = `${JSON.stringify(value)}\n`;
    if (this.permanentError) return Promise.reject(this.permanentError);
    if (this.pendingLines >= MAX_PENDING_LINES) {
      const error = new Error(`output stream stalled; more than ${MAX_PENDING_LINES} lines are waiting to drain`);
      this.permanentError ??= error;
      return Promise.reject(error);
    }
    this.pendingLines += 1;
    const next = this.tail.then(() => this.writeLine(line));
    // Keep the chain draining even if one line fails; surface the first error on flush.
    this.tail = next.catch(error => {
      this.firstError ??= error instanceof Error ? error : new Error(String(error));
    }).finally(() => {
      this.pendingLines -= 1;
    });
    return next;
  }

  private writeLine(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.stream.write(line)) return resolve();
      const onDrain = () => { cleanup(); resolve(); };
      const onError = (error?: Error) => { cleanup(); reject(error ?? new Error('stream error')); };
      const cleanup = () => {
        this.stream.off?.('drain', onDrain);
        this.stream.off?.('error', onError);
      };
      this.stream.once('drain', onDrain);
      this.stream.once('error', onError);
    });
  }

  /** Wait for every queued line to finish writing. Rejects on the first error. */
  async flush(): Promise<void> {
    await this.tail;
    if (this.permanentError) throw this.permanentError;
    if (this.firstError) throw this.firstError;
  }
}
