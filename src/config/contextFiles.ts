import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {HAZE_DIR} from './paths.js';

export interface ContextFile {
  path: string;
  content: string;
}

const CONTEXT_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'];
const MAX_CONTEXT_FILE_CHARS = 20_000;

function uniqueExistingAncestors(fromDir: string) {
  const dirs: string[] = [];
  let current = path.resolve(fromDir);
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.reverse();
}

function displayPath(filePath: string) {
  const home = os.homedir();
  const cwd = process.cwd();
  if (filePath.startsWith(cwd + path.sep) || filePath === cwd) return path.relative(cwd, filePath) || path.basename(filePath);
  if (filePath.startsWith(home + path.sep)) return `~/${path.relative(home, filePath)}`;
  return filePath;
}

export async function readContextFiles(cwd = process.cwd()): Promise<ContextFile[]> {
  const candidates: string[] = [];

  for (const name of CONTEXT_FILE_NAMES) {
    candidates.push(path.join(HAZE_DIR, name));
  }

  for (const dir of uniqueExistingAncestors(cwd)) {
    for (const name of CONTEXT_FILE_NAMES) {
      candidates.push(path.join(dir, name));
    }
  }

  const seen = new Set<string>();
  const contextFiles: ContextFile[] = [];
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    if (!await fs.pathExists(absolute)) continue;
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile()) continue;
    const content = await fs.readFile(absolute, 'utf8');
    contextFiles.push({
      path: displayPath(absolute),
      content: content.length > MAX_CONTEXT_FILE_CHARS
        ? `${content.slice(0, MAX_CONTEXT_FILE_CHARS)}\n\n[Context file truncated: ${content.length - MAX_CONTEXT_FILE_CHARS} characters omitted]`
        : content,
    });
  }
  return contextFiles;
}
