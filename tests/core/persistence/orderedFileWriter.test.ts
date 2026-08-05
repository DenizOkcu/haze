import {describe, expect, it} from 'vitest';
import {OrderedFileWriter} from '../../../src/core/persistence/orderedFileWriter.js';

describe('OrderedFileWriter', () => {
  it('serializes appends and flush waits for completion', async () => {
    const values: number[] = [];
    const writer = new OrderedFileWriter<number>(async value => {
      await new Promise(resolve => setTimeout(resolve, value === 1 ? 10 : 0));
      values.push(value);
    });
    writer.append(1);
    writer.append(2);
    await writer.flush();
    expect(values).toEqual([1, 2]);
  });

  it('reports the first write failure on flush', async () => {
    const writer = new OrderedFileWriter<number>(async () => { throw new Error('disk full'); });
    writer.append(1);
    await expect(writer.flush()).rejects.toThrow('disk full');
  });

  it('rejects the per-append promise on failure but keeps draining the queue', async () => {
    const calls: number[] = [];
    let first = true;
    const writer = new OrderedFileWriter<number>(async value => {
      calls.push(value);
      if (first) {
        first = false;
        throw new Error('transient');
      }
    });
    const firstAppend = writer.append(1);
    const secondAppend = writer.append(2);
    await expect(firstAppend).rejects.toThrow('transient');
    await secondAppend;
    expect(calls).toEqual([1, 2]);
    expect(writer.error()?.message).toBe('transient');
  });

  it('serializes concurrent appends in arrival order', async () => {
    const sequence: number[] = [];
    const writer = new OrderedFileWriter<number>(async value => {
      // Vary latency so a fast writer could otherwise reorder.
      await new Promise(resolve => setTimeout(resolve, value % 2 === 0 ? 5 : 20));
      sequence.push(value);
    });
    // Fire 5 appends near-simultaneously; arrival order is 0..4.
    const promises = [0, 1, 2, 3, 4].map(value => writer.append(value));
    await Promise.all(promises);
    expect(sequence).toEqual([0, 1, 2, 3, 4]);
  });
});
