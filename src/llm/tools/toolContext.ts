import {z} from 'zod';
import type {ToolFailureReasonCode} from '../toolResultTypes.js';
import {readScopedContextFilesForPath, type ContextFile} from '../../config/contextFiles.js';
import {workspacePathKey, workspaceRoot} from '../../utils/path.js';
import {isFailedToolOutput, requiresReadFileRecovery, toolInputField} from '../../core/agent/toolResults.js';
import {HazeToolError} from './failures.js';
import type {BlessedPath} from '../../core/attachments/readBlessings.js';
import type {WorkspaceMutationOwner, WorkspaceMutationPolicy} from '../../core/subagent/workspaceMutationPolicy.js';

/**
 * Turn-scoped tool-call orchestration shared by every built-in tool: in-flight
 * and completed-call deduplication, a mutation epoch that invalidates read
 * caches after writes, edit-recovery gating, and lazy discovery of scoped
 * project instructions (CLAUDE.md / AGENTS.md below the cwd).
 *
 * All state lives on per-tool `context` values, which the agent turn owns and
 * passes to the AI SDK. Tests and older callers may still provide the legacy
 * `experimental_context` shape. Nothing here is persisted.
 */

export type ToolExecutionContext = {
  abortSignal?: AbortSignal;
  context?: unknown;
  experimental_context?: unknown;
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
  mutationPolicy?: WorkspaceMutationPolicy;
  mutationOwner?: WorkspaceMutationOwner;
  /** True in disposable worker contexts; background processes are main-turn-only. */
  isSubagent?: boolean;
  /** Real paths the user mentioned this turn; read tools may escape workspace for them. */
  blessedPaths?: readonly BlessedPath[];
};

