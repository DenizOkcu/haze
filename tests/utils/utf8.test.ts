import {describe, expect, it} from 'vitest';
import {truncateUtf8AtBytes, truncateUtf8BufferAtBytes, truncateUtf8TailBufferAtBytes} from '../../src/utils/utf8.js';

describe('UTF-8 byte truncation', () => {
  it('leaves text unchanged at or below the byte boundary', () => {
    expect(truncateUtf8AtBytes('', 0)).toEqual({text: '', bytes: 0, truncated: false});
    expect(truncateUtf8AtBytes('abc', 3)).toEqual({text: 'abc', bytes: 3, truncated: false});
    expect(truncateUtf8AtBytes('é', 2)).toEqual({text: 'é', bytes: 2, truncated: false});
  });

  it('never splits 2, 3, or 4-byte characters in a retained prefix', () => {
    expect(truncateUtf8AtBytes('aé', 2).text).toBe('a');
    expect(truncateUtf8AtBytes('a€', 3).text).toBe('a');
    expect(truncateUtf8AtBytes('a🙂', 4).text).toBe('a');
    expect(truncateUtf8AtBytes('🙂x', 4)).toEqual({text: '🙂', bytes: 4, truncated: true});
  });

  it('supports Buffer prefixes and UTF-8-safe rolling tails', () => {
    const prefix = truncateUtf8BufferAtBytes(Buffer.from('🙂tail'), 5);
    expect(prefix.buffer.toString('utf8')).toBe('🙂t');
    expect(prefix.truncated).toBe(true);

    const tail = truncateUtf8TailBufferAtBytes(Buffer.from('head🙂'), 5);
    expect(tail.buffer.toString('utf8')).toBe('d🙂');
    expect(tail.bytes).toBe(5);
    expect(tail.truncated).toBe(true);
  });
});
