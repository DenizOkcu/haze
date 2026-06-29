#!/usr/bin/env node
// Build-time codegen: stamp the current short git commit into build-info.json at the
// repo root. Read at runtime by src/cli/index.ts to decorate `--version` for dev/local
// builds (e.g. 0.6.0@e5c03c0). Published releases exclude this file (not in the `files`
// allowlist), so they show the plain version. No git available → commit is null.
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let commit = null;
try {
  const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {encoding: 'utf8', cwd: root}).trim();
  if (out) commit = out;
} catch {
  // Not a git repo or git unavailable — leave commit null (plain version at runtime).
}

writeFileSync(join(root, 'build-info.json'), `${JSON.stringify({commit}, null, 2)}\n`);
console.log(commit ? `build-info: stamped ${commit}` : 'build-info: no git commit (plain version)');
