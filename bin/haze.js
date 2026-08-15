#!/usr/bin/env node
// Verifying launcher for the compiled haze CLI.
//
// Before importing dist/, this shim proves the build is complete and current:
//   1. required compiled modules exist (index, goal supervisor, build manifest);
//   2. dist/buildInfo.json version matches package.json;
//   3. when the package root is a git checkout, the build commit matches HEAD.
// A stale or partial build fails with an actionable message instead of running
// partially outdated code. `--version` (optionally `--verbose`) is answered
// here directly so provenance works even while dist is being repaired.
//
// Deliberately dependency-free: only Node builtins, synchronous checks before
// any dynamic import, mirroring src/utils/buildInfo.ts (which serves doctor
// and the interactive UI with the same facts).
import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_ARTIFACTS = [
  'dist/cli/index.js',
  'dist/cli/commands/streaming/goalSupervisor.js',
  'dist/buildInfo.json',
];

function readJson(file) {
  return JSON.parse(readFileSync(path.join(root, file), 'utf8'));
}

function readGitHead() {
  const sha = (value) => (/^[0-9a-f]{7,40}$/i.test((value ?? '').trim()) ? value.trim() : undefined);
  try {
    const dotGit = path.join(root, '.git');
    const stat = statSync(dotGit);
    const gitDir = stat.isDirectory() ? dotGit : /gitdir:\s*(\S+)/.exec(readFileSync(dotGit, 'utf8'))?.[1];
    if (!gitDir) return undefined;
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return sha(head);
    const ref = head.slice(4).trim();
    const refPath = path.join(gitDir, ref);
    if (existsSync(refPath)) return sha(readFileSync(refPath, 'utf8'));
    const packed = readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return sha(new RegExp(`^([0-9a-f]{40}) ${escaped}$`, 'm').exec(packed)?.[1]);
  } catch {
    return undefined;
  }
}

const problems = [];
let pkg;
let build;
try {
  pkg = readJson('package.json');
} catch {
  pkg = undefined;
  problems.push('package.json is missing or unreadable at the installation root.');
}
try {
  build = readJson('dist/buildInfo.json');
} catch {
  build = undefined;
}
for (const artifact of REQUIRED_ARTIFACTS) {
  if (!existsSync(path.join(root, artifact))) {
    problems.push(`${artifact} is missing — the compiled build is incomplete.`);
  }
}
if (pkg?.version && build?.version && build.version !== pkg.version) {
  problems.push(`dist/buildInfo.json says ${build.version}, but package.json is ${pkg.version} — the build output is stale.`);
}
const headCommit = readGitHead();
if (headCommit && build?.commit && build.commit !== headCommit) {
  problems.push(`dist was built from commit ${String(build.commit).slice(0, 7)}, but the checkout is at ${headCommit.slice(0, 7)} — the build output is stale.`);
}

if (problems.length > 0) {
  process.stderr.write('haze: refusing to start an incomplete or stale build.\n');
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.stderr.write('Repair it with `npm run build` inside the haze checkout, then reinstall or `npm link`.\n');
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-V')) {
  const version = pkg?.version ?? build?.version ?? '0.0.0';
  if (argv.includes('--verbose')) {
    const lines = [
      `Haze ${version}`,
      `commit: ${build?.commit ?? 'unknown'}`,
      ...(build?.builtAt ? [`builtAt: ${build.builtAt}`] : []),
      `runtime: ${path.join(root, 'dist')}`,
      `executable: ${realpathSync(process.argv[1])}`,
      `goal supervisor: ${existsSync(path.join(root, 'dist/cli/commands/streaming/goalSupervisor.js')) ? 'enabled' : 'disabled'}`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  } else {
    process.stdout.write(`${version}\n`);
  }
  process.exit(0);
}

import('../dist/cli/index.js');
