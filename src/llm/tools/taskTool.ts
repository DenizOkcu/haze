import {tool} from 'ai';
import {z} from 'zod';
import {generateTaskId, saveTasks, type Task, type TaskStatus} from '../../core/tasks/taskStorage.js';

/**
 * writeTasks is also the structured surface for ask/waiver declarations
 * (P2/P4): the model may close an ask (`met` with evidence, `waived` with a
 * reason) or waive the red→green requirement here. The schema stays one flat
 * object (no unions — local OpenAI-compatible models emit empty `{}` calls for
 * union schemas); the agent runtime re-validates every echoed update against
 * real work events, so prose alone can never close an ask or waive evidence.
 */
export const writeTasksTool = tool({
  description: 'Replace the task list for substantial work, and (optionally) update structured goal evidence. Update tasks at meaningful phase changes, blockers, and completion; pass the complete list. askUpdates close asks re-derived from the original request: met requires evidence citing a passing validation command or a changed file; waived requires a waiverReason. redWaiver records why a failing repro could not be captured before a fix; greenSuccessor names the command that supersedes the captured failing repro. goalShape records that the goal is bigger than classified (upward only).',
  inputSchema: z.object({
    tasks: z.array(z.object({
      title: z.string().max(200).describe('Short task description'),
      status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('Task status (defaults to pending)'),
    })).describe('Complete task list. Replaces any existing tasks. Pass an empty array to clear.'),
    askUpdates: z.array(z.object({
      id: z.string().max(64).describe('Ask id (e.g. ask-1) or exact ask text.'),
      status: z.enum(['met', 'waived']).describe('met = satisfied with evidence; waived = out of scope with reason.'),
      evidence: z.string().max(400).optional().describe('Required for met: cite the passing validation command or a changed file path.'),
      waiverReason: z.string().max(400).optional().describe('Required for waived: why the ask is out of scope.'),
    })).max(10).optional().describe('Structured updates for asks derived from the original request.'),
    redWaiver: z.string().min(1).max(400).optional().describe('Reason the pre-fix failing repro is genuinely unobservable in this environment.'),
    greenSuccessor: z.string().min(1).max(400).optional().describe('Validation command that supersedes the captured failing repro command (when the completing check legitimately differs).'),
    goalShape: z.enum(['trivial', 'bounded', 'multi-lane', 'debug']).optional().describe('Proposed goal shape when the work turned out bigger or smaller than classified. Escalation upward only; downward proposals are ignored.'),
  }),
  execute: async ({tasks: inputTasks, askUpdates, redWaiver, greenSuccessor, goalShape}) => {
    if (!Array.isArray(inputTasks)) {
      return {ok: false, error: 'Tasks must be an array. Pass an empty array to clear the list.'};
    }
    for (let i = 0; i < inputTasks.length; i++) {
      const title = inputTasks[i]?.title?.trim();
      if (!title) return {ok: false, error: `Task ${i + 1}: title cannot be empty.`};
      if (title.length > 200) return {ok: false, error: `Task ${i + 1}: title is too long (max 200 characters).`};
    }
    // Shape-validate structured declarations here; semantic validation (does
    // the evidence reference a real passing validation or changed file?)
    // happens in the agent runtime's work-state observer, which is the single
    // choke point for completion evidence.
    const echoedAskUpdates: Array<{id: string; status: 'met' | 'waived'; evidence?: string; waiverReason?: string}> = [];
    for (const update of askUpdates ?? []) {
      const id = update?.id?.trim();
      if (!id) return {ok: false, error: 'askUpdates: id cannot be empty.'};
      if (update.status === 'met' && !update.evidence?.trim()) return {ok: false, error: `askUpdates: marking ${id} met requires evidence citing a passing validation command or changed file.`};
      if (update.status === 'waived' && !update.waiverReason?.trim()) return {ok: false, error: `askUpdates: waiving ${id} requires a waiverReason.`};
      echoedAskUpdates.push({
        id,
        status: update.status,
        ...(update.evidence?.trim() ? {evidence: update.evidence.trim()} : {}),
        ...(update.waiverReason?.trim() ? {waiverReason: update.waiverReason.trim()} : {}),
      });
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
    const counts = {
      pending: tasks.filter(t => t.status === 'pending').length,
      in_progress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
    };
    const summaryParts = [`Tasks: ${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed.`];
    if (tasks.length === 0) return {ok: true, taskCount: 0, summary: 'Task list cleared.'};
    if (echoedAskUpdates.length > 0) summaryParts.push(`${echoedAskUpdates.length} ask update${echoedAskUpdates.length === 1 ? '' : 's'} recorded.`);
    if (redWaiver?.trim()) summaryParts.push('redWaiver recorded.');
    if (greenSuccessor?.trim()) summaryParts.push('greenSuccessor recorded.');
    if (goalShape) summaryParts.push(`goalShape ${goalShape} recorded.`);
    return {
      ok: true,
      taskCount: tasks.length,
      counts,
      ...(echoedAskUpdates.length > 0 ? {askUpdates: echoedAskUpdates} : {}),
      ...(redWaiver?.trim() ? {redWaiver: redWaiver.trim()} : {}),
      ...(greenSuccessor?.trim() ? {greenSuccessor: greenSuccessor.trim()} : {}),
      ...(goalShape ? {goalShape} : {}),
      summary: summaryParts.join(' '),
    };
  },
});
