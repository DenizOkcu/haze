import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {runDoctor} from '../../../src/cli/commands/doctor.js';

function capture() {
  const lines: string[] = [];
  return {lines, stdout: {write: (line: string) => lines.push(line)}};
}

async function makeRuntime(dir: string, options: {
  version?: string;
  buildVersion?: string;
  buildCommit?: string;
  gitHead?: string;
  omitGoalSupervisor?: boolean;
} = {}) {
  const version = options.version ?? '0.10.1';
  await fs.outputJson(path.join(dir, 'package.json'), {name: '@denizokcu/haze', version});
  await fs.ensureDir(path.join(dir, 'dist', 'cli', 'commands', 'streaming'));
  await fs.outputFile(path.join(dir, 'dist', 'cli', 'index.js'), '// built\n');
  if (!options.omitGoalSupervisor) {
    await fs.outputFile(path.join(dir, 'dist', 'cli', 'commands', 'streaming', 'goalSupervisor.js'), '// built\n');
  }
  if (options.buildVersion !== 'omit') {
    await fs.outputJson(path.join(dir, 'dist', 'buildInfo.json'), {
      name: '@denizokcu/haze',
      version: options.buildVersion ?? version,
      ...(options.buildCommit ? {commit: options.buildCommit} : {}),
      builtAt: '2026-08-13T00:00:00.000Z',
    });
  }
  if (options.gitHead) {
    const gitDir = path.join(dir, '.git');
    await fs.outputFile(path.join(gitDir, 'HEAD'), options.gitHead.startsWith('ref:') ? options.gitHead : `${options.gitHead}\n`);
    if (options.gitHead.startsWith('ref:')) {
      await fs.outputFile(path.join(gitDir, 'refs', 'heads', 'main'), `${'e'.repeat(40)}\n`);
    }
  }
}

describe('haze doctor', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-doctor-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('reports provenance, capabilities, and passing checks for a healthy linked checkout', async () => {
    const root = path.join(tmp, 'healthy');
    const commit = 'a'.repeat(40);
    await makeRuntime(root, {buildCommit: commit, gitHead: commit});
    const {lines, stdout} = capture();
    const code = await runDoctor({stdout, runtimeRoot: root, cwd: path.join(tmp, 'unrelated-workspace')});
    const text = lines.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('Haze 0.10.1');
    expect(text).toContain(`commit: ${commit}`);
    expect(text).toContain(`runtime: ${path.join(root, 'dist')}`);
    expect(text).toContain('logicalGoalSupervisor: enabled');
    expect(text).toContain('automaticBudgetContinuation: enabled');
    expect(text).toContain('[ok] artifact dist/cli/commands/streaming/goalSupervisor.js: present');
    expect(text).toContain('[ok] package/build version');
    expect(text).toContain('[ok] build commit');
    expect(text).toContain('Checkout mismatch: none');
  });

  it('fails with an actionable message when the goal-supervisor artifact is missing', async () => {
    const root = path.join(tmp, 'partial');
    await makeRuntime(root, {omitGoalSupervisor: true});
    const {lines, stdout} = capture();
    const code = await runDoctor({stdout, runtimeRoot: root, cwd: tmp});
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('[FAIL] artifact dist/cli/commands/streaming/goalSupervisor.js: missing');
    expect(text).toContain('logicalGoalSupervisor: disabled');
    expect(text).toContain('goal supervisor is unavailable');
  });

  it('fails when the build manifest version is stale relative to package.json', async () => {
    const root = path.join(tmp, 'stale-version');
    await makeRuntime(root, {version: '0.10.1', buildVersion: '0.10.0'});
    const {lines, stdout} = capture();
    const code = await runDoctor({stdout, runtimeRoot: root, cwd: tmp});
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('package.json 0.10.1 vs dist/buildInfo.json 0.10.0');
  });

  it('fails when the version matches but the build commit is behind HEAD', async () => {
    const root = path.join(tmp, 'stale-commit');
    await makeRuntime(root, {buildCommit: 'b'.repeat(40), gitHead: 'c'.repeat(40)});
    const {lines, stdout} = capture();
    const code = await runDoctor({stdout, runtimeRoot: root, cwd: tmp});
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain(`built from ${'b'.repeat(7)}`);
    expect(text).toContain(`checkout HEAD is ${'c'.repeat(7)}`);
  });

  it('warns (without failing) when a nearby checkout is newer than the executing install', async () => {
    const install = path.join(tmp, 'global');
    const checkout = path.join(tmp, 'checkout');
    await makeRuntime(install, {version: '0.10.0'});
    await makeRuntime(checkout, {version: '0.10.1'});
    const {lines, stdout} = capture();
    const code = await runDoctor({stdout, runtimeRoot: install, cwd: checkout});
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('Checkout mismatch');
    expect(text).toContain('Running Haze 0.10.0');
    expect(text).toContain('npm run dev:link');
  });

  it('classifies an installed package without git metadata as such', async () => {
    const root = path.join(tmp, 'installed');
    await makeRuntime(root);
    const {lines, stdout} = capture();
    const code = await runDoctor({stdout, runtimeRoot: root, cwd: tmp});
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('kind: installed package (no git metadata)');
    expect(text).toContain('[warning] build commit: no git metadata');
  });
});
