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
  filter?: (entry: WalkEntry) => boolean | Promise<boolean>;
}

export async function walkDir(root: string, options: WalkOptions = {}): Promise<WalkEntry[]> {
  const {recursive = false, maxEntries = Infinity, filter} = options;
  const result: WalkEntry[] = [];

  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
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
      if (filter && !await filter(walkEntry)) continue;
      result.push(walkEntry);
      if (entry.isDirectory() && recursive) await walk(absolutePath);
    }
  }

  if (await fs.pathExists(root)) await walk(root);
  return result;
}

export async function listFilesRecursive(root: string): Promise<string[]> {
  const entries = await walkDir(root, {recursive: true});
  return entries.filter(e => e.isFile).map(e => e.path).sort();
}
