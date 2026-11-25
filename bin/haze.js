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

/** readJson that returns undefined instead of throwing (for the --version path). */
function readJsonSafe(file) {
  try {
    return readJson(file);
  } catch {
    return undefined;
  }
}

/** realpathSync that falls back to the given path, so --verbose never throws (OPS-06). */
function safeRealpath(file) {
  try {
    return realpathSync(file);
  } catch {
    return file ?? 'unknown';
  }
}

function readGitHead() {
  const sha = (value) => (/^[0-9a-f]{7,40}$/i.test((value ?? '').trim()) ? value.trim() : undefined);
  const readOptional = (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  };
  try {
    const dotGit = path.join(root, '.git');
    const stat = statSync(dotGit);
    // `gitdir: <path>` may be relative (resolve against root) and contain
    // spaces; linked worktrees keep refs in the common dir via `commondir`
    // (MR-05). Mirrors src/utils/buildInfo.ts gitHeadCommit by design.
    const gitDir = stat.isDirectory()
      ? dotGit
      : path.resolve(root, (/gitdir:\s*(.+?)\s*$/m.exec(readOptional(dotGit) ?? '') ?? [])[1]);
    if (!gitDir) return undefined;
    const commonDirRaw = /\s*(.+?)\s*$/.exec(readOptional(path.join(gitDir, 'commondir')) ?? '')?.[1];
    const refDirs = commonDirRaw ? [path.resolve(gitDir, commonDirRaw)] : [];
    const head = (readOptional(path.join(gitDir, 'HEAD')) ?? '').trim();
    if (!head.startsWith('ref:')) return sha(head);
    const ref = head.slice(4).trim();
    for (const dir of [gitDir, ...refDirs]) {
      const loose = sha(readOptional(path.join(dir, ref)));
      if (loose) return loose;
      const packed = readOptional(path.join(dir, 'packed-refs'));
      if (packed) {
        const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const packedSha = sha(new RegExp(`^([0-9a-f]{40}) ${escaped}$`, 'm').exec(packed)?.[1]);
        if (packedSha) return packedSha;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const problems = [];
let pkg;
let build;

// Node floor (OPS-06): fail with a clear message instead of a syntax error
// from dist on old runtimes. Checked before anything that could throw.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  process.stderr.write(`haze requires Node >= 22.13 (found ${process.versions.node}).\n`);
  process.exit(1);
}

// `--version` (optionally `--verbose`) is answered before the staleness gate
// (OPS-06): provenance must work even while dist is being repaired.
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-V')) {
  const version = readJsonSafe('package.json')?.version ?? readJsonSafe('dist/buildInfo.json')?.version ?? '0.0.0';
  if (argv.includes('--verbose')) {
    const lines = [
      `Haze ${version}`,
      `commit: ${readJsonSafe('dist/buildInfo.json')?.commit ?? 'unknown'}`,
      ...(readJsonSafe('dist/buildInfo.json')?.builtAt ? [`builtAt: ${readJsonSafe('dist/buildInfo.json').builtAt}`] : []),
      `runtime: ${path.join(root, 'dist')}`,
      `executable: ${safeRealpath(process.argv[1])}`,
      `goal supervisor: ${existsSync(path.join(root, 'dist/cli/commands/streaming/goalSupervisor.js')) ? 'enabled' : 'disabled'}`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  } else {
    process.stdout.write(`${version}\n`);
  }
  process.exit(0);
}
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

import('../dist/cli/index.js');
