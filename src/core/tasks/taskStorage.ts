import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {resolveWorkspacePath} from '../../utils/path.js';
import {assertRealPathInsideWorkspace, assertWritablePathInsideWorkspace} from '../../utils/path.js';

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
    const filePath = getTasksFilePath();
    // CI-05: real-path confinement — a symlinked `.haze`/`tasks.json` must not
    // redirect task state outside the workspace. Refusal is nonfatal (CR-012).
    await assertRealPathInsideWorkspace(filePath, filePath);
    const content = await fs.readFile(filePath, 'utf-8');
    return tasksSchema.parse(JSON.parse(content));
  } catch {
    return [];
  }
}

export async function saveTasks(tasks: Task[]): Promise<void> {
  const filePath = getTasksFilePath();
  // Mutation guards fail closed: an escaped real path throws instead of writing.
  await assertWritablePathInsideWorkspace(filePath, filePath);
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, JSON.stringify(tasks, null, 2), 'utf-8');
}

export async function clearTasks(): Promise<void> {
  await saveTasks([]);
}
