import {describe, it, expect} from 'vitest';
import path from 'node:path';
import {resolveWorkspacePath, workspaceRelativePath} from '../../src/utils/path.js';

describe('resolveWorkspacePath', () => {
  it('resolves relative paths to workspace', () => {
    const result = resolveWorkspacePath('src/index.ts');
    expect(result).toBe(path.resolve(process.cwd(), 'src/index.ts'));
  });

  it('resolves "." to workspace root', () => {
    const result = resolveWorkspacePath('.');
    expect(result).toBe(process.cwd());
  });

  it('rejects paths with ..', () => {
    expect(() => resolveWorkspacePath('../outside')).toThrow('outside the workspace');
  });

  it('rejects absolute paths outside workspace', () => {
    expect(() => resolveWorkspacePath('/etc/passwd')).toThrow('outside the workspace');
  });

  it('allows nested paths like src/index.ts', () => {
    expect(() => resolveWorkspacePath('src/utils/path.ts')).not.toThrow();
  });
});

describe('workspaceRelativePath', () => {
  it('returns relative path for files in workspace', () => {
    const absolute = path.join(process.cwd(), 'src', 'index.ts');
    expect(workspaceRelativePath(absolute)).toBe('src/index.ts');
  });

  it('returns "." for workspace root', () => {
    expect(workspaceRelativePath(process.cwd())).toBe('.');
  });
});
