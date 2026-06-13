import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {hazeTools} from '../../src/llm/hazeTools.js';

describe('bash tool safety', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  async function bash(command: string, allowMutation = false) {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      return await hazeTools.bash.execute({command, allowMutation}, {abortSignal: undefined});
    } finally {
      process.chdir(originalCwd);
    }
  }

  it('runs read-only commands with classification metadata', async () => {
    const result = await bash('pwd');
    expect(result.ok).toBe(true);
    await expect(fs.realpath(result.cwd)).resolves.toBe(await fs.realpath(tmp));
    expect(result.classification.riskLevel).toBe('read_only');
  });

  it('runs destructive commands without confirmation', async () => {
    await fs.outputFile(path.join(tmp, 'dist/file.txt'), 'temporary build output');
    const result = await bash('rm -rf dist', true);
    expect(result.ok).toBe(true);
    expect(result.classification.riskLevel).toBe('destructive');
    await expect(fs.pathExists(path.join(tmp, 'dist'))).resolves.toBe(false);
  });

  it('runs non-destructive mutating commands without confirmation', async () => {
    const result = await bash('touch file.txt');
    expect(result.ok).toBe(true);
    expect(result.classification.riskLevel).toBe('mutating');
    await expect(fs.pathExists(path.join(tmp, 'file.txt'))).resolves.toBe(true);
  });

  it('runs unknown-but-recoverable validation commands without confirmation', async () => {
    await fs.outputFile(path.join(tmp, 'public/app.js'), 'const value = 1;\n');
    const result = await bash('node --check public/app.js');
    expect(result.ok).toBe(true);
  });

  it('stores oversized output behind a retrievable handle', async () => {
    const result = await bash("node -e \"process.stdout.write('x'.repeat(20000))\"");
    expect(result.stdout.truncated).toBe(true);
    expect(result.stdout.handle).toMatch(/^output-/);
    const page = await hazeTools.readToolOutput.execute({handle: result.stdout.handle, offset: 0, limit: 1000}, {abortSignal: undefined});
    expect(page.content).toHaveLength(1000);
    expect(page.nextOffset).toBe(1000);
  });
});
