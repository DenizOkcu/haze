import {describe, expect, it, vi} from 'vitest';
import {NdjsonSink, queueNdjsonWrite, type WritableSink} from '../../../src/cli/commands/ndjsonSink.js';

/** A fake stream that backpressures the first write (returns false) then drains on demand. */
function backpressureStream(): WritableSink & {lines: string[]; drain(): void} {
  const lines: string[] = [];
  const drainListeners = new Set<() => void>();
  let first = true;
  return {
    lines,
    write(chunk: string) {
      lines.push(chunk);
      if (first) { first = false; return false; }
      return true;
    },
    once(event, listener) {
      if (event === 'drain') drainListeners.add(listener);
      return this;
    },
    off(event, listener) {
      if (event === 'drain') drainListeners.delete(listener);
      return this;
    },
    drain() {
      const listeners = [...drainListeners];
      drainListeners.clear();
      for (const listener of listeners) listener();
    },
  };
}

/** A fake stream that never drains and captures permanent error listeners (SU-05). */
function errorCapturingStream(): WritableSink & {lines: string[]; errorListeners: Array<() => void>} {
  const lines: string[] = [];
  const errorListeners: Array<() => void> = [];
  return {
    lines,
    errorListeners,
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
    once(event, listener) {
      if (event === 'error') errorListeners.push(listener);
      return this;
    },
    off: () => undefined,
  };
}

describe('NdjsonSink delivery (SU-05)', () => {
  it('captures asynchronous stream errors after a true return and fails flush', async () => {
    const stream = errorCapturingStream();
    const sink = new NdjsonSink(stream);
    await sink.write({ok: true});
    // Stream breaks between writes (no drain pending): flush must reject so the
    // headless command can exit non-zero instead of reporting a lost result.
    stream.errorListeners[0]?.();
    await expect(sink.write({late: true})).rejects.toThrow(/output stream failed/);
    await expect(sink.flush()).rejects.toThrow(/output stream failed/);
  });

  it('observes fire-and-forget event write failures while preserving them for flush', async () => {
    const stream = errorCapturingStream();
    const sink = new NdjsonSink(stream);
    stream.errorListeners[0]?.();
    queueNdjsonWrite(sink, {late: true});
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(sink.flush()).rejects.toThrow(/output stream failed/);
  });

  it('bounds the pending queue under a permanently stalled consumer', async () => {
    // Only the first write backpressures; later writes flow once it drains, so
    // exactly the two writes beyond the bound are rejected without a hang.
    let first = true;
    const drainListeners = new Set<() => void>();
    const stream: WritableSink = {
      write: () => {
        if (first) { first = false; return false; }
        return true;
      },
      once: (event, listener) => {
        if (event === 'drain') drainListeners.add(listener);
        return stream;
      },
      off: (_event, listener) => {
        drainListeners.delete(listener);
        return stream;
      },
    };
    const sink = new NdjsonSink(stream);
    const outcomes = Array.from({length: 1002}, (_, i) => sink.write({i}).then(() => 'written', error => error instanceof Error ? error.message : String(error)));
    // The first writeLine registers its drain listener in a microtask; fire it
    // once registered so the remaining bounded chain can drain and settle.
    await vi.waitFor(() => expect(drainListeners.size).toBeGreaterThan(0));
    for (const listener of [...drainListeners]) listener();
    const settled = await Promise.all(outcomes);
    // Writes beyond the bound fail fast instead of queueing without limit.
    expect(settled.filter(result => /stalled/.test(String(result)))).toHaveLength(2);
    await expect(sink.flush()).rejects.toThrow(/stalled/);
  });
});

describe('NdjsonSink', () => {
  it('serializes writes in arrival order, including across backpressure', async () => {
    const stream = backpressureStream();
    const sink = new NdjsonSink(stream);
    for (let i = 0; i < 5; i++) void sink.write({i});
    // Let the first writeLine run and register its drain listener before draining.
    await new Promise(resolve => setTimeout(resolve, 0));
    const flush = sink.flush();
    stream.drain(); // unblock the first (backpressured) write; the rest flow in order
    await flush;
    const parsed = stream.lines.map(line => JSON.parse(line) as {i: number});
    expect(parsed.map(value => value.i)).toEqual([0, 1, 2, 3, 4]);
  });

  it('flush resolves only after every queued line is written', async () => {
    const stream = backpressureStream();
    const sink = new NdjsonSink(stream);
    void sink.write({a: 1});
    void sink.write({a: 2});
    await new Promise(resolve => setTimeout(resolve, 0));
    let resolved = false;
    const flush = sink.flush().then(() => { resolved = true; });
    stream.drain();
    await flush;
    expect(resolved).toBe(true);
    expect(stream.lines).toHaveLength(2);
  });

  it('emits one NDJSON line per value', async () => {
    const lines: string[] = [];
    const stream: WritableSink = {write: (chunk: string) => { lines.push(chunk); return true; }, once: () => undefined, off: () => undefined};
    const sink = new NdjsonSink(stream);
    await sink.write({hello: 'world'});
    await sink.flush();
    expect(lines).toEqual([`${JSON.stringify({hello: 'world'})}\n`]);
  });
});
