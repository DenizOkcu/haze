import {afterAll, describe, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {STDIN_PROMPT_BYTES} from '../../src/core/limits.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

interface CliResult {code: number | null; stdout: string; stderr: string}

// Every spawned CLI runs with an empty home unless a test opts out, so it can
// never reach the real ~/.haze settings, credentials or sessions.
let isolatedHome: string | undefined;
function emptyHome(): string {
  isolatedHome ??= fs.mkdtempSync(path.join(os.tmpdir(), 'haze-cli-home-'));
  return isolatedHome;
}
afterAll(() => {
  if (isolatedHome) fs.rmSync(isolatedHome, {recursive: true, force: true});
});

function runCli(args: string[], input = '', options: {realHome?: boolean} = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const home = options.realHome ? {} : {HOME: emptyHome(), USERPROFILE: emptyHome()};
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: repoRoot,
      env: {...process.env, NO_COLOR: '1', ...home},
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

describe('CLI print mode (UX-23)', () => {
  it('accepts --print as an alias of --prompt', async () => {
    const alias = await runCli(['--print', 'list the top 3 bugs']);
    const prompt = await runCli(['-p', 'list the top 3 bugs']);
    // No provider is configured in the isolated home, so both runs stop at the same check.
    expect(alias.stderr).not.toContain("unknown option '--print'");
    expect(alias.stderr).toBe(prompt.stderr);
    expect(alias.stderr).toContain('No model provider configured');
    expect(alias.code).toBe(1);
  }, 30_000);

  it('warns on stderr when --continue is combined with print mode', async () => {
    const warned = await runCli(['-c', '-p', 'list the top 3 bugs']);
    expect(warned.stderr).toContain('--continue is ignored in print mode');
    const plain = await runCli(['-p', 'list the top 3 bugs']);
    expect(plain.stderr).not.toContain('--continue is ignored in print mode');
  }, 30_000);
});
