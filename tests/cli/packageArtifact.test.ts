import {describe, expect, it} from 'vitest';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// The published tarball must ship the goal supervisor and the build manifest;
// a packaging gap would otherwise reproduce the "installed runtime lacks the
// fix" failure mode for every user. Skipped when dist has not been built
// (npm pack would list no dist/ entries at all).
describe.skipIf(!fs.existsSync(path.join(repoRoot, 'dist', 'cli', 'commands', 'streaming', 'goalSupervisor.js')))('packaged tarball contents', () => {
  it('includes the goal-supervisor module and build manifest', () => {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {cwd: repoRoot, encoding: 'utf8', timeout: 120_000});
    expect(result.status).toBe(0);
    // npm emits either an array or an object keyed by package name depending on version.
    const parsed: unknown = JSON.parse(result.stdout);
    const entries = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>);
    const files = (entries as Array<{files?: Array<{path?: string}>}>)
      .flatMap(entry => entry.files ?? [])
      .map(file => file.path);
    expect(files).toContain('dist/cli/commands/streaming/goalSupervisor.js');
    expect(files).toContain('dist/buildInfo.json');
    expect(files).toContain('bin/haze.js');
  }, 180_000);
});
