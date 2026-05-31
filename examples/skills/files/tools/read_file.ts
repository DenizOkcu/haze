import fs from 'node:fs/promises';
import path from 'node:path';

export async function execute(input: {path: string}, context: {cwd: string}) {
  if (!input.path) return {ok: false, message: 'Missing path.'};
  const full = path.resolve(context.cwd, input.path);
  if (!full.startsWith(context.cwd)) return {ok: false, message: 'Refusing to read outside the current project.'};
  const stat = await fs.stat(full);
  if (!stat.isFile()) return {ok: false, message: 'Path is not a file.'};
  if (stat.size > 200_000) return {ok: false, message: 'File is too large for the intentionally tiny attention span.'};
  return {ok: true, message: `Read ${input.path}.`, data: await fs.readFile(full, 'utf8')};
}
