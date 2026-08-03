import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {resolveWorkspacePath} from '../../utils/path.js';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Corrupt or structurally invalid files fall back to an empty list, matching
// the documented "loading errors return an empty list" contract (CR-012).
const tasksSchema = z.array(taskSchema);

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
    return tasksSchema.parse(JSON.parse(content));
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
