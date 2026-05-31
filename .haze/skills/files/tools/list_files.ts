import fs from 'node:fs/promises';
import path from 'node:path';

export async function execute(input: {dir?: string}, context: {cwd: string}) {
  const root = path.resolve(context.cwd, input.dir ?? '.');
  if (!root.startsWith(context.cwd)) return {ok: false, message: 'Refusing to list outside the current project.'};
  const files: string[] = [];
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir)) {
      if (entry === '.git' || entry === 'node_modules' || entry === 'dist') continue;
      const full = path.join(dir, entry);
      const rel = path.relative(context.cwd, full);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) await walk(full);
      else files.push(rel);
      if (files.length >= 500) return;
    }
  }
  await walk(root);
  return {ok: true, message: `Found ${files.length} files.`, data: files.sort()};
}
