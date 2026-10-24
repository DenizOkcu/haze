import fs from 'node:fs/promises';
import path from 'node:path';
import type {Dirent} from 'node:fs';

/** True when the path exists; false for any error (missing path, permissions, bad root). */
export async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Parse a JSON file, tolerating a UTF-8 BOM; malformed JSON still throws loudly. */
export async function readJson(file: string): Promise<unknown> {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

/** Create a directory (and parents) if missing; never throws when it already exists. */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, {recursive: true});
}

/** Remove a file or directory tree; a missing path is not an error. */
export function remove(target: string): Promise<void> {
  return fs.rm(target, {recursive: true, force: true});
}

/** Rename, falling back to copy+delete across filesystems. Callers guard destination collisions. */
export async function move(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fs.cp(src, dest, {recursive: true});
    await fs.rm(src, {recursive: true, force: true});
  }
}

// Repository metadata and dependency trees are never useful discovery targets.
// Skip both even when a project has no `.gitignore`: this keeps traversal bounded
// and prevents dependency contents from crowding out workspace source files.
const SKIP_ENTRIES = new Set(['.git', 'node_modules']);

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
   * directory's children (with real directory-ness, so dir-only patterns
   * evaluate exactly like Git), return the subset that is ignored. Ignored
   * entries are dropped and ignored directories are not descended into.
   * Evaluation is in-process, so a listing costs O(visited directories) rule
   * file reads rather than one per entry (RH-001). Fails open: an empty set
   * means "keep all".
   */
  ignoreBatch?: (entries: WalkEntry[]) => Promise<Set<string>>;
}

export async function walkDir(root: string, options: WalkOptions = {}): Promise<WalkEntry[]> {
  const {recursive = false, maxEntries = Infinity, filter, ignoreBatch} = options;
  const result: WalkEntry[] = [];
  // Cursor semantics: the cursor is the last entry a previous page returned.
  // This walk resumes strictly *after* that entry in depth-first traversal
  // order, without re-checking or even descending into earlier subtrees.
  // An empty/whitespace cursor normalizes to absent: callers whose optional
  // pagination field materializes as "" (JSON round-trips, default-filled
  // schemas) must not silently receive an empty first page (RT-01).
  const cursor = typeof options.cursor === 'string' && options.cursor.trim() !== '' ? options.cursor : undefined;
  const cursorSegments = cursor ? cursor.split(/[\\/]/).filter(Boolean) : [];
  let collecting = cursor == null;

  if (!(await pathExists(root))) return result;

  async function readSortedChildren(dir: string) {
    const entries = await fs.readdir(dir, {withFileTypes: true});
    return entries.filter(entry => !SKIP_ENTRIES.has(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  }

  function toWalkEntry(dir: string, dirent: Dirent): WalkEntry {
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
    const ignored = await ignoreBatch(entries);
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
