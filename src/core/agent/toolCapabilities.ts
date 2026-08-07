/**
 * Static capability metadata for built-in tools.
 *
 * Capabilities describe what a tool *can do* so turn-policy code can reason
 * about a turn without hard-coding tool names in every decision site. They are
 * metadata for policy/observability, never an execution gate (mirroring the
 * bash-classifier contract): the actual effect of a call is still determined at
 * runtime (e.g. a `bash` call is only validation when its command is a
 * classifier-confirmed validation command).
 *
 * Kept provider/UI-agnostic (no `ai`/Ink imports) so it is unit-testable in
 * `tests/core/**` and reusable by the subagent flow.
 */

export type ToolCapability = 'discovery' | 'read' | 'mutate' | 'validate' | 'process' | 'coordinate';

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
  // Process execution. A bash call becomes validation only when its command is
  // a classifier-confirmed validation command (see work state); that runtime
  // fact is tracked separately as a validation event, not as a static trait.
  bash: ['process'],
  process: ['process'],
  // Coordination / durable state.
  writeTasks: ['coordinate'],
  subagent: ['coordinate'],
  // LSP diagnostic reads.
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

/** Tools that can act as a validation step (runtime-classifier dependent). */
export function isValidationCapable(name: string): boolean {
  return hasCapability(name, 'validate') || name === 'bash';
}

/** Read/discovery-only built-in tools (no mutation side effects). */
export function isReadOrDiscoveryCapability(name: string): boolean {
  const caps = toolCapability(name);
  return caps.length > 0 && caps.every(capability => capability === 'read' || capability === 'discovery');
}
