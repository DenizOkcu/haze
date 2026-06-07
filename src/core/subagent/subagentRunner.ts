import {streamText, stepCountIs, tool, type ToolSet} from 'ai';
import {z} from 'zod';
import {buildSystemPrompt} from '../../llm/systemPrompt.js';
import {hazeTools} from '../../llm/hazeTools.js';
import type {ContextFile} from '../../config/contextFiles.js';

const SUBAGENT_SYSTEM_PROMPT = `You are a focused subagent. Complete exactly the assigned task and return a concise summary.

Rules:
- Do exactly what is asked, nothing more.
- Return a tight, factual summary of your findings or actions.
- Do not modify files unless the task explicitly requires it.
- Be precise. Include file paths, line numbers, and specific details.
- If you cannot complete the task, explain why concisely.
- After completing the task, summarize your findings immediately. Do not add commentary.`;

const ALL_TOOLS = ['listFiles', 'readFile', 'grep', 'bash', 'editFile', 'replaceLines', 'writeFile'] as const;
const STEP_LIMIT = 25;
const MAX_SUMMARY = 4000;

export interface SubagentResult {
  status: 'ok' | 'error' | 'timeout' | 'cancelled';
  summary: string;
  toolCalls: Array<{name: string; summary: string; durationMs: number}>;
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

export async function runSubagent(
  task: string,
  options: {
    model: Parameters<typeof streamText>[0]['model'];
    contextFiles: ContextFile[];
    allowedTools?: readonly string[];
    maxSteps?: number;
    abortSignal?: AbortSignal;
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
  let tokensIn = 0;
  let tokensOut = 0;
  let lastStep = 0;

  try {
    const result = streamText({
      model: options.model,
      temperature: 0,
      maxOutputTokens: 4096,
      system: `${SUBAGENT_SYSTEM_PROMPT}\n\n${buildSystemPrompt(options.contextFiles)}`,
      messages: [{role: 'user' as const, content: task}],
      tools: scopedTools,
      stopWhen: stepCountIs(maxSteps),
      abortSignal: options.abortSignal,
      experimental_context: {inFlightToolCalls: new Map()},
      onStepFinish({stepNumber}) {
        lastStep = stepNumber;
      },
      onFinish(event) {
        if (event.usage) {
          tokensIn = event.usage.inputTokens ?? 0;
          tokensOut = event.usage.outputTokens ?? 0;
        }
      },
      experimental_onToolCallFinish(event) {
        if (!event.toolCall) return;
        toolCallLog.push({
          name: event.toolCall.toolName,
          summary: toolSummary(event.output),
          durationMs: event.durationMs,
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

    return {status, summary, toolCalls: toolCallLog, tokens: {in: tokensIn, out: tokensOut}, durationMs};
  } catch (error) {
    return {
      status: options.abortSignal?.aborted ? 'cancelled' as const : 'error' as const,
      summary: '',
      toolCalls: toolCallLog,
      tokens: {in: tokensIn, out: tokensOut},
      durationMs: performance.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createSubagentTool(options: {
  model: Parameters<typeof streamText>[0]['model'];
  contextFiles: ContextFile[];
}) {
  return tool({
    description: 'Spawn a focused subagent with a fresh context to handle a specific task independently. Use for parallelizable work: when a request decomposes into independent subtasks, spawn multiple subagents in one step instead of doing them sequentially. The subagent has access to all file and shell tools by default. Returns a structured result with a summary the parent agent can use directly.',
    inputSchema: z.object({
      task: z.string().min(1).describe('Clear, specific task for the subagent to complete.'),
      tools: z.array(z.enum(['listFiles', 'readFile', 'grep', 'bash', 'editFile', 'replaceLines', 'writeFile'])).optional().describe('Tools the subagent can use. Defaults to all tools. Restrict to a subset to limit the subagent\'s capabilities.'),
      maxSteps: z.number().int().positive().max(50).optional().describe('Maximum tool-call rounds. Default 25.'),
    }),
    execute: async ({task, tools, maxSteps}, context) => runSubagent(task, {
      model: options.model,
      contextFiles: options.contextFiles,
      allowedTools: tools,
      maxSteps,
      abortSignal: context.abortSignal,
    }),
  });
}