function stableJsonStringify(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (Array.isArray(value)) return `[${value.map(item => stableJsonStringify(item, seen)).join(',')}]`;
  if (value && typeof value === 'object') {
    if (seen.has(value as object)) throw new Error('Circular tool input');
    seen.add(value as object);
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue, seen)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function toolCallKey(toolName: string, input: unknown) {
  return `${toolName}:${stableJsonStringify(input)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMutationPolicy(value: unknown): boolean {
  return isRecord(value) && typeof value.acquire === 'function' && typeof value.createOwner === 'function';
}

function isHazeToolContext(value: unknown): value is HazeToolContext {
  if (!isRecord(value)) return false;
  const validOptional = (key: string, predicate: (field: unknown) => boolean) =>
    value[key] === undefined || predicate(value[key]);
  return validOptional('inFlightToolCalls', field => field instanceof Map)
    && validOptional('completedToolCalls', field => field instanceof Map)
    && validOptional('mutationEpoch', field => typeof field === 'number' && Number.isSafeInteger(field) && field >= 0)
    && validOptional('failedMutationPaths', field => field instanceof Set)
    && validOptional('failedMutationReasons', field => field instanceof Map)
    && validOptional('pathsReadAfterFailedMutation', field => field instanceof Set)
    && validOptional('inFlightMutationPaths', field => field instanceof Set)
    && validOptional('loadedContextFilePaths', field => field instanceof Set)
    && validOptional('loadedContextFileSignatures', field => field instanceof Map)
    && validOptional('pendingContextFiles', field => Array.isArray(field))
    && validOptional('scopedContextDiscovery', field => field instanceof Promise)
    && validOptional('onContextFileRead', field => typeof field === 'function')
    && validOptional('mutationPolicy', isMutationPolicy)
    && validOptional('mutationOwner', field => typeof field === 'symbol')
    && validOptional('isSubagent', field => typeof field === 'boolean')
    && validOptional('blessedPaths', field => Array.isArray(field) && field.every(item => isRecord(item) && typeof item.realPath === 'string' && typeof item.isDirectory === 'boolean'));
}

export const hazeToolContextSchema = z.custom<HazeToolContext>(isHazeToolContext, 'Invalid haze tool context');

export function hazeContext(context: ToolExecutionContext): HazeToolContext | undefined {
  const value = typeof context.context === 'object' && context.context != null
    ? context.context
    : context.experimental_context;
  return isHazeToolContext(value) ? value : undefined;
}

export function toolsContextFor<T extends Record<string, unknown>>(tools: T, context: HazeToolContext): Partial<Record<keyof T, HazeToolContext>> {
  const hazeToolNames = new Set(['listFiles', 'readFile', 'grep', 'replaceLines', 'writeFile', 'editFile', 'shell', 'process', 'fetch']);
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
  // Shell execution is conservatively workspace-mutation-capable. Classification remains
  // informational and is not a sandbox boundary.
  return ['editFile', 'replaceLines', 'writeFile', 'shell'].includes(toolName);
}

function isReadOnlyFileTool(toolName: string) {
  return ['listFiles', 'readFile', 'grep'].includes(toolName);
}

// Read-only tools that participate in completed-call deduplication within a
// turn (no side effects). Shell is deliberately excluded: commands can observe
// external state changes between identical calls (CR-007).
function isDeduplicableReadOnlyTool(toolName: string) {
  return isReadOnlyFileTool(toolName) || toolName === 'fetch';
}

/**
 * Wrap a tool's execution with turn-scoped deduplication and edit-recovery:
 *  - skip concurrent mutations of the same path;
 *  - force a re-read when a stale-content failure explicitly requests one;
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
  const mutationPathKey = pathForInput ? workspacePathKey(pathForInput) : undefined;
  if (isMutatingTool(toolName) && mutationPathKey && ctx.inFlightMutationPaths.has(mutationPathKey)) {
    return {
      ok: true,
      duplicateSkipped: true,
      toolName,
      reason: `Skipped concurrent mutation for ${pathForInput}. Read the file again, then make one editFile call with all non-overlapping replacements or one replaceLines call based on the latest line numbers.`,
    };
  }
  if (isMutatingTool(toolName) && mutationPathKey && ctx.failedMutationPaths.has(mutationPathKey) && !ctx.pathsReadAfterFailedMutation.has(mutationPathKey)) {
    const reason = ctx.failedMutationReasons.get(mutationPathKey);
    throw new HazeToolError(`Read ${pathForInput} before attempting another edit after the previous edit failure${reason ? ` (${reason})` : ''}.`, reason ?? 'io_error', {recoveryTool: 'readFile', recoveryInput: {path: pathForInput}});
  }
  const completedAt = ctx.completedToolCalls.get(key);
  const readAfterFailedMutation = toolName === 'readFile' && mutationPathKey && ctx.failedMutationPaths.has(mutationPathKey) && !ctx.pathsReadAfterFailedMutation.has(mutationPathKey);
  if ((isDeduplicableReadOnlyTool(toolName)) && completedAt === ctx.mutationEpoch && !readAfterFailedMutation) {
    return {
      ok: true,
      duplicateSkipped: true,
      toolName,
      reason: toolName === 'fetch'
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

  if (isMutatingTool(toolName) && mutationPathKey) ctx.inFlightMutationPaths.add(mutationPathKey);
  let releaseMutation: (() => void) | undefined;
  const promise = (async () => {
    if (isMutatingTool(toolName) && ctx.mutationPolicy) {
      // A worker supplies its whole-run owner so nested tool calls are
      // reentrant. Main-turn calls intentionally receive a fresh owner per
      // mutation, serializing concurrent edit/shell calls.
      const owner = ctx.mutationOwner ?? ctx.mutationPolicy.createOwner();
      releaseMutation = await ctx.mutationPolicy.acquire(owner, context.abortSignal);
    }
    return await execute();
  })();
  ctx.inFlightToolCalls.set(key, promise);
  try {
    const result = await promise;
    if (isFailedToolOutput(result)) {
      if (isMutatingTool(toolName) && mutationPathKey && requiresReadFileRecovery(result)) {
        ctx.failedMutationPaths.add(mutationPathKey);
        const reasonCode = typeof result === 'object' && result != null && 'reasonCode' in result ? result.reasonCode as ToolFailureReasonCode | undefined : undefined;
        ctx.failedMutationReasons.set(mutationPathKey, reasonCode);
        ctx.pathsReadAfterFailedMutation.delete(mutationPathKey);
      }
      return result;
    }
    if (toolName === 'readFile' && mutationPathKey) ctx.pathsReadAfterFailedMutation.add(mutationPathKey);
    if (isMutatingTool(toolName)) {
      ctx.mutationEpoch += 1;
      if (mutationPathKey) {
        ctx.failedMutationPaths.delete(mutationPathKey);
        ctx.failedMutationReasons.delete(mutationPathKey);
        ctx.pathsReadAfterFailedMutation.delete(mutationPathKey);
      }
    }
    ctx.completedToolCalls.set(key, ctx.mutationEpoch);
    return result;
  } catch (error) {
    if (isMutatingTool(toolName) && mutationPathKey && requiresReadFileRecovery(error)) {
      ctx.failedMutationPaths.add(mutationPathKey);
      ctx.failedMutationReasons.set(mutationPathKey, error instanceof HazeToolError ? error.reasonCode : undefined);
      ctx.pathsReadAfterFailedMutation.delete(mutationPathKey);
    }
    throw error;
  } finally {
    releaseMutation?.();
    ctx.inFlightToolCalls.delete(key);
    if (isMutatingTool(toolName) && mutationPathKey) ctx.inFlightMutationPaths?.delete(mutationPathKey);
  }
}
