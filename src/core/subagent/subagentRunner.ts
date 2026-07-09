import {streamText, isStepCount, tool, type ToolSet} from 'ai';
import {z} from 'zod';
import {buildSubagentPrompt, type PromptSession} from '../../llm/systemPrompt.js';
import {hazeTools} from '../../llm/hazeTools.js';
import {toolsContextFor, type HazeToolContext} from '../../llm/tools/toolContext.js';
import {toolOnlyStepCount} from '../agent/turnPolicy.js';
import type {ContextFile} from '../../config/contextFiles.js';

const ALL_TOOLS = ['listFiles', 'readFile', 'grep', 'bash', 'readToolOutput', 'editFile', 'replaceLines', 'writeFile', 'fetch'] as const;
const STEP_LIMIT = 25;
const MAX_SUMMARY = 4000;
const TOOL_ONLY_LIMIT = 12;

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
  if (typeof o.totalMatches === 'number') return o.totalMatches === 0 ? 'no matches' : `${o.totalMatches} matches`;
  if (typeof o.code === 'number') return `exit ${o.code}`;
  if (o.ok === true) return 'completed';
  if (o.ok === false && typeof o.error === 'string') return `failed: ${o.error.slice(0, 120)}`;
  return 'completed';
}

export const internals = {toolSummary, toolOnlyStepCount};

export async function runSubagent(
  task: string,
  options: {
    model: Parameters<typeof streamText>[0]['model'];
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
  let tokensIn = 0;
  let tokensOut = 0;
  let lastStep = 0;
  let totalToolCalls = 0;

  try {
    const result = streamText({
      model: options.model,
      maxOutputTokens: 4096,
      instructions: buildSubagentPrompt(options.contextFiles, options.session),
      messages: [{role: 'user' as const, content: task}],
      tools: scopedTools,
      stopWhen: isStepCount(maxSteps),
      abortSignal: options.abortSignal,
      runtimeContext: toolExecutionContext,
      toolsContext: toolsContextFor(scopedTools, toolExecutionContext) as never,
      prepareStep({steps}) {
        const calls = steps.flatMap(step => step.toolCalls);
        const consecutiveToolOnly = toolOnlyStepCount(steps);
        if (consecutiveToolOnly >= TOOL_ONLY_LIMIT || calls.length >= maxSteps * 2) {
          return {
            toolChoice: 'none' as const,
            messages: [
              {role: 'user' as const, content: 'Tool budget reached for this subtask. Summarize what you found or changed, validation evidence, and the exact remaining action if incomplete. Do not claim tools are unavailable.'},
            ],
          };
        }
        return undefined;
      },
      onStepEnd({stepNumber}) {
        lastStep = stepNumber;
      },
      onEnd(event) {
        if (event.usage) {
          tokensIn = event.usage.inputTokens ?? 0;
          tokensOut = event.usage.outputTokens ?? 0;
        }
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

    let text = '';
    for await (const delta of result.textStream) {
      text += delta;
    }

    await result.response;
    const summary = (text.trim() || 'Subagent completed without text output.').slice(0, MAX_SUMMARY);
    const durationMs = performance.now() - start;
    const status = options.abortSignal?.aborted ? 'cancelled' as const
      : lastStep >= maxSteps ? 'timeout' as const
      : 'ok' as const;

    return {status, summary, toolCalls: toolCallLog, toolCallCount: totalToolCalls, tokens: {in: tokensIn, out: tokensOut}, durationMs};
  } catch (error) {
    return {
      status: options.abortSignal?.aborted ? 'cancelled' as const : 'error' as const,
      summary: error instanceof Error ? error.message : String(error),
      toolCalls: toolCallLog,
      toolCallCount: totalToolCalls,
      tokens: {in: tokensIn, out: tokensOut},
      durationMs: performance.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createSubagentTool(options: {
  model: Parameters<typeof streamText>[0]['model'];
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
