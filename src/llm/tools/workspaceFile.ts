import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertRealPathInsideWorkspace, assertWritablePathInsideWorkspace, resolveWorkspacePath, workspaceRoot} from '../../utils/path.js';
import {isPathBlessed} from '../../core/attachments/readBlessings.js';
import {isProtectedSecretPath} from '../../core/safety/secretPaths.js';
import {assertNotIgnored} from './fileToolShared.js';
import {resolveGitDirs} from './gitIgnore.js';
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

const GIT_DIR_NAME = '.git';
/** Bare-repo directory names (`backup.git/`, `repo.git/`) hold hook-bearing git internals too. */
const BARE_GIT_DIR_NAME = /\.git$/;
/** Basenames inside a git directory that stay refused for reads too; hook execution makes all of `hooks/**` sensitive. */
const PROTECTED_GIT_READ_BASENAMES = new Set(['config', 'credentials']);

function isInsideDirectory(candidate: string, directory: string): boolean {
  if (candidate === directory) return true;
  const relative = path.relative(directory, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Resolve the workspace repository's git directories, worktree-aware: walks up
 * from the workspace root to the nearest `.git` marker and follows
 * `gitdir:`/`commondir` pointers (mirroring `resolveExcludeFile`), so linked
 * worktrees and separate-git-dir layouts resolve to the directories that
 * actually hold the repository internals.
 */
async function workspaceGitDirs(): Promise<string[]> {
  let current = path.resolve(workspaceRoot());
  while (true) {
    const marker = path.join(current, GIT_DIR_NAME);
    try {
      await fs.lstat(marker);
      const dirs = await resolveGitDirs(current, marker);
      if (!dirs) return [];
      // Normalize to real paths before containment comparisons: `gitdir:`
      // pointer content can name its target through symlinked prefixes
      // (e.g. macOS /var vs /private/var), and lexical comparison across
      // mixed forms would silently miss the containment.
      const normalized: string[] = [];
      for (const dir of dirs) {
        normalized.push(await fs.realpath(dir).catch(() => dir));
      }
      return normalized;
    } catch {
      // No marker at this level — keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) return [];
    current = parent;
  }
}

/**
 * The git-internals root governing a candidate path, if any: any `.git` path
 * segment (the workspace repo's, a nested repo's, or a symlink target's), or
 * a git directory resolved through `gitdir:` pointers whose location does not
 * carry a `.git` segment (linked worktrees, separate-git-dir layouts). With
 * `includeBareRepos`, directory segments named like bare repos
 * (`backup.git/`) count as roots too — planted bare repos get their hooks
 * executed on local push. Only non-final segments: a file merely *named*
 * `*.git` (e.g. a bundle) is not a repository.
 */
function gitInternalsRoot(absolutePath: string, gitDirs: readonly string[], includeBareRepos = false): string | undefined {
  const segments = absolutePath.split(path.sep);
  const last = segments.length - 1;
  const gitIndex = segments.findIndex((segment, index) => segment === GIT_DIR_NAME || (includeBareRepos && index < last && BARE_GIT_DIR_NAME.test(segment)));
  if (gitIndex >= 0) return segments.slice(0, gitIndex + 1).join(path.sep);
  return gitDirs.find(dir => isInsideDirectory(absolutePath, dir));
}

/**
 * Realpath of the nearest ancestor of `absolutePath` that exists (the target
 * itself when it exists). New-file mutations cannot realpath their target, so
 * git-internals containment is checked against the resolved ancestor a write
 * would descend from — a symlinked parent aliasing `.git` resolves there.
 */
async function nearestExistingRealPath(absolutePath: string): Promise<string | undefined> {
  let current = absolutePath;
  while (true) {
    try {
      return await fs.realpath(current);
    } catch {
      // Missing level — climb toward the workspace root.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Git internals are protected like secret files: hooks and config are a code
 * persistence vector invisible to the agent's own search tools (grep skips
 * `.git`), and `.git/config` can embed credentials. Mutations into git
 * internals always fail; reads are refused for the credential-bearing and
 * hook entries while other object reads (e.g. `.git/HEAD`) stay allowed.
 * Checked against both lexical and real paths so symlinks cannot rename git
 * internals into reach, and before the bless set so it is never bypassed.
 */
async function assertNotGitInternals(absolutePath: string, realPath: string, inputPath: string, operation: 'read' | 'mutation') {
  const gitDirs = await workspaceGitDirs();
  if (operation === 'mutation') {
    const candidates = [absolutePath, realPath];
    const nearestExisting = await nearestExistingRealPath(absolutePath);
    if (nearestExisting) candidates.push(nearestExisting);
    if (candidates.some(candidate => gitInternalsRoot(candidate, gitDirs, true))) {
      throw new HazeToolError(
        `Refusing to mutate git internals: ${inputPath}. The git directory (including linked-worktree git dirs and *.git bare repos) holds repository state, hooks, and credentials; it is never writable through agent tools.`,
        'git_internals_protected',
        {recoverable: false, suggestedNextStep: 'Git internals are protected: do not retry with other tools, paths, or shell. Ask the user to make this change themselves (e.g. git config) if it is genuinely intended.'},
      );
    }
    return;
  }
  // Reads: only the credential-bearing and hook entries are refused; other
  // `.git` object reads (e.g. `.git/HEAD`) stay allowed. Submodule gitdirs
  // live under `modules/**`, where config/credentials carry remote URLs at
  // any depth.
  for (const candidate of [absolutePath, realPath]) {
    const root = gitInternalsRoot(candidate, gitDirs);
    if (!root) continue;
    const entry = path.relative(root, candidate);
    const [head] = entry.split(path.sep);
    if (head === 'hooks'
      || (head != null && !entry.includes(path.sep) && PROTECTED_GIT_READ_BASENAMES.has(head))
      || (head === 'modules' && PROTECTED_GIT_READ_BASENAMES.has(path.basename(entry)))) {
      throw new HazeToolError(
        `Refusing to read protected git internals: ${inputPath}. Git config, credentials, and hooks can carry embedded credentials or executable content; ask the user instead.`,
        'git_internals_protected',
        {recoverable: false, suggestedNextStep: 'Protected git internals: do not retry with other tools, paths, or shell. Ask the user to provide the needed value in the conversation instead.'},
      );
    }
  }
}

/**
 * A regular file with multiple hard links can be an innocent name laundered
 * onto protected content (`ln ~/.ssh/id_ed25519 ./notes.txt` realpaths into
 * the workspace and passes every name check). Refuse, recoverably: legitimate
 * multi-link files exist, so the model may ask the user rather than fail
 * terminally. Skipped for paths that do not exist (nothing to stat).
 */
async function assertNotMultiLinkFile(realPath: string, inputPath: string, operation: 'read' | 'mutation') {
  const stat = await fs.stat(realPath).catch(() => undefined);
  // Missing (or inaccessible) target: nothing to inspect here.
  if (!stat || !stat.isFile() || stat.nlink <= 1) return;
  throw new HazeToolError(
    `Refusing to ${operation} ${inputPath}: the file has multiple hard links, which can disguise protected content under an innocent name.`,
    'multi_link_file_protected',
    {recoverable: true, suggestedNextStep: 'Multi-link file: Ask the user to confirm this exact file is safe to access before retrying.'},
  );
}

const SYMLINK_HOP_LIMIT = 16;

/**
 * Resolve where a write through a symlink would land, by hand. `fs.realpath`
 * fails when the link's target is missing, so the guards' fallback describes
 * the link itself — but `fs.writeFile` follows the link and CREATES the
 * missing target (`.git/hooks/pre-commit`, or a file outside the workspace).
 * Follows the final component's readlink chain (bounded) and stops at the
 * first existing or missing non-link component. Returns undefined when the
 * final component is not a symlink.
 */
async function symlinkWriteTarget(absolutePath: string): Promise<string | undefined> {
  try {
    if (!(await fs.lstat(absolutePath)).isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  let current = absolutePath;
  for (let hops = 0; hops < SYMLINK_HOP_LIMIT; hops++) {
    let link: string;
    try {
      link = await fs.readlink(current);
    } catch {
      return undefined;
    }
    current = path.resolve(path.dirname(current), link);
    try {
      if (!(await fs.lstat(current)).isSymbolicLink()) return current;
    } catch {
      return current; // Missing landing spot — exactly where the write would create the file.
    }
  }
  return current; // Chain at the hop limit; a true cycle would ELOOP at open anyway.
}

/**
 * Symlinked write targets must pass every protection at the landing spot,
 * not at the link name: re-run secret/git/multi-link/ignore checks against
 * the resolved target, and refuse when its nearest existing ancestor lies
 * outside the workspace (the target itself may not exist yet to realpath).
 */
async function assertSymlinkWriteTargetSafe(absolutePath: string, inputPath: string, allowIgnored: boolean | undefined) {
  const target = await symlinkWriteTarget(absolutePath);
  if (target === undefined || target === absolutePath) return;
  await assertNotSecretPath(target, target, inputPath, 'mutation');
  await assertNotGitInternals(target, target, inputPath, 'mutation');
  await assertNotMultiLinkFile(target, inputPath, 'mutation');
  await assertNotIgnored(target, inputPath, allowIgnored);
  const nearest = await nearestExistingRealPath(target);
  if (nearest === undefined) return;
  const realWorkspace = await fs.realpath(workspaceRoot()).catch(() => undefined);
  if (realWorkspace !== undefined && !isInsideDirectory(nearest, realWorkspace)) {
    throw new HazeToolError(
      `Refusing to modify ${inputPath}: its symlink target resolves outside the workspace. Ask the user to remove or fix the symlink before writing.`,
      'outside_workspace',
      {suggestedNextStep: 'Symlink escaping the workspace: do not write through it or with shell. Ask the user to remove or fix the symlink first.'},
    );
  }
}

/**
 * Resolve a read path and confine it to the workspace — unless the user
 * explicitly mentioned it (or a parent directory) in the prompt this turn.
 * Blessed paths skip both `.gitignore` enforcement and the workspace boundary
 * so the model can read host files the user pointed at. Secret-file,
 * git-internals, and hard-link protection are checked before the bless set
 * and are never bypassed.
 * Mutating tools use `prepareWorkspaceMutation` / `prepareWorkspaceWritePath`
 * instead, which never consult the bless set.
 */
export async function prepareWorkspaceRead(filePath: string, allowIgnored: boolean | undefined, context?: ToolExecutionContext) {
  const absolutePath = path.resolve(workspaceRoot(), filePath);
  const realRequested = await requestedRealPath(absolutePath);
  await assertNotSecretPath(absolutePath, realRequested, filePath, 'read');
  await assertNotGitInternals(absolutePath, realRequested, filePath, 'read');
  await assertNotMultiLinkFile(realRequested, filePath, 'read');
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

export async function prepareWorkspaceMutation(toolName: string, filePath: string, allowIgnored: boolean | undefined, context: ToolExecutionContext) {
  const absolutePath = resolveWorkspacePath(filePath);
  const realRequested = await requestedRealPath(absolutePath);
  await assertNotSecretPath(absolutePath, realRequested, filePath, 'mutation');
  await assertNotGitInternals(absolutePath, realRequested, filePath, 'mutation');
  await assertNotMultiLinkFile(realRequested, filePath, 'mutation');
  await assertNotIgnored(absolutePath, filePath, allowIgnored);
  await assertSymlinkWriteTargetSafe(absolutePath, filePath, allowIgnored);
  await assertRealPathInsideWorkspace(absolutePath, filePath);
  const scopedContext = await discoverScopedContext(filePath, context);
  const scopedStop = scopedContextMutationStop(toolName, filePath, scopedContext);
  return {absolutePath, scopedContext, scopedStop};
}

export async function prepareWorkspaceWritePath(toolName: string, filePath: string, allowIgnored: boolean | undefined, context: ToolExecutionContext) {
  const absolutePath = resolveWorkspacePath(filePath);
  const realRequested = await requestedRealPath(absolutePath);
  await assertNotSecretPath(absolutePath, realRequested, filePath, 'mutation');
  await assertNotGitInternals(absolutePath, realRequested, filePath, 'mutation');
  await assertNotMultiLinkFile(realRequested, filePath, 'mutation');
  await assertNotIgnored(absolutePath, filePath, allowIgnored);
  await assertSymlinkWriteTargetSafe(absolutePath, filePath, allowIgnored);
  const scopedContext = await discoverScopedContext(filePath, context);
  const scopedStop = scopedContextMutationStop(toolName, filePath, scopedContext);
  return {absolutePath, scopedContext, scopedStop, assertExistingInsideWorkspace: async () => await assertRealPathInsideWorkspace(absolutePath, filePath), assertWritableInsideWorkspace: async () => await assertWritablePathInsideWorkspace(absolutePath, filePath)};
}
