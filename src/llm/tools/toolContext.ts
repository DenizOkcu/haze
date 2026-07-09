import {z} from 'zod';
import type {ToolFailureReasonCode} from '../toolResultTypes.js';
import {readScopedContextFilesForPath, type ContextFile} from '../../config/contextFiles.js';
import {workspaceRoot} from '../../utils/path.js';
import {isFailedToolOutput, toolInputField} from '../../core/agent/toolResults.js';
import {HazeToolError} from './failures.js';

/**
 * Turn-scoped tool-call orchestration shared by every built-in tool: in-flight
 * and completed-call deduplication, a mutation epoch that invalidates read
 * caches after writes, edit-recovery gating, and lazy discovery of scoped
 * project instructions (CLAUDE.md / AGENTS.md below the cwd).
 *
 * All state lives on per-tool `context` values, which the agent turn owns and
 * passes to the AI SDK. Nothing here is persisted.
 */

export type ToolExecutionContext = {
  abortSignal?: AbortSignal;
  context?: unknown;
};

export type HazeToolContext = {
  inFlightToolCalls?: Map<string, Promise<unknown>>;
  completedToolCalls?: Map<string, number>;
  mutationEpoch?: number;
  failedMutationPaths?: Set<string>;
  failedMutationReasons?: Map<string, ToolFailureReasonCode | undefined>;
  pathsReadAfterFailedMutation?: Set<string>;
  inFlightMutationPaths?: Set<string>;
  loadedContextFilePaths?: Set<string>;
  loadedContextFileSignatures?: Map<string, string>;
  pendingContextFiles?: ContextFile[];
  scopedContextDiscovery?: Promise<void>;
  onContextFileRead?: (path: string) => void;
};

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function toolCallKey(toolName: string, input: unknown) {
  return `${toolName}:${stableJsonStringify(input)}`;
}

export const hazeToolContextSchema = z.custom<HazeToolContext>(value => typeof value === 'object' && value !== null);

export function hazeContext(context: ToolExecutionContext): HazeToolContext | undefined {
  return typeof context.context === 'object' && context.context != null
    ? context.context as HazeToolContext
    : undefined;
}

export function toolsContextFor<T extends Record<string, unknown>>(tools: T, context: HazeToolContext): Partial<Record<keyof T, HazeToolContext>> {
  const hazeToolNames = new Set(['listFiles', 'readFile', 'grep', 'replaceLines', 'writeFile', 'editFile', 'bash', 'fetch']);
  return Object.fromEntries(Object.keys(tools).filter(name => hazeToolNames.has(name)).map(name => [name, context])) as Partial<Record<keyof T, HazeToolContext>>;
}

/**
 * Lazily load scoped CLAUDE.md/AGENTS.md files that apply to `filePath` and
 * have not been surfaced yet this turn. Mutates the context's loaded-set so
 * each file is only returned once.
 */
export async function discoverScopedContext(filePath: string, context: ToolExecutionContext) {
  const ctx = hazeContext(context);
  const previousDiscovery = ctx?.scopedContextDiscovery;
  let releaseDiscovery: () => void = () => undefined;
  const currentDiscovery = new Promise<void>(resolve => { releaseDiscovery = resolve; });
  if (ctx) ctx.scopedContextDiscovery = previousDiscovery ? previousDiscovery.catch(() => undefined).then(() => currentDiscovery) : currentDiscovery;
  await previousDiscovery?.catch(() => undefined);

  try {
    const loaded = ctx?.loadedContextFilePaths ?? new Set<string>();
    const signatures = ctx?.loadedContextFileSignatures;
    const files = await readScopedContextFilesForPath(filePath, {cwd: workspaceRoot(), alreadyLoadedPaths: loaded, alreadyLoadedSignatures: signatures, onContextFileRead: ctx?.onContextFileRead});
    if (ctx && !ctx.loadedContextFilePaths) ctx.loadedContextFilePaths = loaded;
    for (const file of files) {
      loaded.add(file.path);
      if (file.signature) signatures?.set(file.path, file.signature);
    }
    if (ctx && files.length > 0) ctx.pendingContextFiles = [...(ctx.pendingContextFiles ?? []), ...files];
    return files;
  } finally {
    releaseDiscovery();
  }
}

/** Attach discovered scoped instructions to a tool result, if any. */
export function withScopedContext<T extends Record<string, unknown>>(result: T, files: ContextFile[]): T & {applicableProjectInstructions?: ContextFile[]} {
  return files.length > 0 ? {...result, applicableProjectInstructions: files} : result;
}

/**
 * When scoped project instructions apply to a path being mutated, pause the
 * mutation so the model can review them first. Returns a structured failure
 * the tool yields directly (no file change).
 */
export function scopedContextMutationStop(toolName: string, filePath: string, files: ContextFile[]) {
  if (files.length === 0) return undefined;
  return {
    ok: false,
    toolName,
    path: filePath,
    error: `Scoped project instructions apply to ${filePath}: ${files.map(file => file.path).join(', ')}. Review them before mutating this path.`,
    reasonCode: 'scoped_instructions_discovered' as const,
    recoverable: true,
    suggestedNextStep: `Read the applicableProjectInstructions returned in this result, then retry ${toolName} only if the change follows those scoped instructions.`,
    applicableProjectInstructions: files,
  };
}

function isMutatingTool(toolName: string) {
  return ['editFile', 'replaceLines', 'writeFile'].includes(toolName);
}

