/**
 * Ordered, backpressure-aware NDJSON sink for headless `--output stream-json`
 * (RH-006). Writes are serialized in arrival order and each line awaits stdout
 * drain when the stream returns false, so a slow/redirected consumer cannot
 * reorder or lose events and the final result line always lands after all
 * streamed events.
 */
export interface WritableSink {
  write(chunk: string): boolean;
  once(event: 'drain' | 'error', listener: () => void): unknown;
  off?(event: 'drain' | 'error', listener: () => void): unknown;
}

export class NdjsonSink {
  private tail: Promise<void> = Promise.resolve();
  private firstError: Error | undefined;

  constructor(private readonly stream: WritableSink) {}

  /** Serialize one value as an NDJSON line, preserving order and awaiting drain. */
  write(value: unknown): Promise<void> {
    const line = `${JSON.stringify(value)}\n`;
    const next = this.tail.then(() => this.writeLine(line));
    // Keep the chain draining even if one line fails; surface the first error on flush.
    this.tail = next.catch(error => {
      this.firstError ??= error instanceof Error ? error : new Error(String(error));
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
    if (this.firstError) throw this.firstError;
  }
}
