import type {ToolSet} from 'ai';
import {readContextFiles, readScopedContextFilesForPath, type ContextFile} from '../config/contextFiles.js';
import {estimateTextTokens, estimateToolSchemas, estimateValueTokens} from '../core/agent/contextBudget.js';
import type {SubagentExecutionProfile} from '../core/subagent/executionProfiles.js';
import {MODE_TOOL_NAMES} from '../core/subagent/executionProfiles.js';
import type {SubagentTaskCapsule} from '../core/subagent/contracts.js';
import {buildSubagentPrompt, type PromptSession} from './systemPrompt.js';
import {hazeTools} from './hazeTools.js';
import {resolveWorkspacePath, workspaceRelativePath} from '../utils/path.js';

export interface WorkerContextBundle {
  instructions: ContextFile[];
  loadedPaths: Set<string>;
  loadedSignatures: Map<string, string>;
  systemPrompt: string;
  tools: ToolSet;
  estimatedTokens: number;
  taskTokens: number;
  validatedScope: string[];
  policyBlock?: string;
}

export function workerTaskMessage(task: SubagentTaskCapsule) {
  return JSON.stringify({
    id: task.id,
    objective: task.objective,
    deliverable: task.deliverable,
    mode: task.mode,
    ...(task.scope.length ? {scope: task.scope} : {}),
    ...(task.acceptanceCriteria.length ? {acceptanceCriteria: task.acceptanceCriteria} : {}),
  });
}

export async function assembleWorkerContext(task: SubagentTaskCapsule, profile: SubagentExecutionProfile, session?: PromptSession): Promise<WorkerContextBundle> {
  const cwd = session?.cwd ?? process.cwd();
  const validatedScope: string[] = [];
  try {
    for (const hint of task.scope) validatedScope.push(workspaceRelativePath(resolveWorkspacePath(hint)));
  } catch (error) {
    return emptyBlocked(error instanceof Error ? error.message : String(error));
  }

  const instructions = await readContextFiles(cwd);
  const loadedPaths = new Set(instructions.map(file => file.path));
  const loadedSignatures = new Map(instructions.flatMap(file => file.signature ? [[file.path, file.signature] as const] : []));
  for (const hint of validatedScope) {
    const scoped = await readScopedContextFilesForPath(hint, {cwd, alreadyLoadedPaths: loadedPaths, alreadyLoadedSignatures: loadedSignatures});
    for (const file of scoped) {
      if (!loadedPaths.has(file.path)) instructions.push(file);
      loadedPaths.add(file.path);
      if (file.signature) loadedSignatures.set(file.path, file.signature);
    }
  }

  const tools: ToolSet = {};
  for (const name of MODE_TOOL_NAMES[task.mode]) {
    const key = name as keyof typeof hazeTools;
    tools[name] = hazeTools[key];
  }
  const systemPrompt = buildSubagentPrompt(instructions, session, task.mode, profile);
  const taskTokens = estimateValueTokens(workerTaskMessage(task));
  const estimatedTokens = estimateTextTokens(systemPrompt) + taskTokens + estimateToolSchemas(tools).reduce((sum, tool) => sum + tool.tokens, 0);
  return {
    instructions, loadedPaths, loadedSignatures, systemPrompt, tools, estimatedTokens, taskTokens, validatedScope,
    ...(estimatedTokens > profile.maxInputTokens ? {policyBlock: `Worker input estimate ${estimatedTokens} exceeds profile ${profile.name} limit ${profile.maxInputTokens}. Narrow scope/context or select an explicit larger profile.`} : {}),
  };

  function emptyBlocked(reason: string): WorkerContextBundle {
    return {instructions: [], loadedPaths: new Set(), loadedSignatures: new Map(), systemPrompt: '', tools: {}, estimatedTokens: 0, taskTokens: estimateValueTokens(workerTaskMessage(task)), validatedScope: [], policyBlock: reason};
  }
}

/**
 * Legacy compatibility bundle for callers (e.g. `/fleet`) that pass explicit
 * context files and an optional tool allowlist instead of letting the worker
 * resolve its own context. Moved from `llm/subagentRunner.ts` so the
 * runner stays free of `llm` imports.
 */
export async function compatibilityBundle(task: SubagentTaskCapsule, profile: SubagentExecutionProfile, contextFiles: ContextFile[], allowedTools: readonly string[] | undefined, session: PromptSession | undefined): Promise<WorkerContextBundle> {
  const instructions = contextFiles;
  const systemPrompt = buildSubagentPrompt(instructions, session, task.mode, profile);
  const tools: ToolSet = {};
  for (const name of allowedTools ?? MODE_TOOL_NAMES[task.mode]) if (name in hazeTools) tools[name] = hazeTools[name as keyof typeof hazeTools];
  const taskTokens = estimateValueTokens(workerTaskMessage(task));
  const estimatedTokens = estimateTextTokens(systemPrompt) + taskTokens + estimateToolSchemas(tools).reduce((sum, value) => sum + value.tokens, 0);
  return {instructions, systemPrompt, tools, taskTokens, estimatedTokens, validatedScope: [], loadedPaths: new Set(instructions.map(file => file.path)), loadedSignatures: new Map(instructions.flatMap(file => file.signature ? [[file.path, file.signature] as const] : [])), ...(estimatedTokens > profile.maxInputTokens ? {policyBlock: `Worker input estimate ${estimatedTokens} exceeds profile ${profile.name} limit ${profile.maxInputTokens}.`} : {})};
}
