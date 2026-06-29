import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {cwdHash, clearMemory, listMemory, memoryFile, searchMemory, storeMemory} from '../../src/core/memory/memoryStore.js';

describe('memoryStore', () => {
  let tmp: string;
  let baseDir: string;
  let cwdA: string;
  let cwdB: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-memory-test-'));
    baseDir = path.join(tmp, 'memory');
    cwdA = path.join(tmp, 'workspace-a');
    cwdB = path.join(tmp, 'workspace-b');
    await fs.ensureDir(cwdA);
    await fs.ensureDir(cwdB);
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('stores and reads entries in the configured memory directory', async () => {
    const entry = await storeMemory({key: 'avoid global state', value: 'Use dependency injection for shared services.', tags: ['architecture'], cwd: cwdA, baseDir});
    expect(entry.key).toBe('avoid global state');
    expect(entry.value).toBe('Use dependency injection for shared services.');
    expect(entry.tags).toEqual(['architecture']);
    expect(entry.timestamp).toMatch(/^\d{4}-/);

    const entries = await listMemory(cwdA, baseDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({key: 'avoid global state', value: 'Use dependency injection for shared services.', tags: ['architecture']});
  });

  it('writes memory.jsonl atomically', async () => {
    await storeMemory({key: 'a', value: 'A', cwd: cwdA, baseDir});
    await storeMemory({key: 'b', value: 'B', cwd: cwdA, baseDir});
    const file = memoryFile(cwdA, baseDir);
    const content = await fs.readFile(file, 'utf8');
    expect(content).toContain('"key":"a"');
    expect(content).toContain('"key":"b"');
    expect(content.endsWith('\n')).toBe(true);
    const tmps = await fs.readdir(path.dirname(file));
    expect(tmps.filter(name => name.endsWith('.tmp')).length).toBe(0);
  });

  it('normalizes tags to lowercase and trims them', async () => {
    const entry = await storeMemory({key: 'tagged', value: 'v', tags: ['  TEST  ', '  ', 'convention'], cwd: cwdA, baseDir});
    expect(entry.tags).toEqual(['test', 'convention']);
  });

  it('searches by key substring', async () => {
    await storeMemory({key: 'use async', value: 'Prefer async/await over callbacks.', cwd: cwdA, baseDir});
    await storeMemory({key: 'global state', value: 'Do not use module-level singletons.', cwd: cwdA, baseDir});
    const results = await searchMemory('async', cwdA, baseDir);
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe('use async');
  });

  it('searches by value substring', async () => {
    await storeMemory({key: 'a', value: 'Avoid module-level singletons.', cwd: cwdA, baseDir});
    await storeMemory({key: 'b', value: 'Prefer named exports.', cwd: cwdA, baseDir});
    const results = await searchMemory('singletons', cwdA, baseDir);
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe('a');
  });

  it('searches by tag substring', async () => {
    await storeMemory({key: 'a', value: 'v', tags: ['testing'], cwd: cwdA, baseDir});
    await storeMemory({key: 'b', value: 'v', tags: ['convention'], cwd: cwdA, baseDir});
    const results = await searchMemory('test', cwdA, baseDir);
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe('a');
  });

  it('is isolated per workspace cwd hash', async () => {
    await storeMemory({key: 'a-only', value: 'A', cwd: cwdA, baseDir});
    await storeMemory({key: 'b-only', value: 'B', cwd: cwdB, baseDir});
    const aEntries = await listMemory(cwdA, baseDir);
    const bEntries = await listMemory(cwdB, baseDir);
    expect(aEntries.map(e => e.key)).toEqual(['a-only']);
    expect(bEntries.map(e => e.key)).toEqual(['b-only']);
    expect(cwdHash(cwdA)).not.toBe(cwdHash(cwdB));
  });

  it('clears all entries for the current workspace', async () => {
    await storeMemory({key: 'keep-in-b', value: 'B', cwd: cwdB, baseDir});
    await storeMemory({key: 'clear-me', value: 'A', cwd: cwdA, baseDir});
    await clearMemory(cwdA, baseDir);
    expect(await listMemory(cwdA, baseDir)).toHaveLength(0);
    expect(await listMemory(cwdB, baseDir)).toHaveLength(1);
  });

  it('reports parse errors for malformed lines without dropping valid lines', async () => {
    await storeMemory({key: 'first', value: '1', cwd: cwdA, baseDir});
    const file = memoryFile(cwdA, baseDir);
    await fs.appendFile(file, '{not valid json\n', 'utf8');
    const {entries, parseErrors} = await import('../../src/core/memory/memoryStore.js').then(m => m.readMemoryEntries(cwdA, baseDir));
    expect(entries.map(e => e.key)).toEqual(['first']);
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]).toContain('Line 2');
  });

  it('trims oldest entries after 200 writes', async () => {
    for (let i = 0; i < 205; i++) {
      await storeMemory({key: `entry-${i}`, value: String(i), cwd: cwdA, baseDir, timestamp: `2024-01-01T00:00:00.${String(i).padStart(3, '0')}Z`});
    }
    const entries = await listMemory(cwdA, baseDir);
    expect(entries).toHaveLength(200);
    expect(entries[0].key).toBe('entry-5');
    expect(entries.at(-1)!.key).toBe('entry-204');
  });
});
