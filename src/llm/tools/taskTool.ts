import {tool} from 'ai';
import {z} from 'zod';
import {generateTaskId, saveTasks, type Task, type TaskStatus} from '../../core/tasks/taskStorage.js';

export const writeTasksTool = tool({
  description: 'Replace the task list for substantial work. Update at meaningful phase changes, blockers, and completion; pass the complete list.',
  inputSchema: z.object({
    tasks: z.array(z.object({
      title: z.string().max(200).describe('Short task description'),
      status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('Task status (defaults to pending)'),
    })).describe('Complete task list. Replaces any existing tasks. Pass an empty array to clear.'),
  }),
  execute: async ({tasks: inputTasks}) => {
    if (!Array.isArray(inputTasks)) {
      return {ok: false, error: 'Tasks must be an array. Pass an empty array to clear the list.'};
    }
    for (let i = 0; i < inputTasks.length; i++) {
      const title = inputTasks[i]?.title?.trim();
      if (!title) return {ok: false, error: `Task ${i + 1}: title cannot be empty.`};
      if (title.length > 200) return {ok: false, error: `Task ${i + 1}: title is too long (max 200 characters).`};
    }
    const now = new Date().toISOString();
    const tasks: Task[] = inputTasks.map((input: {title: string; status?: TaskStatus}) => ({
      id: generateTaskId(),
      title: input.title.trim(),
      status: input.status ?? 'pending',
      createdAt: now,
      updatedAt: now,
    }));
    await saveTasks(tasks);
    if (tasks.length === 0) return {ok: true, taskCount: 0, summary: 'Task list cleared.'};
    const counts = {
      pending: tasks.filter(t => t.status === 'pending').length,
      in_progress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
    };
    return {ok: true, taskCount: tasks.length, counts, summary: `Tasks: ${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed.`};
  },
});
