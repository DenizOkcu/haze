import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {hazeTools} from '../../src/llm/hazeTools.js';

describe('memory tool', () => {
  let tmp: string;
  let originalCwd: string;
  let memoryDir: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-memory-tool-test-'));
    originalCwd = process.cwd();
    process.chdir(tmp);
    memoryDir = path.join(tmp, '.haze-memory');
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(tmp);
  });

  async function runMemory(input: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await hazeTools.memory.execute(input as any, {abortSignal: undefined, experimental_context: undefined});
  }

  it('store returns ok with the persisted entry', async () => {
    const result = await runMemory({operation: 'store', key: 'use zod', value: 'Validate all tool inputs with zod.', tags: ['validation']});
    expect(result).toMatchObject({ok: true, operation: 'store', entry: {key: 'use zod', value: 'Validate all tool inputs with zod.', tags: ['validation']}});
  });

  it('search returns matching entries', async () => {
    await runMemory({operation: 'store', key: 'a', value: 'alpha content', tags: ['greek']});
    await runMemory({operation: 'store', key: 'b', value: 'beta content', tags: ['latin']});
    const result = await runMemory({operation: 'search', query: 'alpha'});
    expect(result).toMatchObject({ok: true, operation: 'search', entries: [{key: 'a', value: 'alpha content'}]});
  });

  it('search returns empty array when nothing matches', async () => {
    const result = await runMemory({operation: 'search', query: 'missing'});
    expect(result).toMatchObject({ok: true, operation: 'search', entries: []});
  });
});
