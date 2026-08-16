import fs from 'fs-extra';
import path from 'node:path';
import ignoreFactory, {type Ignore} from 'ignore';
import {workspaceRelativePath, workspaceRoot} from '../../utils/path.js';

/**
 * In-process `.gitignore` evaluation. No Git binary is required or used: rules
 * come from `.gitignore` files between the repository/worktree boundary and
 * each candidate (deepest file wins, last matching line within a file wins),
 * plus the resolved Git common directory's `info/exclude` at lowest precedence.
 * Global user excludes are intentionally omitted for deterministic workspaces. The
 * evaluation is pure filesystem work — stat/read/regex — so it is fast enough
 * to call per walked entry and deterministic across environments.
 */

const GITIGNORE_FILE = '.gitignore';
const GIT_POINTER_MAX_BYTES = 8 * 1024;

export type GitIgnoreStatus = 'ignored' | 'not-ignored' | 'unknown';

interface IgnoreClassification {
  /** Subset of the submitted paths the ignore rules report as ignored. */
  ignored: Set<string>;
  /**
   * False when an ignore file somewhere in the evaluated chains exists but
   * could not be read (e.g. permission denied). Reads treat that as "nothing
   * ignored" (fail open); mutation guards treat it as un-verifiable and fail
   * closed instead (F-05).
   */
  checked: boolean;
}

/** A candidate path plus optional walker metadata; omitted fields are derived. */
export type IgnoreCandidate = {path: string; absolutePath?: string; isDirectory?: boolean};

interface RuleFileState {
  mtimeMs: number;
  size: number;
  /** Compiled rules, or null when no such file exists in that directory. */
  rules: Ignore | null;
}

interface IgnoreRootContext {
  ignoreRoot: string;
  workspacePrefix: string;
  excludeFile?: string;
  checked: boolean;
}

type RuleFileResult = RuleFileState | {unreadable: true};

export interface IgnoreClassifier {
  /**
   * Classify candidate paths. Returns the subset the ignore rules report as
   * ignored. Fails open: candidates whose rules cannot be read are not
   * reported, so workspace reads are never blocked by ignore checks.
   */
  classify(candidates: readonly (string | IgnoreCandidate)[]): Promise<Set<string>>;
  /** Like `classify`, but distinguishes "checked" from "could not check" (F-05). */
  classifyChecked(candidates: readonly (string | IgnoreCandidate)[]): Promise<IgnoreClassification>;
}

/** Convert native separators only; a backslash is a valid POSIX filename byte. */
function gitPath(relPath: string) {
  return path.sep === '\\' ? relPath.replaceAll('\\', '/') : relPath;
}

