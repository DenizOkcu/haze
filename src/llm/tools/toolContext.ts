import {z} from 'zod';
import {changedPathsFromTool, isMutatingCapability} from '../../core/agent/toolCapabilities.js';
import {readScopedContextFilesForPath, type ContextFile} from '../../config/contextFiles.js';
import {workspacePathKey, workspaceRoot} from '../../utils/path.js';
import {isFailedToolOutput, requiresReadFileRecovery, toolInputField} from '../../core/agent/toolResults.js';
import {HazeToolError} from './failures.js';
import {hazeContext, isHazeToolContext, type HazeToolContext, type PostMutationDiagnostics, type ToolExecutionContext} from './toolContextState.js';

// The turn-scoped context type/schema/guards live in `toolContextState.ts`
// (split so type-only importers stop pulling the dedup runtime); re-exported
// here for the many existing importers.
export type {HazeToolContext, PostMutationDiagnostics, ToolExecutionContext} from './toolContextState.js';
export {hazeContext, isHazeToolContext} from './toolContextState.js';

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

export const hazeToolContextSchema = z.custom<HazeToolContext>(isHazeToolContext, 'Invalid haze tool context');

export function toolsContextFor<T extends Record<string, unknown>>(tools: T, context: HazeToolContext): Partial<Record<keyof T, HazeToolContext>> {
  const hazeToolNames = new Set(['listFiles', 'readFile', 'grep', 'replaceInFiles', 'replaceLines', 'writeFile', 'editFile', 'shell', 'process', 'fetch', 'lspRenameSymbol', 'lspSafeDeleteSymbol']);
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

// Shared effects policy keeps diagnostics and completion evidence in agreement.

function isMutatingTool(toolName: string) {
  // Shell execution is conservatively workspace-mutation-capable. Classification remains
  // informational and is not a sandbox boundary.
  return isMutatingCapability(toolName) || toolName === 'shell';
}

/** Paths actually changed by a successful dedicated file-mutation result. */
function changedPathsForDiagnostics(toolName: string, input: unknown, result: unknown): string[] {
  return changedPathsFromTool(toolName, input, result);
}

async function attachPostMutationDiagnostics<T>(toolName: string, input: unknown, result: T, diagnostics: PostMutationDiagnostics | undefined): Promise<T> {
  if (!diagnostics) return result;
  const paths = changedPathsForDiagnostics(toolName, input, result);
  if (paths.length === 0 || !isRecordValue(result)) return result;
  try {
    const lspDiagnostics = await diagnostics(paths);
    return lspDiagnostics === undefined ? result : {...result, lspDiagnostics} as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {...result, lspDiagnostics: {ok: false, error: `Automatic LSP diagnostics failed: ${message.split('\n')[0]}`}} as T;
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
        const reasonCode = typeof result === 'object' && result != null && 'reasonCode' in result ? result.reasonCode as import('../toolResultTypes.js').ToolFailureReasonCode | undefined : undefined;
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
    return await attachPostMutationDiagnostics(toolName, input, result, ctx.postMutationDiagnostics);
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
