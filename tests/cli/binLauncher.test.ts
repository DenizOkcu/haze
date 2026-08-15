import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const launcherSource = await fs.readFile(path.join(repoRoot, 'bin', 'haze.js'), 'utf8');

function runLauncher(bin: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{code: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {cwd: path.dirname(bin), env: {...process.env, NO_COLOR: '1', ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

interface TempPackageOptions {
  packageVersion?: string;
  buildVersion?: string | false;
  buildCommit?: string;
  gitHead?: string;
  omit?: string[];
}

async function makeTempPackage(options: TempPackageOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-launcher-'));
  await fs.ensureDir(path.join(root, 'bin'));
  await fs.ensureDir(path.join(root, 'dist', 'cli', 'commands', 'streaming'));
  await fs.outputJson(path.join(root, 'package.json'), {name: '@denizokcu/haze', version: options.packageVersion ?? '0.10.1'});
  await fs.writeFile(path.join(root, 'bin', 'haze.js'), launcherSource);
  await fs.writeFile(path.join(root, 'dist', 'cli', 'index.js'), "console.log('stub-cli-loaded');\n");
  const omit = new Set(options.omit ?? []);
  if (!omit.has('goalSupervisor')) {
    await fs.writeFile(path.join(root, 'dist', 'cli', 'commands', 'streaming', 'goalSupervisor.js'), '// built\n');
  }
  if (options.buildVersion !== false) {
    await fs.outputJson(path.join(root, 'dist', 'buildInfo.json'), {
      name: '@denizokcu/haze',
      version: options.buildVersion ?? options.packageVersion ?? '0.10.1',
      ...(options.buildCommit ? {commit: options.buildCommit} : {}),
      builtAt: '2026-08-13T00:00:00.000Z',
    });
  }
  if (options.gitHead) {
    await fs.outputFile(path.join(root, '.git', 'HEAD'), `${options.gitHead}\n`);
  }
  return root;
}

describe('bin/haze.js verifying launcher', () => {
  let roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => fs.remove(root).catch(() => undefined)));
  });

  async function tempPackage(options: TempPackageOptions = {}) {
    const root = await makeTempPackage(options);
    roots.push(root);
    return root;
  }

  it('refuses to start when the goal-supervisor build artifact is missing', async () => {
    const root = await tempPackage({omit: ['goalSupervisor']});
    const result = await runLauncher(path.join(root, 'bin', 'haze.js'), ['--version']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('refusing to start an incomplete or stale build');
    expect(result.stderr).toContain('dist/cli/commands/streaming/goalSupervisor.js is missing');
    expect(result.stderr).toContain('npm run build');
  });

  it('refuses to start when the build manifest version does not match package.json', async () => {
    const root = await tempPackage({packageVersion: '0.10.1', buildVersion: '0.10.0'});
    const result = await runLauncher(path.join(root, 'bin', 'haze.js'), ['--version']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('dist/buildInfo.json says 0.10.0, but package.json is 0.10.1');
    expect(result.stderr).toContain('stale');
  });

  it('refuses to start when the version matches but the build commit is behind HEAD', async () => {
    const root = await tempPackage({buildCommit: 'a'.repeat(40), gitHead: 'b'.repeat(40)});
    const result = await runLauncher(path.join(root, 'bin', 'haze.js'), ['--version']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`built from commit ${'a'.repeat(7)}`);
    expect(result.stderr).toContain(`checkout is at ${'b'.repeat(7)}`);
  });

  it('refuses to start when dist is entirely missing', async () => {
    const root = await tempPackage({buildVersion: false, omit: ['goalSupervisor']});
    await fs.remove(path.join(root, 'dist'));
    const result = await runLauncher(path.join(root, 'bin', 'haze.js'), ['--version']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('dist/cli/index.js is missing');
  });

  it('answers --version directly and --version --verbose with full provenance on a healthy build', async () => {
    const root = await tempPackage({buildCommit: 'c'.repeat(40)});
    // Node resolves the module through its real path (e.g. /var -> /private/var on macOS).
    const realRoot = fs.realpathSync(root);
    const plain = await runLauncher(path.join(root, 'bin', 'haze.js'), ['--version']);
    expect(plain.code).toBe(0);
    expect(plain.stdout.trim()).toBe('0.10.1');
    const verbose = await runLauncher(path.join(root, 'bin', 'haze.js'), ['--version', '--verbose']);
    expect(verbose.code).toBe(0);
    expect(verbose.stdout).toContain('Haze 0.10.1');
    expect(verbose.stdout).toContain(`commit: ${'c'.repeat(40)}`);
    expect(verbose.stdout).toContain(`runtime: ${path.join(realRoot, 'dist')}`);
    expect(verbose.stdout).toContain(`executable: ${path.join(realRoot, 'bin', 'haze.js')}`);
    expect(verbose.stdout).toContain('goal supervisor: enabled');
  });

  it('verifies then hands off to dist/cli/index.js for normal commands', async () => {
    const root = await tempPackage();
    const result = await runLauncher(path.join(root, 'bin', 'haze.js'), ['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('stub-cli-loaded');
  });

  // The real checkout variant: proves the repo's own bin+dist report the exact
  // build the packaged tarball ships. Skipped when dist has not been built yet
  // (unit CI) so it never masks launcher regressions behind a build dependency.
  describe.skipIf(!((): boolean => {
    try {
      const build = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dist', 'buildInfo.json'), 'utf8')) as {version?: string};
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {version?: string};
      return fs.existsSync(path.join(repoRoot, 'dist', 'cli', 'index.js')) && build.version === pkg.version;
    } catch {
      return false;
    }
  })())('real checkout (requires npm run build)', () => {
    it('reports the built version and commit through the real launcher', async () => {
      const result = await runLauncher(path.join(repoRoot, 'bin', 'haze.js'), ['--version', '--verbose']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Haze ${JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version}`);
      expect(result.stdout).toContain(`runtime: ${path.join(repoRoot, 'dist')}`);
      expect(result.stdout).toContain('goal supervisor: enabled');
    });
  });
});
