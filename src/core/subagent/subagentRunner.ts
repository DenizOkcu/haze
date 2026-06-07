import {streamText, stepCountIs, tool, type ToolSet} from 'ai';
import {z} from 'zod';
import {buildSystemPrompt} from '../../llm/systemPrompt.js';
import {hazeTools} from '../../llm/hazeTools.js';
import type {ContextFile} from '../../config/contextFiles.js';

const SUBAGENT_SYSTEM_PROMPT = `You are a focused subagent for a professional developer workflow. Complete the assigned task autonomously using the available tools, then return a clear summary.

Rules:
- Use whatever tools you need within the assigned scope. You have full access to file tools and bash.
- If the task requires creating or modifying files, do it directly with file tools or an efficient non-destructive shell command; do not ask for permission for ordinary edits.
- If a tool result is blocked pending confirmation, do not retry or bypass it. Report the exact command/decision needed to the parent agent.
- Destructive commands that delete user work or irreversibly change repository state require explicit confirmation; ordinary professional workflows should proceed without extra ceremony.
- If a file edit tool fails, read the exact file again and retry once with current content or line numbers.
- After completing the task, summarize what you did, what files you created or changed, validation run, and important findings.
- If you cannot complete the task, explain exactly what blocked you and what you tried.
- Your summary is all the parent agent will see. Be specific: include file paths, function names, command results, and concrete next steps.`;

const ALL_TOOLS = ['listFiles', 'readFile', 'grep', 'bash', 'editFile', 'replaceLines', 'writeFile'] as const;
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

function toolOnlyStepCount(steps: Array<{toolCalls: unknown[]; text: string}>) {
  let count = 0;
  for (const step of [...steps].reverse()) {
    if (step.toolCalls.length === 0 || step.text.trim().length > 0) break;
    count += 1;
  }
  return count;
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
  let totalToolCalls = 0;

  try {
    const result = streamText({
      model: options.model,
      maxOutputTokens: 4096,
      system: `${SUBAGENT_SYSTEM_PROMPT}\n\n${buildSystemPrompt(options.contextFiles)}`,
      messages: [{role: 'user' as const, content: task}],
      tools: scopedTools,
      stopWhen: stepCountIs(maxSteps),
      abortSignal: options.abortSignal,
      experimental_context: {inFlightToolCalls: new Map()},
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
        totalToolCalls += 1;
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
}) {
  return tool({
    description: 'Spawn subagents to run independent tasks in parallel. ONLY use when a request clearly decomposes into 2+ independent subtasks that can run concurrently — spawn all of them in one step. Do NOT use for single tasks, sequential work, or anything that benefits from conversation context; do those directly instead. Subagents have no conversation history and return a summary.',
    inputSchema: z.object({
      task: z.string().min(1).describe('Clear, specific task for the subagent to complete.'),
      tools: z.array(z.enum(['listFiles', 'readFile', 'grep', 'bash', 'editFile', 'replaceLines', 'writeFile'])).optional().describe('Tools the subagent can use. Defaults to all tools. Restrict to a subset only when the subagent should be read-only.'),
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
