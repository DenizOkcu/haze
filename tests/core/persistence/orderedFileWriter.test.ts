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
});
