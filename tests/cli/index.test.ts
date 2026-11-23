import {describe, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {STDIN_PROMPT_BYTES} from '../../src/core/limits.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

interface CliResult {code: number | null; stdout: string; stderr: string}

function runCli(args: string[], input = ''): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: repoRoot,
      env: {...process.env, NO_COLOR: '1'},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

describe('CLI stdin prompt', () => {
  it('rejects oversized piped prompts with an actionable error', async () => {
    const result = await runCli([], 'x'.repeat(STDIN_PROMPT_BYTES + 1));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`stdin prompt exceeds ${STDIN_PROMPT_BYTES} bytes`);
    expect(result.stderr).toContain('pass a file path and ask haze to read it instead');
  }, 15_000);
});

describe('CLI help text', () => {
  it('explains that off means none while unset sends no parameter for --reasoning (UX-09)', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--reasoning <level>');
    expect(result.stdout).toContain('off = none');
    expect(result.stdout).toContain('unset sends no reasoning parameter');
  }, 15_000);
});
