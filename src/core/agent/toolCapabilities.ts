/**
 * Static capability metadata for built-in tools.
 *
 * Capabilities describe what a tool *can do* so turn-policy code can reason
 * about a turn without hard-coding tool names in every decision site. They are
 * metadata for policy/observability, never an execution gate (mirroring the
 * shell-classifier contract): the actual effect of a call is still determined at
 * runtime (e.g. a `shell` call is only validation when its command is a
 * classifier-confirmed validation command).
 *
 * Kept provider/UI-agnostic (no `ai`/Ink imports) so it is unit-testable in
 * `tests/core/**` and reusable by the subagent flow.
 */

export type ToolCapability = 'discovery' | 'read' | 'mutate' | 'process' | 'coordinate';

const CAPABILITY_MAP: Readonly<Record<string, readonly ToolCapability[]>> = {
  // File discovery / inspection.
  listFiles: ['discovery'],
  grep: ['discovery'],
  readFile: ['read'],
  readToolOutput: ['read'],
  fetch: ['read'],
  // File mutation.
  writeFile: ['mutate'],
  editFile: ['mutate'],
  replaceLines: ['mutate'],
  replaceInFiles: ['mutate'],
  lspRenameSymbol: ['mutate'],
  lspSafeDeleteSymbol: ['mutate'],
  // Process execution. A shell call becomes validation only when its command is
  // a classifier-confirmed validation command (see work state); that runtime
  // fact is tracked separately as a validation event, not as a static trait.
  shell: ['process'],
  process: ['process'],
  // Coordination / durable state.
  writeTasks: ['coordinate'],
  subagent: ['coordinate'],
} as const;

/**
 * Capability set for a built-in tool name. Unknown/third-party tool names
 * (MCP) return an empty set: their effects are not statically knowable, so
 * policy code treats them conservatively.
 */
export function toolCapability(name: string): readonly ToolCapability[] {
  return CAPABILITY_MAP[name] ?? [];
}

export function hasCapability(name: string, capability: ToolCapability): boolean {
  return toolCapability(name).includes(capability);
}

/** Tools whose successful call introduces a workspace mutation. */
export function isMutatingCapability(name: string): boolean {
  return hasCapability(name, 'mutate');
}

/** Confirmed effects, including completed writes from failed multi-file/worker calls. */
export function changedPathsFromTool(toolName: string, input: unknown, output: unknown, success = true): string[] {
  if (output !== undefined && output !== null && typeof output !== 'object') return [];
  const result = (output ?? {}) as Record<string, unknown>;
  if (result.duplicateSkipped === true || result.dryRun === true || result.noChange === true) return [];
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string' && path.length > 0).slice(0, 20_000) : [];
  if (toolName === 'subagent') {
    const capsule = typeof result.capsule === 'object' && result.capsule !== null ? result.capsule as Record<string, unknown> : result;
    return [...new Set(strings(capsule.changedPaths))];
  }
  if (!isMutatingCapability(toolName)) return [];
  if (Array.isArray(result.changedPaths)) return [...new Set(strings(result.changedPaths))];
  if (result.ok === false || !success) return [];
  if (Array.isArray(result.files)) return [...new Set(result.files.flatMap(file => typeof file === 'object' && file !== null && 'path' in file && typeof file.path === 'string' && !('noChange' in file && file.noChange === true) ? [file.path] : []))];
  // Single-file tools confirm their effect from success plus the input path;
  // a null output is tolerated for callers that report only a success flag.
  if (!['writeFile', 'editFile', 'replaceLines'].includes(toolName)) return [];
  const path = typeof result.path === 'string' ? result.path : typeof input === 'object' && input !== null && 'path' in input ? input.path : undefined;
  return typeof path === 'string' && path.length > 0 ? [path] : [];
}

/** Tools that can act as a validation step (runtime-classifier dependent). */
export function isValidationCapable(name: string): boolean {
  return name === 'shell';
}

