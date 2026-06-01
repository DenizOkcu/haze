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
  filter?: (entry: WalkEntry) => boolean | Promise<boolean>;
}

export async function walkDir(root: string, options: WalkOptions = {}): Promise<WalkEntry[]> {
  const {recursive = false, maxEntries = Infinity, cursor, filter} = options;
  const result: WalkEntry[] = [];
  let cursorSeen = cursor == null;

  async function walk(dir: string) {
    const entries = (await fs.readdir(dir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= maxEntries) return;
      if (SKIP_ENTRIES.has(entry.name)) continue;
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolutePath);
      const walkEntry: WalkEntry = {
        path: relativePath,
        absolutePath,
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      };
      const passesFilter = !filter || await filter(walkEntry);
      if (passesFilter && cursorSeen) result.push(walkEntry);
      if (passesFilter && !cursorSeen && relativePath === cursor) cursorSeen = true;
      if (entry.isDirectory() && recursive && (!filter || passesFilter)) await walk(absolutePath);
    }
  }

  if (await fs.pathExists(root)) await walk(root);
  return result;
}

export async function listFilesRecursive(root: string): Promise<string[]> {
  const entries = await walkDir(root, {recursive: true});
  return entries.filter(e => e.isFile).map(e => e.path).sort();
}
