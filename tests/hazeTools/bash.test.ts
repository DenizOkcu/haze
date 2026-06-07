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

  it('blocks destructive commands even with allowMutation', async () => {
    const result = await bash('rm -rf dist', true);
    expect(result.ok).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    expect(result.reasonCode).toBe('destructive_command_requires_confirmation');
  });

  it('requires confirmation for mutating commands without allowMutation', async () => {
    const result = await bash('touch file.txt');
    expect(result.ok).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    expect(result.reasonCode).toBe('mutating_command_requires_confirmation');
    await expect(fs.pathExists(path.join(tmp, 'file.txt'))).resolves.toBe(false);
  });
});
