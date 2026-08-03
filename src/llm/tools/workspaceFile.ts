import fs from 'node:fs/promises';
import path from 'node:path';
import {assertRealPathInsideWorkspace, assertWritablePathInsideWorkspace, resolveWorkspacePath, workspaceRoot} from '../../utils/path.js';
import {isPathBlessed} from '../../core/attachments/readBlessings.js';
import {assertNotIgnored} from './fileToolShared.js';
import {discoverScopedContext, hazeContext, scopedContextMutationStop, type ToolExecutionContext} from './toolContext.js';

export async function prepareWorkspaceExisting(filePath: string) {
  const absolutePath = resolveWorkspacePath(filePath);
  await assertRealPathInsideWorkspace(absolutePath, filePath);
  return absolutePath;
}

/**
 * Resolve a read path and confine it to the workspace — unless the user
 * explicitly mentioned it (or a parent directory) in the prompt this turn.
 * Blessed paths skip both `.gitignore` enforcement and the workspace boundary
 * so the model can read host files the user pointed at. Mutating tools use
 * `prepareWorkspaceMutation` / `prepareWorkspaceWritePath` instead, which
 * never consult the bless set.
 */
export async function prepareWorkspaceRead(filePath: string, allowIgnored: boolean | undefined, context?: ToolExecutionContext) {
  const blessed = context ? hazeContext(context)?.blessedPaths : undefined;
  if (blessed && blessed.length > 0) {
    const absolutePath = path.resolve(workspaceRoot(), filePath);
    const realRequested = await requestedRealPath(absolutePath);
    if (isPathBlessed(realRequested, blessed)) return absolutePath;
  }
  const absolutePath = resolveWorkspacePath(filePath);
  await assertNotIgnored(absolutePath, filePath, allowIgnored);
  await assertRealPathInsideWorkspace(absolutePath, filePath);
  return absolutePath;
}

/** Best-effort realpath for bless comparison; falls back to the verbatim path if the file is gone. */
async function requestedRealPath(absolutePath: string): Promise<string> {
  try {
    return await fs.realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

export async function prepareWorkspaceMutation(toolName: string, filePath: string, allowIgnored: boolean | undefined, context: ToolExecutionContext) {
  const absolutePath = resolveWorkspacePath(filePath);
  await assertNotIgnored(absolutePath, filePath, allowIgnored);
  await assertRealPathInsideWorkspace(absolutePath, filePath);
  const scopedContext = await discoverScopedContext(filePath, context);
  const scopedStop = scopedContextMutationStop(toolName, filePath, scopedContext);
  return {absolutePath, scopedContext, scopedStop};
}

export async function prepareWorkspaceWritePath(toolName: string, filePath: string, allowIgnored: boolean | undefined, context: ToolExecutionContext) {
  const absolutePath = resolveWorkspacePath(filePath);
  await assertNotIgnored(absolutePath, filePath, allowIgnored);
  const scopedContext = await discoverScopedContext(filePath, context);
  const scopedStop = scopedContextMutationStop(toolName, filePath, scopedContext);
  return {absolutePath, scopedContext, scopedStop, assertExistingInsideWorkspace: async () => await assertRealPathInsideWorkspace(absolutePath, filePath), assertWritableInsideWorkspace: async () => await assertWritablePathInsideWorkspace(absolutePath, filePath)};
}
