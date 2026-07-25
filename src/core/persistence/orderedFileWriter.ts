export class OrderedFileWriter<T> {
  private tail: Promise<void> = Promise.resolve();
  private firstError: Error | undefined;
  private closed = false;

  constructor(private readonly write: (value: T) => Promise<void>) {}

  append(value: T): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Writer is closed.'));
    this.tail = this.tail.then(() => this.write(value)).catch(error => {
      this.firstError ??= error instanceof Error ? error : new Error(String(error));
    });
    return this.tail;
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
