import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertRealPathInsideWorkspace, assertWritablePathInsideWorkspace, resolveWorkspacePath, workspaceRoot} from '../../utils/path.js';
import {isPathBlessed} from '../../core/attachments/readBlessings.js';
import {isProtectedSecretPath} from '../../core/safety/secretPaths.js';
import {assertNotIgnored} from './fileToolShared.js';
import {HazeToolError} from './failures.js';
import {discoverScopedContext, hazeContext, scopedContextMutationStop, type ToolExecutionContext} from './toolContext.js';

/**
 * Secret files are hands-off for every tool: this check wins over the read
 * bless set, `allowIgnored`, and gitignore logic. Both the lexical path and
 * the real path are checked so symlinks cannot rename a secret into reach
 * (`link -> .env`) or a secret name onto other content (`.env -> target`).
 */
async function assertNotSecretPath(absolutePath: string, realPath: string, inputPath: string, operation: 'read' | 'mutation') {
  const homeDir = os.homedir();
  if (!isProtectedSecretPath(absolutePath, homeDir) && !isProtectedSecretPath(realPath, homeDir)) return;
  throw new HazeToolError(
    `Refusing to ${operation} protected secret file: ${inputPath}. Secret files (SSH keys, shell histories, .env files, credentials) are never accessible to agent tools.`,
    'secret_file_protected',
    {recoverable: false, suggestedNextStep: 'Protected secret file: do not retry with other tools, paths, or shell. Ask the user to provide the needed value in the conversation instead.'},
  );
}

/**
 * Resolve a read path and confine it to the workspace — unless the user
 * explicitly mentioned it (or a parent directory) in the prompt this turn.
 * Blessed paths skip both `.gitignore` enforcement and the workspace boundary
 * so the model can read host files the user pointed at. Secret-file
 * protection is checked before the bless set and is never bypassed.
 * Mutating tools use `prepareWorkspaceMutation` / `prepareWorkspaceWritePath`
 * instead, which never consult the bless set.
 */
export async function prepareWorkspaceRead(filePath: string, allowIgnored: boolean | undefined, context?: ToolExecutionContext) {
  const absolutePath = path.resolve(workspaceRoot(), filePath);
  const realRequested = await requestedRealPath(absolutePath);
  await assertNotSecretPath(absolutePath, realRequested, filePath, 'read');
  const blessed = context ? hazeContext(context)?.blessedPaths : undefined;
  if (blessed && blessed.length > 0 && isPathBlessed(realRequested, blessed)) return absolutePath;
  const confinedPath = resolveWorkspacePath(filePath);
  await assertNotIgnored(confinedPath, filePath, allowIgnored, {operation: 'read'});
  await assertRealPathInsideWorkspace(confinedPath, filePath);
  return confinedPath;
}

/** Best-effort realpath for bless comparison; falls back to the verbatim path if the file is gone. */
async function requestedRealPath(absolutePath: string): Promise<string> {
  try {
    return await fs.realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

/**
 * The `/add-dir` session root containing `absolutePath`, if any. Unlike the
 * turn-scoped read bless set, session dirs also admit mutations — the user
 * added them explicitly, the same trust level as `sandbox.rwRoots`. Matching
 * is by real path, so symlinks inside a session dir that resolve elsewhere
 * fall back to ordinary workspace confinement.
 */
async function matchSessionDir(absolutePath: string, context?: ToolExecutionContext): Promise<string | undefined> {
  const dirs = context ? hazeContext(context)?.sessionDirs : undefined;
  if (!dirs || dirs.length === 0) return undefined;
  const real = await requestedRealPath(absolutePath);
  for (const dir of dirs) {
    if (dir.isDirectory && (real === dir.realPath || real.startsWith(`${dir.realPath}/`))) return dir.realPath;
  }
  return undefined;
}

export async function prepareWorkspaceMutation(toolName: string, filePath: string, allowIgnored: boolean | undefined, context: ToolExecutionContext) {
  const sessionDir = await matchSessionDir(path.resolve(workspaceRoot(), filePath), context);
  // Outside every session dir, mutations keep strict lexical + real-path
  // workspace confinement. Inside a session dir the user explicitly added,
  // the path resolves against the workspace root and skips the workspace
  // boundary check (gitignore status for outside-workspace paths is
  // `not-ignored` by definition — the workspace's rules do not govern them).
  const absolutePath = sessionDir ? path.resolve(workspaceRoot(), filePath) : resolveWorkspacePath(filePath);
  await assertNotSecretPath(absolutePath, await requestedRealPath(absolutePath), filePath, 'mutation');
  await assertNotIgnored(absolutePath, filePath, allowIgnored);
  if (!sessionDir) await assertRealPathInsideWorkspace(absolutePath, filePath);
  const scopedContext = await discoverScopedContext(filePath, context);
  const scopedStop = scopedContextMutationStop(toolName, filePath, scopedContext);
  return {absolutePath, scopedContext, scopedStop};
}

export async function prepareWorkspaceWritePath(toolName: string, filePath: string, allowIgnored: boolean | undefined, context: ToolExecutionContext) {
  const sessionDir = await matchSessionDir(path.resolve(workspaceRoot(), filePath), context);
  const absolutePath = sessionDir ? path.resolve(workspaceRoot(), filePath) : resolveWorkspacePath(filePath);
  await assertNotSecretPath(absolutePath, await requestedRealPath(absolutePath), filePath, 'mutation');
  await assertNotIgnored(absolutePath, filePath, allowIgnored);
  const scopedContext = await discoverScopedContext(filePath, context);
  const scopedStop = scopedContextMutationStop(toolName, filePath, scopedContext);
  if (sessionDir) {
    return {absolutePath, scopedContext, scopedStop, assertExistingInsideWorkspace: async () => undefined, assertWritableInsideWorkspace: async () => undefined};
  }
  return {absolutePath, scopedContext, scopedStop, assertExistingInsideWorkspace: async () => await assertRealPathInsideWorkspace(absolutePath, filePath), assertWritableInsideWorkspace: async () => await assertWritablePathInsideWorkspace(absolutePath, filePath)};
}
