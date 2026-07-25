import {generateText, isStepCount, tool, type ToolSet} from 'ai';
import {z} from 'zod';
import {buildSubagentPrompt, type PromptSession} from '../../llm/systemPrompt.js';
import {hazeTools} from '../../llm/hazeTools.js';
import {toolsContextFor, type HazeToolContext} from '../../llm/tools/toolContext.js';
import {toolOnlyStepCount} from '../agent/turnPolicy.js';
import {withSyntheticControl} from '../agent/requestAssembly.js';
import type {ContextFile} from '../../config/contextFiles.js';

const ALL_TOOLS = ['listFiles', 'readFile', 'grep', 'bash', 'readToolOutput', 'editFile', 'replaceLines', 'writeFile', 'fetch'] as const;
const STEP_LIMIT = 25;
const MAX_SUMMARY = 4000;
const TOOL_ONLY_LIMIT = 12;
/**
 * Narration-resistant tool-volume guard. Once a subagent has made this many tool
 * calls it is forced to synthesize, regardless of whether it narrated text on
 * each step (narration defeats the toolOnlyStepCount guard, since that only
 * counts trailing steps with tool calls AND no text).
 */
const TOOL_CALL_BUDGET = 20;
/**
 * Steps reserved at the end of the budget for a forced synthesis turn, so a
 * subagent never ends its run on read-narration merely because it ran out of
 * steps — its terminal step is always a synthesis.
 */
const SYNTHESIS_RESERVE = 2;
const SYNTHESIS_DIRECTIVE = 'You have reached your tool/step budget for this subtask. Stop calling tools and do not describe your process. Your next message must be the deliverable itself: a complete, self-contained summary of what you found or changed, with evidence (file:line where relevant) and the precise remaining work if anything is incomplete. Output the result now — this is your final answer.';

export interface SubagentResult {
  status: 'ok' | 'error' | 'timeout' | 'cancelled';
  summary: string;
  toolCalls: Array<{name: string; summary: string; durationMs: number}>;
  toolCallCount: number;
  tokens: {in: number; out: number};
  durationMs: number;
  error?: string;
}

function toolSummary(output: unknown): string {
  if (typeof output !== 'object' || output == null) return 'completed';
  const o = output as Record<string, unknown>;
  if (typeof o.totalMatches === 'number') return o.totalMatches === 0 ? 'no matches' : `${o.matchCountIsLowerBound === true ? 'at least ' : ''}${o.totalMatches} matches`;
  if (typeof o.code === 'number') return `exit ${o.code}`;
  if (o.ok === true) return 'completed';
  if (o.ok === false && typeof o.error === 'string') return `failed: ${o.error.slice(0, 120)}`;
  return 'completed';
}

type SubagentStep = {toolCalls: unknown[]; text: string};

/**
 * Decide whether the next step must be a forced synthesis turn (no further tool
 * calls). Three independent triggers make the guard robust to chatty models
 * that narrate while they work:
 *  - a long run of consecutive tool-only steps (TOOL_ONLY_LIMIT), or
 *  - total tool-call volume over budget (TOOL_CALL_BUDGET) — narration-resistant, or
 *  - within SYNTHESIS_RESERVE steps of the step limit (always end on synthesis).
 */
function shouldForceSynthesis(steps: SubagentStep[], maxSteps: number): boolean {
  const calls = steps.flatMap(step => step.toolCalls);
  const consecutiveToolOnly = toolOnlyStepCount(steps);
  return consecutiveToolOnly >= TOOL_ONLY_LIMIT
    || calls.length >= TOOL_CALL_BUDGET
    || steps.length >= maxSteps - SYNTHESIS_RESERVE;
}

export const internals = {toolSummary, toolOnlyStepCount, shouldForceSynthesis, SYNTHESIS_DIRECTIVE};

