import fs from 'fs-extra';
import path from 'node:path';

export async function ensureParent(file: string) {
  await fs.ensureDir(path.dirname(file));
}

export async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir)) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const full = path.join(dir, entry);
      const rel = path.relative(root, full);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) await walk(full);
      else out.push(rel);
    }
  }
  if (await fs.pathExists(root)) await walk(root);
  return out.sort();
}
