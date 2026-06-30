import {describe, expect, it} from 'vitest';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(__dirname, '../../.github/scripts/compare-coverage.mjs');
const fixtures = path.resolve(__dirname, '../fixtures/coverage-final');

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {encoding: 'utf8'});
}

describe('compare-coverage.mjs', () => {
  it('exits 0 when reports are identical', () => {
    const result = run(`${fixtures}/base.json`, `${fixtures}/base.json`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No coverage regression. OK.');
  });

  it('exits 1 on statement regression', () => {
    const result = run(`${fixtures}/base.json`, `${fixtures}/head-regression.json`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error::statements decreased');
  });

  it('exits 1 on branch regression', () => {
    const result = run(`${fixtures}/base.json`, `${fixtures}/head-branch-regression.json`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error::branches decreased');
  });

  it('exits 2 when arguments are missing', () => {
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });

  it('exits 2 when a coverage file is missing', () => {
    const result = run(`${fixtures}/base.json`, `${fixtures}/missing.json`);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Failed to read coverage reports');
  });

  it('exits 2 with a clear error for malformed branch data', () => {
    const result = run(`${fixtures}/base.json`, `${fixtures}/malformed-branch.json`);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Expected branch data');
  });
});
