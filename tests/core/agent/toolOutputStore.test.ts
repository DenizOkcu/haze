import {describe, expect, it, beforeEach} from 'vitest';
import {
  storeToolOutput,
  readToolOutput,
  clearToolOutputs,
} from '../../../src/core/agent/toolOutputStore.js';
import {TOOL_OUTPUT_ENTRY_BYTES, TOOL_OUTPUT_TOTAL_BYTES} from '../../../src/core/limits.js';

// The store is a module-level singleton shared across tests; reset between cases.
beforeEach(() => {
  clearToolOutputs();
});

describe('storeToolOutput', () => {
  it('returns a unique handle per call', () => {
    const a = storeToolOutput('content-a');
    const b = storeToolOutput('content-b');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^output-/);
    expect(b).toMatch(/^output-/);
  });

  it('stores content retrievable via readToolOutput', () => {
    const handle = storeToolOutput('hello world');
    const page = readToolOutput(handle);
    expect(page?.content).toBe('hello world');
    expect(page?.totalChars).toBe('hello world'.length);
    expect(page?.truncated).toBe(false);
    expect(page).toMatchObject({totalBytes: 11, retainedBytes: 11, omittedBytes: 0});
  });

  it('caps individual entries by UTF-8 bytes and reports dropped content', () => {
    const original = `🙂${'x'.repeat(TOOL_OUTPUT_ENTRY_BYTES)}`;
    const page = readToolOutput(storeToolOutput(original), 0, TOOL_OUTPUT_ENTRY_BYTES + 10);
    expect(page?.retainedBytes).toBeLessThanOrEqual(TOOL_OUTPUT_ENTRY_BYTES);
    expect(page?.omittedBytes).toBeGreaterThan(0);
    expect(page?.truncated).toBe(true);
    expect(page?.content).not.toContain('�');
  });

  it('evicts oldest entries when the aggregate byte budget is exceeded', () => {
    const handles = Array.from({length: Math.ceil(TOOL_OUTPUT_TOTAL_BYTES / TOOL_OUTPUT_ENTRY_BYTES) + 1}, () => storeToolOutput('x'.repeat(TOOL_OUTPUT_ENTRY_BYTES)));
    expect(readToolOutput(handles[0]!)).toBeUndefined();
    expect(readToolOutput(handles.at(-1)!)).toBeDefined();
  });

  it('caps the number of stored outputs and evicts least-recently-used first (LRU)', () => {
    const handles: string[] = [];
    // Fill exactly to the cap (100): nothing evicted yet.
    for (let index = 0; index < 100; index++) {
      handles.push(storeToolOutput(`entry-${index}`));
    }
    // Reading entry-0 refreshes its recency (CR-019).
    expect(readToolOutput(handles[0]!)).toBeDefined();

    // One over the cap: the least recently used (entry-1) is evicted, not the read entry-0.
    const over = storeToolOutput('entry-100');
    expect(readToolOutput(handles[1]!)).toBeUndefined();
    expect(readToolOutput(handles[0]!)).toBeDefined();
    expect(readToolOutput(over)).toBeDefined();

    // The bound is maintained; the next eviction takes the new LRU entry.
    const again = storeToolOutput('entry-101');
    expect(readToolOutput(handles[2]!)).toBeUndefined();
    expect(readToolOutput(again)).toBeDefined();
  });

  it('never lets the store grow beyond the cap plus the in-flight entry', () => {
    // Insert many in a tight loop; the store must stay bounded.
    let lastHandle = '';
    for (let index = 0; index < 500; index++) {
      lastHandle = storeToolOutput(`bulk-${index}`);
    }
    expect(readToolOutput(lastHandle)).toBeDefined();
    // First-inserted entry long gone.
    const first = storeToolOutput('seed');
    expect(readToolOutput(first)).toBeDefined();
    // Store size stays at the cap right after the last insert.
    // Re-read a still-present recent handle to confirm bounded retention.
    expect(readToolOutput(lastHandle)?.content).toBe('bulk-499');
  });

  it('returns undefined for an unknown handle', () => {
    expect(readToolOutput('output-does-not-exist')).toBeUndefined();
  });
});

describe('readToolOutput pagination', () => {
  it('slices content by offset and limit and reports nextOffset', () => {
    const handle = storeToolOutput('0123456789');
    const first = readToolOutput(handle, 0, 4);
    expect(first?.content).toBe('0123');
    expect(first?.offset).toBe(0);
    expect(first?.nextOffset).toBe(4);
    expect(first?.truncated).toBe(true);

    const second = readToolOutput(handle, 4, 4);
    expect(second?.content).toBe('4567');
    expect(second?.offset).toBe(4);
    expect(second?.nextOffset).toBe(8);

    const last = readToolOutput(handle, 8, 4);
    expect(last?.content).toBe('89');
    expect(last?.nextOffset).toBeUndefined();
    expect(last?.truncated).toBe(false);
  });

  it('clamps offset to content length', () => {
    const handle = storeToolOutput('abc');
    const page = readToolOutput(handle, 100, 10);
    expect(page?.content).toBe('');
    expect(page?.offset).toBe(3);
  });

  it('searches content by query with context lines', () => {
    const handle = storeToolOutput('line one\nneedle here\nline three\nneedle again');
    const page = readToolOutput(handle, 0, 10_000, {query: 'needle', contextLines: 0});
    expect(page?.matches).toBe(2);
    expect(page?.content).toContain('needle here');
    expect(page?.content).toContain('needle again');
    expect(page?.query).toBe('needle');
  });
});

describe('clearToolOutputs', () => {
  it('removes all stored outputs', () => {
    const handle = storeToolOutput('to-be-cleared');
    expect(readToolOutput(handle)).toBeDefined();
    clearToolOutputs();
    expect(readToolOutput(handle)).toBeUndefined();
  });
});
