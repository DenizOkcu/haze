/**
 * Serializes async writes so appends land in arrival order, even when an earlier
 * write rejects. Two contract points worth knowing:
 *   - The per-`append` promise rejects with the specific error of that write,
 *     so awaiting callers see their own failure. Subsequent appends still
 *     chain (the queue keeps draining) so a single bad write does not wedge
 *     the writer or reject unrelated callers.
 *   - `error()` and `flush()` surface the *first* captured error and never
 *     clear it; later successful writes do not reset the sticky state.
 */
export class OrderedFileWriter<T> {
  private tail: Promise<void> = Promise.resolve();
  private firstError: Error | undefined;
  private closed = false;

  constructor(private readonly write: (value: T) => Promise<void>) {}

  append(value: T): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Writer is closed.'));
    // per-call result: rejects only with this append's own write error
    const result = this.tail.then(() => this.write(value)).catch(error => {
      this.firstError ??= error instanceof Error ? error : new Error(String(error));
      throw error;
    });
    // Chain continues regardless so later appends are not blocked by this one's failure.
    this.tail = result.catch(() => undefined);
    return result;
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.firstError) throw this.firstError;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  error(): Error | undefined {
    return this.firstError;
  }
}
