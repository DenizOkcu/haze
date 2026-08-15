#!/usr/bin/env node
// Development runtime activation: build this checkout, link it globally, then
// verify the `haze` command on PATH actually resolves to this checkout's
// freshly built dist (version + commit). Fails loudly when an old global
// install would keep serving requests — the exact failure mode where sessions
// run stale runtime behavior while the fix sits unlinked in the checkout.
//
// Usage: npm run dev:link
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function step(label, command, args, options = {}) {
  process.stdout.write(`dev:link: ${label}\n`);
  const result = spawnSync(command, args, {cwd: repoRoot, stdio: 'inherit', ...options});
  if (result.status !== 0) {
    process.stderr.write(`dev:link: FAILED — \`${command} ${args.join(' ')}\` exited with ${result.status}.\n`);
    process.exit(1);
  }
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repoRoot}).toString().trim();
  } catch {
    return undefined;
  }
}

function resolveHazeOnPath() {
  try {
    return execFileSync('bash', ['-lc', 'command -v haze'], {encoding: 'utf8'}).trim() || undefined;
  } catch {
    return undefined;
  }
}

// 1. Build (clean + tsc + buildInfo manifest) so dist matches this checkout.
step('building the checkout (npm run build)', 'npm', ['run', 'build']);
// 2. Link globally so the `haze` on PATH points at this checkout's bin.
step('linking globally (npm link)', 'npm', ['link']);

// 3. Resolve the haze command actually on PATH.
const hazePath = resolveHazeOnPath();
if (!hazePath) {
  process.stderr.write('dev:link: FAILED — `haze` is not on PATH after npm link; check your global bin directory.\n');
  process.exit(1);
}
let realHaze;
try {
  realHaze = fs.realpathSync(hazePath);
} catch {
  realHaze = hazePath;
}
process.stdout.write(`dev:link: resolved command -v haze -> ${hazePath} -> ${realHaze}\n`);

// 4. Verify the resolved package directory is this checkout.
if (path.resolve(path.dirname(realHaze), '..') !== repoRoot) {
  process.stderr.write(`dev:link: FAILED — the haze on PATH resolves to ${realHaze}, not this checkout's bin (${path.join(repoRoot, 'bin', 'haze.js')}).\n`);
  process.stderr.write('Remove the stale global install (npm rm -g @denizokcu/haze) and re-run npm run dev:link.\n');
  process.exit(1);
}

// 5. Print the loaded version/commit through the real entrypoint users execute.
const verbose = spawnSync(process.execPath, [realHaze, '--version', '--verbose'], {encoding: 'utf8'});
if (verbose.status !== 0) {
  process.stderr.write(`dev:link: FAILED — \`${realHaze} --version --verbose\` exited with ${verbose.status}:\n${verbose.stderr}`);
  process.exit(1);
}
const output = verbose.stdout;
const head = gitHead();
if (!output.includes(pkg.version)) {
  process.stderr.write(`dev:link: FAILED — the linked runtime did not report version ${pkg.version}:\n${output}`);
  process.exit(1);
}
if (head && !output.includes(head)) {
  process.stderr.write(`dev:link: FAILED — the linked runtime was not built from the current commit ${head.slice(0, 7)}:\n${output}`);
  process.exit(1);
}

process.stdout.write('dev:link: verified — the global `haze` now serves this checkout:\n');
process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
process.stdout.write('Note: an already-running haze process keeps its old code; restart it to pick up the new runtime.\n');
