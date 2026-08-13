import fs from 'fs-extra';
import path from 'node:path';

const SKIP_ENTRIES = new Set(['node_modules', '.git']);

export interface WalkEntry {
  path: string;
  absolutePath: string;
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface WalkOptions {
  recursive?: boolean;
  maxEntries?: number;
  cursor?: string;
  /** Legacy per-entry filter applied after ignore pruning. Avoid for directory walks: it forces a check per entry. */
  filter?: (entry: WalkEntry) => boolean | Promise<boolean>;
  /**
   * Batched ignore classification over workspace-relative paths. Given a
   * directory's children, return the subset that is Git-ignored. Ignored
   * entries are dropped and ignored directories are not descended into, so a
   * listing needs O(number of visited directories) Git subprocesses rather
   * than one per entry (RH-001). Fails open: an empty set means "keep all".
   */
  ignoreBatch?: (relativePaths: string[]) => Promise<Set<string>>;
}

export async function walkDir(root: string, options: WalkOptions = {}): Promise<WalkEntry[]> {
  const {recursive = false, maxEntries = Infinity, cursor, filter, ignoreBatch} = options;
  const result: WalkEntry[] = [];
  // Cursor semantics: the cursor is the last entry a previous page returned.
  // This walk resumes strictly *after* that entry in depth-first traversal
  // order, without re-checking or even descending into earlier subtrees.
  const cursorSegments = cursor ? cursor.split(/[\\/]/).filter(Boolean) : [];
  let collecting = cursor == null;

  if (!(await fs.pathExists(root))) return result;

  async function readSortedChildren(dir: string) {
    const entries = await fs.readdir(dir, {withFileTypes: true});
    return entries.filter(entry => !SKIP_ENTRIES.has(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  }

  function toWalkEntry(dir: string, dirent: fs.Dirent): WalkEntry {
    const absolutePath = path.join(dir, dirent.name);
    return {
      path: path.relative(root, absolutePath),
      absolutePath,
      name: dirent.name,
      isDirectory: dirent.isDirectory(),
      isFile: dirent.isFile(),
    };
  }

  async function keepNonIgnored(entries: WalkEntry[]): Promise<WalkEntry[]> {
    if (!ignoreBatch) return entries;
    if (entries.length === 0) return entries;
    const ignored = await ignoreBatch(entries.map(entry => entry.path));
    if (ignored.size === 0) return entries;
    return entries.filter(entry => !ignored.has(entry.path));
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (result.length >= maxEntries) return;

    const dirents = await readSortedChildren(dir);
    const entries = dirents.map(dirent => toWalkEntry(dir, dirent));

    if (collecting) {
      const kept = await keepNonIgnored(entries);
      for (const entry of kept) {
        if (result.length >= maxEntries) return;
        const passesFilter = !filter || (await filter(entry));
        if (passesFilter) result.push(entry);
        if (passesFilter && recursive && entry.isDirectory) await walk(entry.absolutePath, depth + 1);
      }
      return;
    }

    // Pre-cursor region. The cursor's branch child at this depth splits the
    // sorted children into three DFS-ordered groups: entries strictly before
    // the branch (pre-cursor: skipped without classifying or descending), the
    // branch child itself (descended into to resolve the cursor, never emitted),
    // and entries after the branch (post-cursor: emitted normally). This keeps
    // a later page from re-checking or re-walking earlier subtrees (RH-001).
    const branchName = depth < cursorSegments.length ? cursorSegments[depth] : undefined;
    const branchIndex = branchName ? entries.findIndex(entry => entry.name === branchName) : -1;
    if (branchIndex === -1) return; // stale cursor: emit nothing rather than duplicate earlier pages

    const branch = entries[branchIndex]!;
    const atCursorLevel = depth >= cursorSegments.length - 1;
    if (atCursorLevel) {
      // The branch child is the cursor entry itself; do not re-emit it. If it is
      // a directory its children follow it in DFS order, so descend now that we
      // are collecting.
      if (branch.path === cursor) {
        collecting = true;
        if (recursive && branch.isDirectory) await walk(branch.absolutePath, depth + 1);
      }
    } else if (branch.isDirectory && recursive) {
      // Ancestor directory: descend to resolve the cursor deeper in the tree.
      await walk(branch.absolutePath, depth + 1);
    }

    if (!collecting) return; // cursor was not found inside the branch (stale)

    // Post-cursor siblings at this level are emitted and descended normally.
    const keptPost = await keepNonIgnored(entries.slice(branchIndex + 1));
    for (const entry of keptPost) {
      if (result.length >= maxEntries) return;
      const passesFilter = !filter || (await filter(entry));
      if (passesFilter) result.push(entry);
      if (passesFilter && recursive && entry.isDirectory) await walk(entry.absolutePath, depth + 1);
    }
  }

  await walk(root, 0);
  return result;
}
