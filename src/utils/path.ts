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
