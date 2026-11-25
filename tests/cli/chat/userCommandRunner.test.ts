import {describe, expect, it, vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runUserCommand, toUserCommandRun} from '../../../src/cli/chat/userCommandRunner.js';
import {readToolOutput} from '../../../src/core/agent/toolOutputStore.js';
import {formatUserCommandRecord} from '../../../src/core/agent/userCommands.js';

// Mock readSettings so tests never depend on the user's real ~/.haze/settings.json.
vi.mock('../../../src/config/settings.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/config/settings.js')>();
  return {...actual, readSettings: async () => ({})};
});

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'haze-user-command-'));
}

describe('runUserCommand (through the shell tool)', () => {
  it('captures both streams and a zero exit as completed (R1)', async () => {
    const run = await runUserCommand({command: 'echo out; echo err 1>&2'});
    expect(run.status).toBe('completed');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.text.trim()).toBe('out');
    expect(run.stderr.text.trim()).toBe('err');
  });

  it('reports a non-zero exit as failed with its code (R2)', async () => {
    expect(await runUserCommand({command: 'exit 3'})).toMatchObject({status: 'failed', exitCode: 3});
  });

  it('keeps the shell error for an unknown command (R3)', async () => {
    const run = await runUserCommand({command: 'definitely-not-a-command-xyz'});
    expect(run.status).toBe('failed');
    expect(run.exitCode).not.toBe(0);
    expect(`${run.stderr.text}${run.stdout.text}`).toMatch(/not found/);
  });

  it('ends by itself when the command waits for stdin (R5)', async () => {
    expect((await runUserCommand({command: 'cat'})).status).toBe('completed');
  }, 10_000);

  it('resolves cancelled when the signal fires mid-run (R6)', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runUserCommand({command: 'sleep 30', signal: controller.signal});
    setTimeout(() => controller.abort(), 150);
    const run = await pending;
    expect(run.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('bounds very large output and keeps it retrievable behind a handle (R7)', async () => {
    const run = await runUserCommand({command: 'seq 1 100000'});
    expect(run.status).toBe('completed');
    expect(run.stdout.truncated || run.stdout.handle !== undefined).toBe(true);
    expect(run.stdout.text.length).toBeLessThan(60_000);
    // The model-facing record names the handle, and the handle serves the untouched output.
    expect(formatUserCommandRecord(run)).toMatch(/full_output_handle: \S+/);
    if (run.stdout.handle) expect(readToolOutput(run.stdout.handle, 0, 5)).toBeDefined();
  }, 20_000);

  it('does not apply file, git-internals or network restrictions', async () => {
    const dir = await tempDir();
    const previousCwd = process.cwd();
    try {
      await fs.writeFile(path.join(dir, '.gitignore'), 'ignored.txt\n');
      await fs.writeFile(path.join(dir, 'ignored.txt'), 'ignored content');
      await fs.mkdir(path.join(dir, '.git'));
      await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      process.chdir(dir);
      const run = await runUserCommand({command: 'cat ignored.txt .git/HEAD; curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9/ || true'});
      expect(run.status).toBe('completed');
      expect(`${run.stdout.text}${run.stderr.text}`).toContain('ignored content');
      expect(`${run.stdout.text}${run.stderr.text}`).toContain('ref: refs/heads/main');
    } finally {
      process.chdir(previousCwd);
      await fs.rm(dir, {recursive: true, force: true});
    }
  }, 20_000);

  it('drops the validation summary a classifier-confirmed command would carry', () => {
    // Evidence is never derived from a user-run command.
    const run = toUserCommandRun({command: 'npm test', code: 0, durationMs: 1, stdout: {text: 'ok'}, stderr: {text: ''}, validationSummary: {kind: 'test', status: 'passed'}});
    expect(run).not.toHaveProperty('validationSummary');
  });
});


describe('toUserCommandRun', () => {
  it('maps the shell tool result and derives the status', () => {
    const stream = (text: string) => ({text, truncated: false, omittedChars: 0});
    expect(toUserCommandRun({command: 'ls', code: 0, durationMs: 7, timedOut: false, aborted: false, stdout: stream('a'), stderr: stream('')})).toEqual({
      command: 'ls', status: 'completed', exitCode: 0, durationMs: 7,
      stdout: {text: 'a', truncated: false, filtered: false, omittedChars: 0},
      stderr: {text: '', truncated: false, filtered: false, omittedChars: 0},
    });
    expect(toUserCommandRun({code: null, timedOut: true, aborted: false, stdout: stream(''), stderr: stream('')}).status).toBe('timed_out');
    expect(toUserCommandRun({code: 2, timedOut: false, aborted: false, stdout: stream(''), stderr: stream('')}).status).toBe('failed');
    expect(toUserCommandRun({code: null, error: 'spawn failed', stdout: stream(''), stderr: stream('')}).status).toBe('error');
  });

  it('turns an unknown shape into an error run', () => {
    expect(toUserCommandRun(undefined)).toMatchObject({status: 'error', exitCode: null});
  });
});
