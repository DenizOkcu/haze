import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';

const MAX_PACKAGE_BYTES = 64 * 1024;
const MAX_CHILD_DIRS = 12;
const MAX_SCRIPTS = 12;

async function scriptsAt(file: string): Promise<string[] | undefined> {
  try {
    // O_NOFOLLOW closes the lstat/read race for a symlinked package file on
    // POSIX. Windows does not expose it, so the bounded read remains best
    // effort there and the prompt still contains names only.
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const handle = await fs.open(file, constants.O_RDONLY | noFollow);
    let content: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) return undefined;
      content = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('scripts' in parsed)) return [];
    const scripts = (parsed as {scripts?: unknown}).scripts;
    if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return [];
    return Object.entries(scripts).filter(([name, value]) => /^[A-Za-z0-9:._/-]{1,80}$/.test(name) && typeof value === 'string').map(([name]) => name).sort().slice(0, MAX_SCRIPTS);
  } catch {
    return undefined;
  }
}

/** Read-only, bounded hints for a compact-profile model; never runs a command. */
export async function projectPreflight(cwd: string): Promise<string> {
  const packages: string[] = [];
  const rootScripts = await scriptsAt(path.join(cwd, 'package.json'));
  if (rootScripts) packages.push(`.: ${rootScripts.join(', ') || '(no scripts)'}`);
  try {
    const children = (await fs.readdir(cwd, {withFileTypes: true}))
      .filter(entry => entry.isDirectory() && entry.name.length <= 80 && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => entry.name).sort().slice(0, MAX_CHILD_DIRS);
    for (const child of children) {
      const scripts = await scriptsAt(path.join(cwd, child, 'package.json'));
      if (scripts) packages.push(`${child}: ${scripts.join(', ') || '(no scripts)'}`);
    }
  } catch {
    // A missing/unreadable workspace remains a normal tool error later.
  }
  return packages.length ? `<project_preflight>Package scripts by directory (names only; verify before running): ${packages.join(' | ')}</project_preflight>` : '';
}