function isReadOnlyFileTool(toolName: string) {
  return ['listFiles', 'readFile', 'grep'].includes(toolName);
}

// Read-only tools that participate in completed-call deduplication within a
// turn (no side effects). File tools + bash + fetch; fetch has no path and is
// network-side-effect-free for the agent's purposes.
function isDeduplicableReadOnlyTool(toolName: string) {
  return isReadOnlyFileTool(toolName) || toolName === 'bash' || toolName === 'fetch';
}

/**
 * Wrap a tool's execution with turn-scoped deduplication and edit-recovery:
 *  - skip concurrent mutations of the same path;
 *  - force a re-read before retrying an edit that just failed on a path;
 *  - skip identical completed read-only calls until a mutation occurs;
 *  - skip identical in-flight calls;
 *  - bump a mutation epoch on successful writes so read caches invalidate.
 */
export async function runDedupedTool<T>(toolName: string, input: unknown, context: ToolExecutionContext, execute: () => Promise<T>): Promise<T | {ok: true; duplicateSkipped: true; toolName: string; reason: string}> {
  const ctx = hazeContext(context);
  if (!ctx) return execute();
  ctx.inFlightToolCalls ??= new Map();
  ctx.completedToolCalls ??= new Map();
  ctx.failedMutationPaths ??= new Set();
  ctx.failedMutationReasons ??= new Map();
  ctx.pathsReadAfterFailedMutation ??= new Set();
  ctx.inFlightMutationPaths ??= new Set();
  ctx.mutationEpoch ??= 0;
  const key = toolCallKey(toolName, input);
  const pathForInput = toolInputField(input, 'path');
  if (isMutatingTool(toolName) && pathForInput && ctx.inFlightMutationPaths.has(pathForInput)) {
    return {
      ok: true,
      duplicateSkipped: true,
      toolName,
      reason: `Skipped concurrent mutation for ${pathForInput}. Read the file again, then make one editFile call with all non-overlapping replacements or one replaceLines call based on the latest line numbers.`,
    };
  }
  if (isMutatingTool(toolName) && pathForInput && ctx.failedMutationPaths.has(pathForInput) && !ctx.pathsReadAfterFailedMutation.has(pathForInput)) {
    const reason = ctx.failedMutationReasons.get(pathForInput);
    throw new HazeToolError(`Read ${pathForInput} before attempting another edit after the previous edit failure${reason ? ` (${reason})` : ''}.`, reason ?? 'io_error', {recoveryTool: 'readFile', recoveryInput: {path: pathForInput}});
  }
  const completedAt = ctx.completedToolCalls.get(key);
  const readAfterFailedMutation = toolName === 'readFile' && pathForInput && ctx.failedMutationPaths.has(pathForInput) && !ctx.pathsReadAfterFailedMutation.has(pathForInput);
  if ((isDeduplicableReadOnlyTool(toolName)) && completedAt === ctx.mutationEpoch && !readAfterFailedMutation) {
    return {
      ok: true,
      duplicateSkipped: true,
      toolName,
      reason: toolName === 'bash'
        ? 'Skipped duplicate bash command; no files changed since the previous run.'
        : toolName === 'fetch'
          ? 'Skipped duplicate fetch with identical URL; no files changed since the previous call.'
          : 'Skipped duplicate read-only tool call with identical input; no files changed since the previous call.',
    };
  }
  if (ctx.inFlightToolCalls.has(key)) {
    return {
      ok: true,
      duplicateSkipped: true,
      toolName,
      reason: 'Skipped duplicate in-flight tool call with identical input.',
    };
  }

  if (isMutatingTool(toolName) && pathForInput) ctx.inFlightMutationPaths.add(pathForInput);
  const promise = execute();
  ctx.inFlightToolCalls.set(key, promise);
  try {
    const result = await promise;
    if (isFailedToolOutput(result)) {
      if (isMutatingTool(toolName) && pathForInput) {
        ctx.failedMutationPaths.add(pathForInput);
        const reasonCode = typeof result === 'object' && result != null && 'reasonCode' in result ? result.reasonCode as ToolFailureReasonCode | undefined : undefined;
        ctx.failedMutationReasons.set(pathForInput, reasonCode);
        ctx.pathsReadAfterFailedMutation.delete(pathForInput);
      }
      return result;
    }
    if (toolName === 'readFile' && pathForInput) ctx.pathsReadAfterFailedMutation.add(pathForInput);
    if (isMutatingTool(toolName)) {
      ctx.mutationEpoch += 1;
      if (pathForInput) {
        ctx.failedMutationPaths.delete(pathForInput);
        ctx.failedMutationReasons.delete(pathForInput);
        ctx.pathsReadAfterFailedMutation.delete(pathForInput);
      }
    }
    ctx.completedToolCalls.set(key, ctx.mutationEpoch);
    return result;
  } catch (error) {
    if (isMutatingTool(toolName) && pathForInput) {
      ctx.failedMutationPaths.add(pathForInput);
      ctx.failedMutationReasons.set(pathForInput, error instanceof HazeToolError ? error.reasonCode : undefined);
      ctx.pathsReadAfterFailedMutation.delete(pathForInput);
    }
    throw error;
  } finally {
    ctx.inFlightToolCalls.delete(key);
    if (isMutatingTool(toolName) && pathForInput) ctx.inFlightMutationPaths?.delete(pathForInput);
  }
}
