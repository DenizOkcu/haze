import {describe, expect, it} from 'vitest';
import {NdjsonSink, type WritableSink} from '../../../src/cli/commands/ndjsonSink.js';

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
