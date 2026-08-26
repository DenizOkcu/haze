import {tool} from 'ai';
import {z} from 'zod';
import {generateTaskId, saveTasks, type Task, type TaskStatus} from '../../core/tasks/taskStorage.js';

/**
 * Size policy: prose fields (titles and fix-evidence reasons) are never
 * Zod-capped. A schema `.max()` turns an over-long string into a hard
 * `AI_TypeValidationError` that rejects the *whole* call, so `execute`
 * truncates prose to these bounds instead.
 */
const TITLE_CHARS = 200;
const PROSE_CHARS = 400;

function truncate(value: string, max: number) {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/**
 * writeTasks is also the structured surface for red→green declarations (P4):
 * the model may explain why the failing repro is genuinely unobservable or
 * name a successor validation command. The schema stays one flat object for
 * compatibility with local OpenAI-compatible models.
 */
export const writeTasksTool = tool({
  description: 'Replace the task list for substantial work, and (optionally) record structured fix evidence. Update tasks at meaningful phase changes, blockers, and completion; pass the complete list. redWaiver records why a pre-fix failing repro could not be captured; greenSuccessor names the command that supersedes the captured failing repro when the completing check legitimately differs.',
  inputSchema: z.object({
    tasks: z.array(z.object({
      title: z.string().min(1).describe('Short task description'),
      status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('Task status (defaults to pending)'),
    })).describe('Complete task list. Replaces any existing tasks. Pass an empty array to clear.'),
    redWaiver: z.string().min(1).optional().describe('Reason the pre-fix failing repro is genuinely unobservable in this environment.'),
    greenSuccessor: z.string().min(1).optional().describe('Validation command that supersedes the captured failing repro command (when the completing check legitimately differs).'),
  }),
  execute: async ({tasks: inputTasks, redWaiver, greenSuccessor}) => {
    if (!Array.isArray(inputTasks)) {
      return {ok: false, error: 'Tasks must be an array. Pass an empty array to clear the list.'};
    }
    for (let i = 0; i < inputTasks.length; i++) {
      if (!inputTasks[i]?.title?.trim()) return {ok: false, error: `Task ${i + 1}: title cannot be empty.`};
    }
    // Prose is truncated, never rejected for length: an over-long evidence
    // string must not fail the whole tool call.
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
    const redWaiverBounded = redWaiver?.trim() ? truncate(redWaiver, PROSE_CHARS) : undefined;
    const greenSuccessorBounded = greenSuccessor?.trim() ? truncate(greenSuccessor, PROSE_CHARS) : undefined;
    const summaryParts = [tasks.length === 0
      ? 'Task list cleared.'
      : `Tasks: ${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed.`];
    if (redWaiverBounded) summaryParts.push('redWaiver recorded.');
    if (greenSuccessorBounded) summaryParts.push('greenSuccessor recorded.');
    return {
      ok: true,
      taskCount: tasks.length,
      ...(tasks.length > 0 ? {counts} : {}),
      ...(redWaiverBounded ? {redWaiver: redWaiverBounded} : {}),
      ...(greenSuccessorBounded ? {greenSuccessor: greenSuccessorBounded} : {}),
      summary: summaryParts.join(' '),
    };
  },
});