export async function runSubagent(
  task: string,
  options: {
    model: Parameters<typeof generateText>[0]['model'];
    contextFiles: ContextFile[];
    allowedTools?: readonly string[];
    maxSteps?: number;
    abortSignal?: AbortSignal;
    session?: PromptSession;
  },
): Promise<SubagentResult> {
  const start = performance.now();
  const toolNames = (options.allowedTools ?? ALL_TOOLS).filter(t => (ALL_TOOLS as readonly string[]).includes(t));
  const maxSteps = Math.min(options.maxSteps ?? STEP_LIMIT, STEP_LIMIT);

  const scopedTools: ToolSet = {};
  for (const name of toolNames) {
    const key = name as keyof typeof hazeTools;
    if (key in hazeTools) scopedTools[name] = hazeTools[key];
  }

  const toolCallLog: Array<{name: string; summary: string; durationMs: number}> = [];
  const toolExecutionContext: HazeToolContext = {inFlightToolCalls: new Map()};
  let totalToolCalls = 0;

  try {
    // Subagents are internal workers: their intermediate turns never reach the
    // UI — only their final summary does. So they use generateText (non-
    // streaming) instead of streamText. Streaming buys nothing here, and
    // generateText returns a fully-resolved result whose `.text` is, by the AI
    // SDK contract, the text of the FINAL step (the synthesis) — never the
    // concatenation of every step's narration.
    const result = await generateText({
      model: options.model,
      maxOutputTokens: 4096,
      instructions: buildSubagentPrompt(options.contextFiles, options.session),
      messages: [{role: 'user' as const, content: task}],
      tools: scopedTools,
      stopWhen: isStepCount(maxSteps),
      abortSignal: options.abortSignal,
      runtimeContext: toolExecutionContext,
      toolsContext: toolsContextFor(scopedTools, toolExecutionContext) as never,
      prepareStep({steps, messages}) {
        if (!shouldForceSynthesis(steps, maxSteps)) return undefined;
        // Preserve the full conversation (task + tool calls/results) and append
        // the synthesis directive as a control message. Returning a bare
        // messages array here would REPLACE the accumulated history — the
        // Vercel AI SDK treats prepareStepResult.messages ?? stepInputMessages,
        // so a returned array is used verbatim, not appended. Replacing the
        // history left the model with only the directive and caused it to
        // truthfully report "no task / no tools executed" on every forced
        // synthesis turn, discarding all gathered findings. The main agent
        // (streaming.ts) avoids this by always preserving `messages`.
        return {
          toolChoice: 'none' as const,
          messages: withSyntheticControl(messages, SYNTHESIS_DIRECTIVE),
        };
      },
      onToolExecutionEnd(event) {
        if (!event.toolCall) return;
        totalToolCalls += 1;
        toolCallLog.push({
          name: event.toolCall.toolName,
          summary: event.toolOutput.type === 'tool-result' ? toolSummary(event.toolOutput.output) : `failed: ${String(event.toolOutput.error).slice(0, 120)}`,
          durationMs: event.toolExecutionMs,
        });
      },
    });

    // result.text is the final step's text (the deliverable) — not a
    // concatenation of per-step narration — so it is safe to use directly.
    const summary = (result.text.trim() || 'Subagent completed without text output.').slice(0, MAX_SUMMARY);
    const durationMs = performance.now() - start;
    // isStepCount(maxSteps) stops when steps.length === maxSteps, so hitting
    // the limit is exactly steps.length >= maxSteps.
    const status = options.abortSignal?.aborted ? 'cancelled' as const
      : result.steps.length >= maxSteps ? 'timeout' as const
      : 'ok' as const;

    return {status, summary, toolCalls: toolCallLog, toolCallCount: totalToolCalls, tokens: {in: result.usage.inputTokens ?? 0, out: result.usage.outputTokens ?? 0}, durationMs};
  } catch (error) {
    return {
      status: options.abortSignal?.aborted ? 'cancelled' as const : 'error' as const,
      summary: error instanceof Error ? error.message : String(error),
      toolCalls: toolCallLog,
      toolCallCount: totalToolCalls,
      tokens: {in: 0, out: 0},
      durationMs: performance.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createSubagentTool(options: {
  model: Parameters<typeof generateText>[0]['model'];
  contextFiles: ContextFile[];
  session?: PromptSession;
}) {
  return tool({
    description: 'Spawn subagents to run independent tasks in parallel. ONLY use when a request clearly decomposes into 2+ independent subtasks that can run concurrently — spawn all of them in one step. Do NOT use for single tasks, sequential work, or anything that benefits from conversation context; do those directly instead. Subagents have no conversation history and return a summary.',
    inputSchema: z.object({
      task: z.string().min(1).describe('Clear, specific task for the subagent to complete.'),
      tools: z.array(z.enum(['listFiles', 'readFile', 'grep', 'bash', 'readToolOutput', 'editFile', 'replaceLines', 'writeFile', 'fetch'])).optional().describe('Tools the subagent can use. Defaults to all tools.'),
      maxSteps: z.number().int().positive().max(50).optional().describe('Maximum tool-call rounds. Default 25.'),
    }),
    execute: async ({task, tools, maxSteps}, context) => runSubagent(task, {
      model: options.model,
      contextFiles: options.contextFiles,
      allowedTools: tools,
      maxSteps,
      abortSignal: context.abortSignal,
      session: options.session,
    }),
  });
}
