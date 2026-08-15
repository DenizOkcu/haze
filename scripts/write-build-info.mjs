#!/usr/bin/env node
// Writes dist/buildInfo.json after a successful tsc build so every runtime can
// prove which commit/version produced the compiled output it is executing.
// Provenance is safe metadata only: no environment, credentials, or prompts.
//
// Usage: node scripts/write-build-info.mjs   (wired into `npm run build`)
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore']}).toString().trim() || undefined;
  } catch {
    return undefined; // Not a git checkout (e.g. building from a tarball); provenance degrades to version-only.
  }
}

const distDir = path.join(repoRoot, 'dist');
if (!fs.existsSync(distDir)) {
  console.error('write-build-info: dist/ is missing; run tsc first (npm run build).');
  process.exit(1);
}

const buildInfo = {
  name: pkg.name,
  version: pkg.version,
  ...(gitCommit() ? {commit: gitCommit()} : {}),
  builtAt: new Date().toISOString(),
  sourceRoot: repoRoot,
};

fs.writeFileSync(path.join(distDir, 'buildInfo.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);
console.log(`write-build-info: dist/buildInfo.json ${buildInfo.version}${buildInfo.commit ? ` @ ${buildInfo.commit.slice(0, 7)}` : ''}`);
