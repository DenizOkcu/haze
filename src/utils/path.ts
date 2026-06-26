import fs from 'node:fs/promises';
import path from 'node:path';

export function workspaceRoot() {
  return process.cwd();
}

export function resolveWorkspacePath(inputPath: string) {
  const root = workspaceRoot();
  const resolved = path.resolve(root, inputPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the workspace: ${inputPath}`);
  }
  return resolved;
}

export function workspaceRelativePath(absolutePath: string) {
  return path.relative(workspaceRoot(), absolutePath) || '.';
}

function assertPathInsideRoot(root: string, candidate: string, inputPath: string) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the workspace: ${inputPath}`);
  }
}

export async function assertRealPathInsideWorkspace(absolutePath: string, inputPath = absolutePath): Promise<void> {
  const [realRoot, realPath] = await Promise.all([
    fs.realpath(workspaceRoot()),
    fs.realpath(absolutePath),
  ]);
  assertPathInsideRoot(realRoot, realPath, inputPath);
}

async function nearestExistingPath(absolutePath: string): Promise<string> {
  let current = absolutePath;
  while (true) {
    try {
      await fs.access(current);
      return current;
    } catch (error) {
      const code = typeof error === 'object' && error != null && 'code' in error ? (error as {code?: unknown}).code : undefined;
      if (code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function assertWritablePathInsideWorkspace(absolutePath: string, inputPath = absolutePath): Promise<void> {
  const [realRoot, existing] = await Promise.all([
    fs.realpath(workspaceRoot()),
    nearestExistingPath(absolutePath),
  ]);
  const realExisting = await fs.realpath(existing);
  assertPathInsideRoot(realRoot, realExisting, inputPath);
}
