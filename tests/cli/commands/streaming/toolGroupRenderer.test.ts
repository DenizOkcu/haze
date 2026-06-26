import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createToolGroupRenderer} from '../../../../src/cli/commands/streaming/toolGroupRenderer.js';
import type {NativeToolCall} from '../../../../src/cli/commands/streaming/toolGroupRenderer.js';

function fakeDeps() {
  const messages: Array<{id: string; role: string; text: string; streaming: boolean}> = [];
  const updates: Array<{id: string; update: {text?: string; streaming?: boolean}}> = [];
  const debug: string[] = [];
  const events: unknown[] = [];
  return {
    addMessage: (msg: {id: string; role: 'tool'; text: string; streaming: boolean}) => {
      messages.push(msg);
    },
    updateMessage: (id: string, update: {text?: string; streaming?: boolean}) => {
      updates.push({id, update});
    },
    debugLog: (line: string) => {
      debug.push(line);
    },
    onEvent: (event: unknown) => {
      events.push(event);
    },
    messages,
    updates,
    debug,
    events,
  };
}

function call(id: string, name: string, input: unknown = {}): NativeToolCall {
  return {toolCallId: id, toolName: name, input};
}

describe('createToolGroupRenderer', () => {

  it('creates a tool item on first sight and emits a streaming addMessage', () => {
    const deps = fakeDeps();
    const r = createToolGroupRenderer(deps);
    const item = r.ensureToolItem(call('a', 'readFile', {path: 'x.ts'}));
    expect(item.id).toBe('a');
    expect(item.status).toBe('running');
    expect(item.startedAt).toBeGreaterThan(0);
    expect(deps.messages).toHaveLength(1);
    expect(deps.messages[0]?.role).toBe('tool');
    expect(deps.messages[0]?.streaming).toBe(true);
    expect(deps.events.some((e) => (e as {type?: string}).type === 'tool_start')).toBe(true);
  });

  it('returns the same item for the same toolCallId (idempotent)', () => {
    const deps = fakeDeps();
    const r = createToolGroupRenderer(deps);
    const first = r.ensureToolItem(call('a', 'readFile', {path: 'x.ts'}));
    const second = r.ensureToolItem(call('a', 'readFile', {path: 'x.ts'}));
    expect(second).toBe(first);
    expect(deps.messages).toHaveLength(1);
  });

  it('finalizes the group when finalizeToolGroup is called', () => {
    const deps = fakeDeps();
    const r = createToolGroupRenderer(deps);
    r.ensureToolItem(call('a', 'readFile', {path: 'x.ts'}));
    deps.updates.length = 0;
    r.finalizeToolGroup();
    const lastUpdate = deps.updates[deps.updates.length - 1]!;
    expect(lastUpdate.update.streaming).toBe(false);
  });

  it('startFreshToolGroup finalizes the current group and starts a new one on the next call', () => {
    const deps = fakeDeps();
    const r = createToolGroupRenderer(deps);
    r.ensureToolItem(call('a', 'readFile', {path: 'x.ts'}));
    r.updateToolGroup(false);
    const firstGroupId = deps.messages[0]?.id;
    r.startFreshToolGroup();
    r.ensureToolItem(call('b', 'grep', {pattern: 'foo'}));
    expect(deps.messages).toHaveLength(2);
    const secondGroupId = deps.messages[1]?.id;
    expect(secondGroupId).not.toBe(firstGroupId);
  });

  it('startFreshToolGroup is a no-op when the current group is still running', () => {
    const deps = fakeDeps();
    const r = createToolGroupRenderer(deps);
    r.ensureToolItem(call('a', 'readFile', {path: 'x.ts'}));
    const idBefore = deps.messages[0]?.id;
    r.startFreshToolGroup();
    r.ensureToolItem(call('b', 'readFile', {path: 'y.ts'}));
    expect(deps.messages).toHaveLength(1);
    expect(deps.messages[0]?.id).toBe(idBefore);
  });

  it('renders an error count when one item fails', () => {
    const deps = fakeDeps();
    const r = createToolGroupRenderer(deps);
    const item = r.ensureToolItem(call('a', 'editFile', {path: 'x.ts', old_text: 'x', new_text: 'y'}));
    item.status = 'error';
    item.result = 'old_text_missing';
    r.updateToolGroup(true);
    const lastText = deps.updates.at(-1)?.update.text ?? '';
    expect(lastText).toContain('1 calls');
    expect(lastText).toContain('1 failed');
    expect(lastText).toContain('1 changes');
  });

  it('renders a success check for completed items', () => {
    const deps = fakeDeps();
    const r = createToolGroupRenderer(deps);
    const item = r.ensureToolItem(call('a', 'readFile', {path: 'x.ts'}));
    item.status = 'success';
    item.result = '12 lines';
    item.durationMs = 250;
    r.updateToolGroup(true);
    const lastText = deps.updates.at(-1)?.update.text ?? '';
    expect(lastText).toContain('✓');
    expect(lastText).toContain('readFile');
    expect(lastText).toContain('12 lines');
  });

  it('stopToolTimer is safe to call repeatedly', () => {
    const deps = fakeDeps();
    const r = createToolGroupRenderer(deps);
    r.ensureToolItem(call('a', 'readFile', {path: 'x.ts'}));
    r.stopToolTimer();
    r.stopToolTimer();
    r.stopToolTimer();
  });

  it('updateToolGroup(true) sends a streaming update to the existing message', () => {
    const deps = fakeDeps();
    const r = createToolGroupRenderer(deps);
    r.ensureToolItem(call('a', 'readFile', {path: 'x.ts'}));
    deps.updates.length = 0;
    r.updateToolGroup(true);
    expect(deps.updates.length).toBeGreaterThan(0);
    const update = deps.updates[deps.updates.length - 1]!;
    expect(update.id).toBe(deps.messages[0]?.id);
    expect(update.update.streaming).toBe(true);
  });

  it('debug-logs every tool start', () => {
    const deps = fakeDeps();
    const r = createToolGroupRenderer(deps);
    r.ensureToolItem(call('a', 'readFile', {path: 'x.ts'}));
    expect(deps.debug.some((line) => line.includes('tool start'))).toBe(true);
  });

  it('emits a tool_call entry into deps.log via appendLogEntry', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-tgr-log-'));
    try {
      const deps = fakeDeps();
      const log = {file: path.join(tmp, 'log.jsonl')} as never;
      const r = createToolGroupRenderer({...deps, log});
      r.ensureToolItem(call('a', 'readFile', {path: 'x.ts'}));
      // Wait for the fire-and-forget logAppend to flush to disk.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (await fs.pathExists(log.file)) {
          const stat = await fs.stat(log.file);
          if (stat.size > 0) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const content = await fs.readFile(log.file, 'utf8').catch(() => '');
      expect(content).toContain('"type":"tool_call"');
      expect(content).toContain('"name":"readFile"');
    } finally {
      await fs.remove(tmp);
    }
  });
});
