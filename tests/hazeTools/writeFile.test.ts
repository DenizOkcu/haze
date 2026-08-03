import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {hazeTools} from '../../src/llm/hazeTools.js';

const execFile = promisify(execFileCallback);

describe('writeFile tool', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-writefile-test-'));
    originalCwd = process.cwd();
    await execFile('git', ['init', '-q', tmp]);
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(tmp);
  });

  async function writeFile(params: {path: string; content: string; overwriteExisting?: boolean; allowIgnored?: boolean}, context?: unknown) {
    return await hazeTools.writeFile.execute({
      path: params.path,
      content: params.content,
      overwriteExisting: params.overwriteExisting ?? false,
      allowIgnored: params.allowIgnored ?? false,
    }, {abortSignal: undefined, context});
  }

  it('creates a new file and creates missing parent directories', async () => {
    const result = await writeFile({path: 'nested/dir/app.txt', content: 'hello'});
    expect(result).toMatchObject({ok: true, path: 'nested/dir/app.txt', bytes: 5, overwritten: false});
    await expect(fs.readFile(path.join(tmp, 'nested/dir/app.txt'), 'utf8')).resolves.toBe('hello');
  });

  it('refuses to overwrite an existing file without overwriteExisting', async () => {
    await fs.writeFile(path.join(tmp, 'existing.txt'), 'original');
    const result = await writeFile({path: 'existing.txt', content: 'replacement'});
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe('existing_file_requires_overwrite');
    expect(result.recoveryTool).toBe('readFile');
    expect(result.suggestedNextStep).toBeTruthy();
    await expect(fs.readFile(path.join(tmp, 'existing.txt'), 'utf8')).resolves.toBe('original');
  });

  it('overwrites an existing file when explicitly approved', async () => {
    await fs.writeFile(path.join(tmp, 'existing.txt'), 'original');
    const result = await writeFile({path: 'existing.txt', content: 'replacement', overwriteExisting: true});
    expect(result).toMatchObject({ok: true, overwritten: true});
    await expect(fs.readFile(path.join(tmp, 'existing.txt'), 'utf8')).resolves.toBe('replacement');
  });

  it('rejects ignored paths by default and writes them with allowIgnored', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'build.log\n');
    const blocked = await writeFile({path: 'build.log', content: 'x'});
    expect(blocked).toMatchObject({ok: false, reasonCode: 'ignored_path'});
    const allowed = await writeFile({path: 'build.log', content: 'x', allowIgnored: true});
    expect(allowed.ok).toBe(true);
  });

  it('fails with a structured error for paths outside the workspace', async () => {
    const result = await writeFile({path: '../escape.txt', content: 'x'});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside the workspace');
    await expect(fs.pathExists(path.join(tmp, '..', 'escape.txt'))).resolves.toBe(false);
  });

  it('stops the mutation when scoped instructions are newly discovered', async () => {
    await fs.outputFile(path.join(tmp, 'pkg/AGENTS.md'), 'pkg rules');
    await fs.outputFile(path.join(tmp, 'pkg/src/a.ts'), 'old');
    const context = {loadedContextFilePaths: new Set<string>()};
    const result = await writeFile({path: 'pkg/src/a.ts', content: 'x', overwriteExisting: true}, context);
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe('scoped_instructions_discovered');
    expect(result.applicableProjectInstructions).toEqual([expect.objectContaining({path: 'pkg/AGENTS.md'})]);
    await expect(fs.readFile(path.join(tmp, 'pkg/src/a.ts'), 'utf8')).resolves.toBe('old');

    // Edit-recovery gating: retrying without a fresh read throws until the file is read.
    await expect(writeFile({path: 'pkg/src/a.ts', content: 'x', overwriteExisting: true}, context)).rejects.toThrow(/Read pkg\/src\/a\.ts before attempting another edit/);
    await hazeTools.readFile.execute({path: 'pkg/src/a.ts', mode: 'exact', allowIgnored: false}, {abortSignal: undefined, context});
    const retry = await writeFile({path: 'pkg/src/a.ts', content: 'x', overwriteExisting: true}, context);
    expect(retry.ok).toBe(true);
  });
});
