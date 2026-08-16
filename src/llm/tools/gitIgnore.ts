import fs from 'fs-extra';
import path from 'node:path';
import ignoreFactory, {type Ignore} from 'ignore';
import {workspaceRelativePath, workspaceRoot} from '../../utils/path.js';

/**
 * In-process `.gitignore` evaluation. No Git binary is required or used: rules
 * come from `.gitignore` files along the ancestor chain (deepest file wins,
 * last matching line within a file wins) plus `.git/info/exclude` at the root
 * (lowest precedence), matching Git's documented precedence order. The
 * evaluation is pure filesystem work — stat/read/regex — so it is fast enough
 * to call per walked entry and deterministic across environments.
 */

const GITIGNORE_FILE = '.gitignore';
const ROOT_EXCLUDE_FILE = path.join('.git', 'info', 'exclude');

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

/** A candidate path plus optional directory-ness; omitted means "stat it". */
export type IgnoreCandidate = {path: string; isDirectory?: boolean};

interface RuleFileState {
  mtimeMs: number;
  /** Compiled rules, or null when no such file exists in that directory. */
  rules: Ignore | null;
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

/** Normalize separators so Windows-style relatives probe like POSIX paths. */
function probePath(relPath: string, isDirectory: boolean) {
  const normalized = relPath.split(/[\\/]+/).join('/');
  return isDirectory ? `${normalized}/` : normalized;
}

async function lstatIsDirectory(absolutePath: string) {
  try {
    return (await fs.lstat(absolutePath)).isDirectory();
  } catch {
    return false;
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
  const ruleFiles = new Map<string, RuleFileState>();

  async function loadRuleFile(relDir: string, fileName: string): Promise<RuleFileResult> {
    const cacheKey = relDir ? `${relDir.split(path.sep).join('/')}/${fileName}` : fileName;
    const absolute = relDir ? path.join(root, relDir, fileName) : path.join(root, fileName);
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(absolute)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const absent: RuleFileState = {mtimeMs: -1, rules: null};
        ruleFiles.set(cacheKey, absent);
        return absent;
      }
      // Exists (or unknowable) but cannot be stat-read: not cached, retried next call.
      return {unreadable: true};
    }
    const cached = ruleFiles.get(cacheKey);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    try {
      const rules = ignoreFactory().add(await fs.readFile(absolute, 'utf8'));
      const state: RuleFileState = {mtimeMs, rules};
      ruleFiles.set(cacheKey, state);
      return state;
    } catch {
      return {unreadable: true};
    }
  }

  /**
   * Verdict for one path from its applicable rule files: `.gitignore` files in
   * the parent chain, deepest first (deeper overrides shallower), then the
   * root exclude file (lowest precedence). `unknown` is true when any file in
   * the chain could not be read.
   */
  async function verdictFor(relPath: string, isDirectory: boolean): Promise<{ignored: boolean; unknown: boolean}> {
    const probe = probePath(relPath, isDirectory);
    const parentSegments = probe.split('/').filter(segment => segment.length > 0).slice(0, -1);
    let unknown = false;
    for (let index = parentSegments.length; index >= 0; index--) {
      const relDir = parentSegments.slice(0, index).join('/');
      const state = await loadRuleFile(relDir, GITIGNORE_FILE);
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
    const exclude = await loadRuleFile('', ROOT_EXCLUDE_FILE);
    if ('unreadable' in exclude) return {ignored: false, unknown: true};
    if (exclude.rules) {
      const result = exclude.rules.test(probe);
      if (result.ignored || result.unignored) return {ignored: result.ignored, unknown};
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
    for (const [relPath, entry] of unique) {
      const isDirectory = entry.isDirectory ?? (await lstatIsDirectory(path.join(root, relPath)));
      const {status, checked: entryChecked} = await statusOf(relPath, isDirectory);
      if (!entryChecked) checked = false;
      if (status === 'ignored') ignored.add(relPath);
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
