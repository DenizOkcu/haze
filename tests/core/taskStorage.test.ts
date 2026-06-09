import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {clearTasks, generateTaskId, getTasksFilePath, loadTasks, saveTasks} from '../../src/core/tasks/taskStorage.js';
import type {Task} from '../../src/core/tasks/taskStorage.js';

describe('taskStorage', () => {
  let tmp: string;
  let originalCwd: typeof process.cwd;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-tasks-test-'));
    await fs.ensureDir(tmp);
    originalCwd = process.cwd;
    process.cwd = () => tmp;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await fs.remove(tmp);
  });

  describe('generateTaskId', () => {
    it('generates an 8-character hex string', () => {
      const id = generateTaskId();
      expect(id).toHaveLength(8);
      expect(id).toMatch(/^[a-f0-9]{8}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) ids.add(generateTaskId());
      expect(ids.size).toBe(100);
    });
  });

  describe('getTasksFilePath', () => {
    it('returns path ending in .haze/tasks.json', () => {
      const filePath = getTasksFilePath();
      expect(filePath.endsWith(`${path.sep}.haze${path.sep}tasks.json`)).toBe(true);
    });
  });

  describe('loadTasks', () => {
    it('returns empty array when no file exists', async () => {
      const tasks = await loadTasks();
      expect(tasks).toEqual([]);
    });

    it('returns empty array on invalid JSON', async () => {
      const dir = path.join(tmp, '.haze');
      await fs.ensureDir(dir);
      await fs.writeFile(path.join(dir, 'tasks.json'), 'not valid json', 'utf-8');
      const tasks = await loadTasks();
      expect(tasks).toEqual([]);
    });

    it('loads existing tasks', async () => {
      const taskData: Task[] = [
        {id: 'test-id1', title: 'Task 1', status: 'pending', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z'},
        {id: 'test-id2', title: 'Task 2', status: 'completed', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z'},
      ];
      const dir = path.join(tmp, '.haze');
      await fs.ensureDir(dir);
      await fs.writeFile(path.join(dir, 'tasks.json'), JSON.stringify(taskData), 'utf-8');
      const tasks = await loadTasks();
      expect(tasks).toEqual(taskData);
    });
  });

  describe('saveTasks', () => {
    it('creates directory and file', async () => {
      const tasks: Task[] = [
        {id: 'new-task', title: 'New Task', status: 'pending', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z'},
      ];
      await saveTasks(tasks);
      const content = await fs.readFile(getTasksFilePath(), 'utf-8');
      expect(JSON.parse(content)).toEqual(tasks);
    });

    it('overwrites existing file', async () => {
      await saveTasks([{id: 'a', title: 'Old', status: 'pending', createdAt: '', updatedAt: ''}]);
      const updated: Task[] = [{id: 'b', title: 'New', status: 'completed', createdAt: '', updatedAt: ''}];
      await saveTasks(updated);
      const loaded = await loadTasks();
      expect(loaded).toEqual(updated);
    });

    it('saves with pretty formatting', async () => {
      await saveTasks([{id: 'a', title: 'Task', status: 'pending', createdAt: '', updatedAt: ''}]);
      const content = await fs.readFile(getTasksFilePath(), 'utf-8');
      expect(content).toContain('\n');
      expect(content).toContain('  ');
    });
  });

  describe('clearTasks', () => {
    it('clears existing tasks', async () => {
      await saveTasks([{id: 'a', title: 'Task', status: 'pending', createdAt: '', updatedAt: ''}]);
      await clearTasks();
      expect(await loadTasks()).toEqual([]);
    });

    it('works when no tasks exist', async () => {
      await clearTasks();
      expect(await loadTasks()).toEqual([]);
    });
  });

  describe('full lifecycle', () => {
    it('create, update, clear', async () => {
      const task: Task = {id: generateTaskId(), title: 'First', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()};
      await saveTasks([task]);
      let loaded = await loadTasks();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.title).toBe('First');

      loaded[0]!.status = 'completed';
      await saveTasks(loaded);
      loaded = await loadTasks();
      expect(loaded[0]!.status).toBe('completed');

      await clearTasks();
      loaded = await loadTasks();
      expect(loaded).toEqual([]);
    });
  });
});
