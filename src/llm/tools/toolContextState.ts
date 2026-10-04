import type {ContextFile} from '../../config/contextFiles.js';
import type {ToolFailureReasonCode} from '../toolResultTypes.js';
import type {BlessedPath} from '../../core/attachments/readBlessings.js';
import type {WorkspaceMutationOwner, WorkspaceMutationPolicy} from '../../core/subagent/workspaceMutationPolicy.js';

/**
 * The turn-scoped tool execution state schema and guards, split from
 * `toolContext.ts` so the widely-imported context type stops dragging the
 * dedup/mutation runtime with it. `toolContext.ts` re-exports everything below
 * for existing importers; new code imports from here.
 */

export type ToolExecutionContext = {
  abortSignal?: AbortSignal;
  context?: unknown;
  experimental_context?: unknown;
};

export type PostMutationDiagnostics = (paths: readonly string[]) => Promise<unknown | undefined>;

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
  /** Runs LSP diagnostics after successful file mutations and embeds them in that tool result. */
  postMutationDiagnostics?: PostMutationDiagnostics;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMutationPolicy(value: unknown): boolean {
  return isRecord(value) && typeof value.acquire === 'function' && typeof value.createOwner === 'function';
}

export function isHazeToolContext(value: unknown): value is HazeToolContext {
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
    && validOptional('blessedPaths', field => Array.isArray(field) && field.every(item => isRecord(item) && typeof item.realPath === 'string' && typeof item.isDirectory === 'boolean'))
    && validOptional('postMutationDiagnostics', field => typeof field === 'function');
}

export function hazeContext(context: ToolExecutionContext): HazeToolContext | undefined {
  const value = typeof context.context === 'object' && context.context != null
    ? context.context
    : context.experimental_context;
  return isHazeToolContext(value) ? value : undefined;
}
