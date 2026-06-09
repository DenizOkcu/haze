import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveWorkspacePath} from '../../utils/path.js';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

const TASKS_DIR = '.haze';
const TASKS_FILE = 'tasks.json';

export function getTasksFilePath(): string {
  return resolveWorkspacePath(path.join(TASKS_DIR, TASKS_FILE));
}

export function generateTaskId(): string {
  return randomUUID().slice(0, 8);
}

export async function loadTasks(): Promise<Task[]> {
  try {
    const content = await fs.readFile(getTasksFilePath(), 'utf-8');
    return JSON.parse(content) as Task[];
  } catch {
    return [];
  }
}

export async function saveTasks(tasks: Task[]): Promise<void> {
  const filePath = getTasksFilePath();
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, JSON.stringify(tasks, null, 2), 'utf-8');
}

export async function clearTasks(): Promise<void> {
  await saveTasks([]);
}
