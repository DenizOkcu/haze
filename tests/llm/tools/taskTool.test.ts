import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

async function readStoredTasks(): Promise<unknown[]> {
  const stored = await fs.readJson(path.join(tmp, 'tasks.json'));
  return Array.isArray(stored) ? stored : [];
}

let tmp = '';
let originalCwd: typeof process.cwd;

async function loadTaskTool() {
  vi.doMock('../../../src/core/tasks/taskStorage.js', async () => {
    const actual = await vi.importActual<typeof import('../../../src/core/tasks/taskStorage.js')>('../../../src/core/tasks/taskStorage.js');
    return {
      ...actual,
      getTasksFilePath: () => path.join(tmp, 'tasks.json'),
      saveTasks: async (tasks: Parameters<typeof actual.saveTasks>[0]) => {
        await fs.ensureDir(tmp);
        await fs.writeJson(path.join(tmp, 'tasks.json'), tasks, {spaces: 2});
      },
    };
  });
  vi.resetModules();
  return import('../../../src/llm/tools/taskTool.js');
}

describe('writeTasksTool.execute', () => {
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-tasktool-test-'));
    originalCwd = process.cwd;
    process.cwd = () => tmp;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    vi.restoreAllMocks();
    await fs.remove(tmp);
  });

  it('persists tasks with generated ids and timestamps', async () => {
    const {writeTasksTool} = await loadTaskTool();
    const result = await writeTasksTool.execute({tasks: [
      {title: 'First', status: 'in_progress'},
      {title: 'Second'},
    ]}, {toolCallId: 'x', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toMatchObject({ok: true, taskCount: 2});
    const stored = await readStoredTasks() as Array<{id: string; title: string; status: string}>;
    expect(stored).toHaveLength(2);
    expect(stored[0]?.title).toBe('First');
    expect(stored[0]?.status).toBe('in_progress');
    expect(stored[0]?.id).toMatch(/^[a-f0-9]{8}$/);
    expect(stored[1]?.status).toBe('pending');
  });

  it('reports the count breakdown by status', async () => {
    const {writeTasksTool} = await loadTaskTool();
    const result = await writeTasksTool.execute({tasks: [
      {title: 'a', status: 'completed'},
      {title: 'b', status: 'completed'},
      {title: 'c', status: 'in_progress'},
      {title: 'd'},
    ]}, {toolCallId: 'x', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toMatchObject({
      ok: true,
      taskCount: 4,
      counts: {pending: 1, in_progress: 1, completed: 2},
    });
    expect((result as {summary: string}).summary).toContain('1 pending');
    expect((result as {summary: string}).summary).toContain('2 completed');
    expect((result as {summary: string}).summary).toContain('1 in progress');
  });

  it('clears the list when given an empty array', async () => {
    const {writeTasksTool} = await loadTaskTool();
    await writeTasksTool.execute({tasks: [{title: 'keep me'}]}, {toolCallId: 'x', messages: [], abortSignal: new AbortController().signal} as never);
    const cleared = await writeTasksTool.execute({tasks: []}, {toolCallId: 'x', messages: [], abortSignal: new AbortController().signal} as never);
    expect(cleared).toEqual({ok: true, taskCount: 0, summary: 'Task list cleared.'});
    expect(await readStoredTasks()).toEqual([]);
  });

  it('rejects a non-array tasks argument with a structured error', async () => {
    const {writeTasksTool} = await loadTaskTool();
    const result = await writeTasksTool.execute({tasks: 'oops' as never}, {toolCallId: 'x', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toEqual({ok: false, error: 'Tasks must be an array. Pass an empty array to clear the list.'});
  });

  it('rejects an entry with a blank title and reports its 1-based index', async () => {
    const {writeTasksTool} = await loadTaskTool();
    const result = await writeTasksTool.execute({tasks: [
      {title: 'fine'},
      {title: '   '},
    ]}, {toolCallId: 'x', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toEqual({ok: false, error: 'Task 2: title cannot be empty.'});
  });

  it('rejects an entry with an over-long title and reports its 1-based index', async () => {
    const {writeTasksTool} = await loadTaskTool();
    const longTitle = 'a'.repeat(201);
    const result = await writeTasksTool.execute({tasks: [
      {title: 'fine'},
      {title: longTitle},
    ]}, {toolCallId: 'x', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toEqual({ok: false, error: 'Task 2: title is too long (max 200 characters).'});
  });

  it('trims whitespace around titles before persisting', async () => {
    const {writeTasksTool} = await loadTaskTool();
    await writeTasksTool.execute({tasks: [{title: '  Trim me  '}]}, {toolCallId: 'x', messages: [], abortSignal: new AbortController().signal} as never);
    const stored = await readStoredTasks() as Array<{title: string}>;
    expect(stored[0]?.title).toBe('Trim me');
  });

  it('writes through the configured tasks.json path under the workspace', async () => {
    const {writeTasksTool} = await loadTaskTool();
    await writeTasksTool.execute({tasks: [{title: 'on disk'}]}, {toolCallId: 'x', messages: [], abortSignal: new AbortController().signal} as never);
    expect(await fs.pathExists(path.join(tmp, 'tasks.json'))).toBe(true);
  });
});
