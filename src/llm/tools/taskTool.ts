import {tool} from 'ai';
import {z} from 'zod';
import {generateTaskId, saveTasks, type Task, type TaskStatus} from '../../core/tasks/taskStorage.js';

/**
 * Size policy: task titles are never Zod-capped. A schema `.max()` turns an
 * over-long string into a hard `AI_TypeValidationError` that rejects the whole
 * call, so `execute` truncates titles instead.
 */
const TITLE_CHARS = 200;

function truncate(value: string, max: number) {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

export const writeTasksTool = tool({
  description: 'Replace the task list for substantial work. Update tasks at meaningful phase changes, blockers, and completion; pass the complete list.',
  inputSchema: z.object({
    tasks: z.array(z.object({
      title: z.string().min(1).describe('Short task description'),
      status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('Task status (defaults to pending)'),
    })).describe('Complete task list. Replaces any existing tasks. Pass an empty array to clear.'),
  }),
  execute: async ({tasks: inputTasks}) => {
    if (!Array.isArray(inputTasks)) {
      return {ok: false, error: 'Tasks must be an array. Pass an empty array to clear the list.'};
    }
    for (let i = 0; i < inputTasks.length; i++) {
      if (!inputTasks[i]?.title?.trim()) return {ok: false, error: `Task ${i + 1}: title cannot be empty.`};
    }
    const now = new Date().toISOString();
    const tasks: Task[] = inputTasks.map((input: {title: string; status?: TaskStatus}) => ({
      id: generateTaskId(),
      title: truncate(input.title, TITLE_CHARS),
      status: input.status ?? 'pending',
      createdAt: now,
      updatedAt: now,
    }));
    await saveTasks(tasks);
    const counts = {
      pending: tasks.filter(t => t.status === 'pending').length,
      in_progress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
    };
    return {
      ok: true,
      taskCount: tasks.length,
      ...(tasks.length > 0 ? {counts} : {}),
      summary: tasks.length === 0
        ? 'Task list cleared.'
        : `Tasks: ${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed.`,
    };
  },
});
