import {beforeEach, describe, expect, it} from 'vitest';
import {hazeTools} from '../../src/llm/hazeTools.js';
import {storeToolOutput, clearToolOutputs} from '../../src/core/agent/toolOutputStore.js';

describe('readToolOutput tool', () => {
  beforeEach(() => {
    clearToolOutputs();
  });

  async function read(params: {handle: string; offset?: number; limit?: number; query?: string; contextLines?: number}) {
    return await hazeTools.readToolOutput.execute({
      handle: params.handle,
      offset: params.offset ?? 0,
      limit: params.limit ?? 12_000,
      ...(params.query === undefined ? {} : {query: params.query}),
      contextLines: params.contextLines ?? 2,
    }, {abortSignal: undefined});
  }

  it('reports a structured error for an unknown or expired handle', async () => {
    const result = await read({handle: 'output-does-not-exist'});
    expect(result).toMatchObject({ok: false});
    expect((result as {error: string}).error).toContain('Unknown or expired tool output handle');
  });

  it('pages stored output by offset and reports nextOffset until the end', async () => {
    const handle = storeToolOutput('abcdef');
    const first = await read({handle, offset: 0, limit: 4});
    expect(first).toMatchObject({offset: 0, content: 'abcd', nextOffset: 4, totalChars: 6, truncated: true});
    const second = await read({handle, offset: first.nextOffset, limit: 4});
    expect(second).toMatchObject({offset: 4, content: 'ef', truncated: false});
    expect(second.nextOffset).toBeUndefined();
  });

  it('clamps an out-of-range offset to the end of the content', async () => {
    const handle = storeToolOutput('abc');
    const page = await read({handle, offset: 99, limit: 10});
    expect(page).toMatchObject({offset: 3, content: '', truncated: false});
  });

  it('searches with a query and returns match metadata with context lines', async () => {
    const lines = ['line 0', 'line 1', 'NEEDLE here', 'line 3', 'line 4'];
    const handle = storeToolOutput(lines.join('\n'));
    const page = await read({handle, query: 'needle', contextLines: 1});
    expect(page).toMatchObject({query: 'needle', matches: 1});
    expect(page.content).toContain('NEEDLE here');
    expect(page.content).toContain('line 1');
    expect(page.content).toContain('line 3');
    expect(page.content).not.toContain('line 4');
  });

  it('honors contextLines of zero to return only matching lines', async () => {
    const handle = storeToolOutput('before\nmatch me\nafter');
    const page = await read({handle, query: 'match', contextLines: 0});
    expect(page.content).toContain('match me');
    expect(page.content).not.toContain('before');
    expect(page.content).not.toContain('after');
  });
});
