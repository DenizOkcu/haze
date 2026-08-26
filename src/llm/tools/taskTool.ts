import {tool} from 'ai';
import {z} from 'zod';
import {generateTaskId, saveTasks, type Task, type TaskStatus} from '../../core/tasks/taskStorage.js';

/**
 * Size policy: prose fields (titles, evidence, waiver reasons, ask texts) are
 * never Zod-capped. A schema `.max()` turns an over-long evidence string into
 * a hard `AI_TypeValidationError` that rejects the *whole* call — the model
 * then retries the identical oversized input and burns steps (observed in the
 * 1.1.0-vs-HEAD harbor differential). The schema validates shape only;
 * `execute` truncates prose to these bounds. Truncation is safe because the
 * runtime re-validates every echoed declaration against real work events.
 */
const TITLE_CHARS = 200;
const ID_CHARS = 200;
const PROSE_CHARS = 400;
const ASK_ITEM_CHARS = 200;

function truncate(value: string, max: number) {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/**
 * writeTasks is also the structured surface for ask/waiver declarations
 * (P2/P4): the model may close an ask (`met` with evidence, `waived` with a
 * reason) or waive the red→green requirement here. The schema stays one flat
 * object (no unions — local OpenAI-compatible models emit empty `{}` calls for
 * union schemas); the agent runtime re-validates every echoed update against
 * real work events, so prose alone can never close an ask or waive evidence.
 */
export const writeTasksTool = tool({
  description: 'Replace the task list for substantial work, and (optionally) update structured goal evidence. Update tasks at meaningful phase changes, blockers, and completion; pass the complete list. askUpdates close asks re-derived from the original request: met requires evidence citing a passing validation command or a changed file; waived requires a waiverReason. askAmendments refine the derived ask list before any edit or command runs (add missing asks, reword imprecise ones; never drops — waive instead); ignored after the first edit or command. redWaiver records why a failing repro could not be captured before a fix; greenSuccessor names the command that supersedes the captured failing repro. goalShape records that the goal is bigger than classified (upward only).',
  inputSchema: z.object({
    tasks: z.array(z.object({
      title: z.string().min(1).describe('Short task description'),
      status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('Task status (defaults to pending)'),
    })).describe('Complete task list. Replaces any existing tasks. Pass an empty array to clear.'),
    askUpdates: z.array(z.object({
      id: z.string().min(1).describe('Ask id (e.g. ask-1) or exact ask text.'),
      status: z.enum(['met', 'waived']).describe('met = satisfied with evidence; waived = out of scope with reason.'),
      evidence: z.string().min(1).optional().describe('Required for met: cite the passing validation command or a changed file path.'),
      waiverReason: z.string().min(1).optional().describe('Required for waived: why the ask is out of scope.'),
    })).max(10).optional().describe('Structured updates for asks derived from the original request.'),
    askAmendments: z.object({
      add: z.array(z.any()).max(7).optional().describe('Missing concrete deliverables from the request. Each item is a short checkable ask — a plain string, or an object like {"text": "..."} (both accepted).'),
      reword: z.array(z.object({
        id: z.string().min(1).describe('Existing ask id or exact current text.'),
        text: z.string().min(1).describe('The corrected ask text.'),
        reason: z.string().optional().describe('Why the derived wording was imprecise.'),
      })).max(7).optional().describe('Imprecise derived asks, reworded. Status and evidence carry over.'),
    }).optional().describe('One-time refinement of the derived ask list; only honored before the first edit or command.'),
    redWaiver: z.string().min(1).optional().describe('Reason the pre-fix failing repro is genuinely unobservable in this environment.'),
    greenSuccessor: z.string().min(1).optional().describe('Validation command that supersedes the captured failing repro command (when the completing check legitimately differs).'),
    goalShape: z.enum(['trivial', 'bounded', 'multi-lane', 'debug']).optional().describe('Proposed goal shape when the work turned out bigger or smaller than classified. Escalation upward only; downward proposals are ignored.'),
  }),
  execute: async ({tasks: inputTasks, askUpdates, askAmendments, redWaiver, greenSuccessor, goalShape}) => {
    if (!Array.isArray(inputTasks)) {
      return {ok: false, error: 'Tasks must be an array. Pass an empty array to clear the list.'};
    }
    for (let i = 0; i < inputTasks.length; i++) {
      if (!inputTasks[i]?.title?.trim()) return {ok: false, error: `Task ${i + 1}: title cannot be empty.`};
    }
    // Shape-validate structured declarations here; semantic validation (does
    // the evidence reference a real passing validation or changed file?)
    // happens in the agent runtime's work-state observer, which is the single
    // choke point for completion evidence. Prose is truncated, never rejected
    // for length — an over-long evidence string must not fail the whole call.
    const echoedAskUpdates: Array<{id: string; status: 'met' | 'waived'; evidence?: string; waiverReason?: string}> = [];
    for (const update of askUpdates ?? []) {
      const id = truncate(update?.id ?? '', ID_CHARS);
      if (!id) return {ok: false, error: 'askUpdates: id cannot be empty.'};
      if (update.status === 'met' && !update.evidence?.trim()) return {ok: false, error: `askUpdates: marking ${id} met requires evidence citing a passing validation command or changed file.`};
      if (update.status === 'waived' && !update.waiverReason?.trim()) return {ok: false, error: `askUpdates: waiving ${id} requires a waiverReason.`};
      echoedAskUpdates.push({
        id,
        status: update.status,
        ...(update.evidence?.trim() ? {evidence: truncate(update.evidence, PROSE_CHARS)} : {}),
        ...(update.waiverReason?.trim() ? {waiverReason: truncate(update.waiverReason, PROSE_CHARS)} : {}),
      });
    }
    const now = new Date().toISOString();
    // Shape-validate amendments only; semantic validation (the pre-work lock,
    // bounds, dedupe) happens in the agent runtime's work-state observer,
    // the single choke point for completion evidence. `add` accepts plain
    // strings and {text}-style objects: models emit both shapes, and a Zod
    // mismatch hard-fails the whole call (harbor finding 1). No unions — the
    // flat-schema rule for local OpenAI-compatible models — so items are
    // normalized here instead.
    const normalizeAmendmentItem = (item: unknown): string => {
      if (typeof item === 'string') return truncate(item, ASK_ITEM_CHARS);
      if (typeof item === 'object' && item !== null) {
        const record = item as Record<string, unknown>;
        for (const field of ['text', 'ask', 'title', 'value']) {
          const value = record[field];
          if (typeof value === 'string' && value.trim()) return truncate(value, ASK_ITEM_CHARS);
        }
      }
      return '';
    };
    const amendmentsAdd = (askAmendments?.add ?? []).map(normalizeAmendmentItem).filter(Boolean);
    const amendmentsReword = askAmendments?.reword
      ?.map(item => ({id: truncate(item?.id ?? '', ID_CHARS), text: truncate(item?.text ?? '', ASK_ITEM_CHARS), ...(item?.reason?.trim() ? {reason: truncate(item.reason, PROSE_CHARS)} : {})}))
      .filter(item => item.id && item.text) ?? [];
    const echoedAmendments = amendmentsAdd.length > 0 || amendmentsReword.length > 0
      ? {...(amendmentsAdd.length > 0 ? {add: amendmentsAdd} : {}), ...(amendmentsReword.length > 0 ? {reword: amendmentsReword} : {})}
      : undefined;
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
    const summaryParts = [`Tasks: ${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed.`];
    if (tasks.length === 0) return {ok: true, taskCount: 0, ...(echoedAmendments ? {askAmendments: echoedAmendments} : {}), summary: 'Task list cleared.'};
    if (echoedAskUpdates.length > 0) summaryParts.push(`${echoedAskUpdates.length} ask update${echoedAskUpdates.length === 1 ? '' : 's'} recorded.`);
    if (echoedAmendments) summaryParts.push('askAmendments recorded.');
    const redWaiverBounded = redWaiver?.trim() ? truncate(redWaiver, PROSE_CHARS) : undefined;
    const greenSuccessorBounded = greenSuccessor?.trim() ? truncate(greenSuccessor, PROSE_CHARS) : undefined;
    if (redWaiverBounded) summaryParts.push('redWaiver recorded.');
    if (greenSuccessorBounded) summaryParts.push('greenSuccessor recorded.');
    if (goalShape) summaryParts.push(`goalShape ${goalShape} recorded.`);
    return {
      ok: true,
      taskCount: tasks.length,
      counts,
      ...(echoedAskUpdates.length > 0 ? {askUpdates: echoedAskUpdates} : {}),
      ...(echoedAmendments ? {askAmendments: echoedAmendments} : {}),
      ...(redWaiverBounded ? {redWaiver: redWaiverBounded} : {}),
      ...(greenSuccessorBounded ? {greenSuccessor: greenSuccessorBounded} : {}),
      ...(goalShape ? {goalShape} : {}),
      summary: summaryParts.join(' '),
    };
  },
});
