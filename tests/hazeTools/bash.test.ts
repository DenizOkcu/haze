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

  it('searches stored output handles with context lines', async () => {
    const result = await bash("node -e \"for (let i = 0; i < 2000; i++) console.log(i === 1234 ? 'needle failure' : 'line ' + i)\"");
    expect(result.stdout.handle).toMatch(/^output-/);
    const page = await hazeTools.readToolOutput.execute({handle: result.stdout.handle, offset: 0, limit: 1000, query: 'needle', contextLines: 1}, {abortSignal: undefined});
    expect(page.query).toBe('needle');
    expect(page.content).toContain('needle failure');
    expect(page.content).toContain('1234: line 1233');
    expect(page.content).toContain('1236: line 1235');
  });

  it('bounds runaway command output without hanging the reduction pipeline', async () => {
    // Emits ~2 MB of stdout. The reduction pipeline caps the raw output it
    // scans, so a huge or pathological command output cannot pin the event loop
    // and freeze the agent (whose idle-timeout shares the same loop). The final
    // rendered output stays within the compact ceiling regardless of input size.
    const result = await bash("node -e \"process.stdout.write('line\\n'.repeat(400000))\"");
    expect(result.ok).toBe(true);
    expect(result.stdout.text.length).toBeLessThan(20_000);
  }, 15_000);

  it('keeps the full raw output retrievable even when it exceeds the raw cap', async () => {
    // Outputs larger than MAX_RAW_OUTPUT_CHARS are reduced from a capped *copy*,
    // but the full raw must still be stored behind the readToolOutput handle so
    // the model can page into the middle. Regression: an earlier version capped
    // before storage and permanently lost everything past the ceiling.
    const script = "let s='a'.repeat(250000); s=s+'NEEDLE_END'+'b'.repeat(5000); process.stdout.write(s)";
    const result = await bash(`node -e "${script}"`);
    expect(result.stdout.handle).toMatch(/^output-/);
    const page = await hazeTools.readToolOutput.execute({handle: result.stdout.handle, offset: 250000, limit: 50}, {abortSignal: undefined});
    expect(page.content).toContain('NEEDLE_END');
  }, 15_000);
});