function probePath(relPath: string, isDirectory: boolean) {
  const normalized = gitPath(relPath).replace(/^\.\//, '').replace(/\/$/, '');
  return isDirectory ? `${normalized}/` : normalized;
}

function isOutsideRoot(relativePath: string) {
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

async function lstatIsDirectory(absolutePath: string) {
  try {
    return (await fs.lstat(absolutePath)).isDirectory();
  } catch {
    return false;
  }
}

async function readSmallPointer(filePath: string) {
  const stat = await fs.stat(filePath);
  if (stat.size > GIT_POINTER_MAX_BYTES) throw new Error(`Git pointer file exceeds ${GIT_POINTER_MAX_BYTES} bytes.`);
  return fs.readFile(filePath, 'utf8');
}

async function resolveExcludeFile(repositoryRoot: string, gitMarker: string): Promise<{path?: string; checked: boolean}> {
  try {
    const markerStat = await fs.lstat(gitMarker);
    let gitDir = gitMarker;
    if (!markerStat.isDirectory()) {
      const pointer = /^gitdir:\s*(.+)\s*$/im.exec(await readSmallPointer(gitMarker))?.[1];
      if (!pointer) return {checked: false};
      gitDir = path.resolve(repositoryRoot, pointer);
    }
    const commonDirFile = path.join(gitDir, 'commondir');
    try {
      const commonDir = (await readSmallPointer(commonDirFile)).trim();
      if (commonDir) gitDir = path.resolve(gitDir, commonDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return {checked: false};
    }
    return {path: path.join(gitDir, 'info', 'exclude'), checked: true};
  } catch {
    return {checked: false};
  }
}

/** Find the repository boundary without requiring Git, including linked worktrees. */
async function discoverIgnoreRoot(workspace: string): Promise<IgnoreRootContext> {
  let current = path.resolve(workspace);
  while (true) {
    const marker = path.join(current, '.git');
    try {
      await fs.lstat(marker);
      const exclude = await resolveExcludeFile(current, marker);
      const workspaceRelative = path.relative(current, workspace);
      return {
        ignoreRoot: current,
        workspacePrefix: workspaceRelative === '' ? '' : gitPath(workspaceRelative),
        ...(exclude.path ? {excludeFile: exclude.path} : {}),
        checked: exclude.checked,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {ignoreRoot: workspace, workspacePrefix: '', checked: false};
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return {ignoreRoot: workspace, workspacePrefix: '', checked: true};
    current = parent;
  }
}

/**
 * Create an ignore classifier rooted at `root` (defaults to the workspace
 * root). One classifier should own an entire listing operation: it memoizes
 * compiled rule files by mtime, so a walk stats each `.gitignore` once per
 * mtime change instead of re-reading it per entry. Nothing is cached across
 * classifier instances, so external edits are always picked up.
 */
export function createIgnoreClassifier(root: string = workspaceRoot()): IgnoreClassifier {
  const workspace = path.resolve(root);
  const rootContext = discoverIgnoreRoot(workspace);
  const ruleFiles = new Map<string, RuleFileState>();

  async function loadAbsoluteRuleFile(absolute: string): Promise<RuleFileResult> {
    let stat: {mtimeMs: number; size: number};
    try {
      stat = await fs.stat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const absent: RuleFileState = {mtimeMs: -1, size: -1, rules: null};
        ruleFiles.set(absolute, absent);
        return absent;
      }
      // Exists (or unknowable) but cannot be stat-read: not cached, retried next call.
      return {unreadable: true};
    }
    const cached = ruleFiles.get(absolute);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    try {
      const rules = ignoreFactory().add(await fs.readFile(absolute, 'utf8'));
      const state: RuleFileState = {mtimeMs: stat.mtimeMs, size: stat.size, rules};
      ruleFiles.set(absolute, state);
      return state;
    } catch {
      return {unreadable: true};
    }
  }

  async function loadRuleFile(relDir: string): Promise<RuleFileResult> {
    const context = await rootContext;
    return loadAbsoluteRuleFile(path.join(context.ignoreRoot, relDir, GITIGNORE_FILE));
  }

  /**
   * Verdict for one path from its applicable rule files: `.gitignore` files in
   * the parent chain, deepest first (deeper overrides shallower), then the
   * root exclude file (lowest precedence). `unknown` is true when any file in
   * the chain could not be read.
   */
  async function verdictFor(relPath: string, isDirectory: boolean): Promise<{ignored: boolean; unknown: boolean}> {
    const context = await rootContext;
    const probe = probePath(relPath, isDirectory);
    const parentSegments = probe.split('/').filter(segment => segment.length > 0).slice(0, -1);
    let unknown = !context.checked;
    for (let index = parentSegments.length; index >= 0; index--) {
      const relDir = parentSegments.slice(0, index).join('/');
      const state = await loadRuleFile(relDir);
      if ('unreadable' in state) {
        unknown = true;
        continue;
      }
      if (!state.rules) continue;
      // Paths probed against a nested rule file are relative to its directory.
      const relToDir = index === 0 ? probe : probe.slice(relDir.length + 1);
      const result = state.rules.test(relToDir);
      if (result.ignored || result.unignored) return {ignored: result.ignored, unknown};
    }
    if (context.excludeFile) {
      const exclude = await loadAbsoluteRuleFile(context.excludeFile);
      if ('unreadable' in exclude) return {ignored: false, unknown: true};
      if (exclude.rules) {
        const result = exclude.rules.test(probe);
        if (result.ignored || result.unignored) return {ignored: result.ignored, unknown};
      }
    }
    return {ignored: false, unknown};
  }

  /**
   * Tri-state status for one root-relative path. Any ignored ancestor makes
   * the path ignored (Git cannot re-include below an excluded directory);
   * otherwise the deepest matching rule decides the leaf itself.
   */
  async function statusOf(relPath: string, isDirectory: boolean): Promise<{status: GitIgnoreStatus; checked: boolean}> {
    const segments = probePath(relPath, isDirectory).replace(/\/$/, '').split('/');
    let unknown = false;
    for (let depth = 1; depth <= segments.length; depth++) {
      const rel = segments.slice(0, depth).join('/');
      const isDir = depth < segments.length || isDirectory;
      const verdict = await verdictFor(rel, isDir);
      if (verdict.unknown) unknown = true;
      // An ignored prefix is decisive: everything below it is ignored too.
      if (verdict.ignored) return {status: 'ignored', checked: !unknown};
    }
    return {status: 'not-ignored', checked: !unknown};
  }

  const classifyChecked = async (candidates: readonly (string | IgnoreCandidate)[]): Promise<IgnoreClassification> => {
    // De-duplicate while preserving the first occurrence's directory hint.
    const unique = new Map<string, IgnoreCandidate>();
    for (const candidate of candidates) {
      const entry = typeof candidate === 'string' ? {path: candidate} : candidate;
      if (!entry.path || entry.path === '.') continue;
      if (!unique.has(entry.path)) unique.set(entry.path, entry);
    }
    const ignored = new Set<string>();
    let checked = true;
    const context = await rootContext;
    for (const [relPath, entry] of unique) {
      const workspaceRelative = entry.absolutePath ? path.relative(workspace, entry.absolutePath) : relPath;
      if (isOutsideRoot(workspaceRelative)) continue;
      const absolutePath = entry.absolutePath ?? path.join(workspace, workspaceRelative);
      const isDirectory = entry.isDirectory ?? (await lstatIsDirectory(absolutePath));
      const workspaceProbe = gitPath(workspaceRelative);
      const ignoreRelative = context.workspacePrefix ? `${context.workspacePrefix}/${workspaceProbe}` : workspaceProbe;
      const {status, checked: entryChecked} = await statusOf(ignoreRelative, isDirectory);
      if (!entryChecked) checked = false;
      // Reads fail open: an uncertain verdict is never returned as ignored.
      if (status === 'ignored' && entryChecked) ignored.add(relPath);
    }
    return {ignored, checked};
  };

  return {
    classifyChecked,
    classify: async (candidates: readonly (string | IgnoreCandidate)[]) => (await classifyChecked(candidates)).ignored,
  };
}

/** Classify a set of root-relative paths. */
export async function classifyGitIgnored(relativePaths: readonly string[], root?: string): Promise<Set<string>> {
  return createIgnoreClassifier(root ?? workspaceRoot()).classify(relativePaths);
}

export async function isGitIgnored(absolutePath: string): Promise<boolean> {
  return (await checkGitIgnored(absolutePath)) === 'ignored';
}

/** Tri-state single-path check: mutation guards key off `unknown` (F-05). */
export async function checkGitIgnored(absolutePath: string): Promise<GitIgnoreStatus> {
  const root = workspaceRoot();
  const relative = workspaceRelativePath(absolutePath);
  if (relative === '.' || relative.startsWith('..')) return 'not-ignored'; // root, or outside the workspace: no rules apply
  const isDirectory = await lstatIsDirectory(absolutePath);
  const {ignored, checked} = await createIgnoreClassifier(root).classifyChecked([{path: relative, isDirectory}]);
  if (!checked) return 'unknown';
  return ignored.has(relative) ? 'ignored' : 'not-ignored';
}
