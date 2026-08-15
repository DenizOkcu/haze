import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  detectCheckoutMismatch,
  formatMismatchWarning,
  formatVersionVerbose,
  gitHeadCommit,
  goalSupervisorArtifactPresent,
  loadBuildInfoFrom,
  parseBuildInfo,
  readPackageVersionAt,
  readBuildInfo,
  resetBuildInfoCache,
  resolvePackageRoot,
  runtimeCapabilities,
} from '../../src/utils/buildInfo.js';

const HAZE_PKG = {name: '@denizokcu/haze', version: '0.10.0'};

describe('buildInfo', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-buildinfo-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  describe('parseBuildInfo / loadBuildInfoFrom', () => {
    it('parses a well-formed manifest and keeps only safe metadata', () => {
      const info = parseBuildInfo({name: '@denizokcu/haze', version: '0.10.1', commit: 'c'.repeat(40), builtAt: '2026-08-13T00:00:00.000Z', sourceRoot: '/repo'});
      expect(info).toEqual({name: '@denizokcu/haze', version: '0.10.1', commit: 'c'.repeat(40), builtAt: '2026-08-13T00:00:00.000Z', sourceRoot: '/repo'});
    });

    it('rejects malformed manifests (missing name/version, non-objects)', () => {
      expect(parseBuildInfo(undefined)).toBeUndefined();
      expect(parseBuildInfo({version: '1.0.0'})).toBeUndefined();
      expect(parseBuildInfo({name: 'x'})).toBeUndefined();
      expect(parseBuildInfo({name: 'x', version: 3})).toBeUndefined();
      expect(parseBuildInfo([1, 2])).toBeUndefined();
    });

    it('loads the first parsable candidate and skips unreadable paths', async () => {
      const missing = path.join(tmp, 'missing', 'buildInfo.json');
      const present = path.join(tmp, 'dist', 'buildInfo.json');
      await fs.outputJson(present, {name: '@denizokcu/haze', version: '0.10.1', commit: 'a'.repeat(40)});
      expect(loadBuildInfoFrom([missing, present])).toMatchObject({version: '0.10.1', commit: 'a'.repeat(40)});
      expect(loadBuildInfoFrom([missing])).toBeUndefined();
    });
  });

  describe('readBuildInfo default path', () => {
    // Regression for the inverted cache sentinel: `readBuildInfo()` previously
    // returned before ever reading the manifest, so `--version --verbose`
    // printed `commit: unknown` and session headers never recorded provenance.
    const srcFixture = fileURLToPath(new URL('../../src/buildInfo.json', import.meta.url));

    afterEach(async () => {
      await fs.remove(srcFixture);
      resetBuildInfoCache();
    });

    it('reads the module-relative manifest on the first default call', async () => {
      resetBuildInfoCache();
      const manifest = {name: '@denizokcu/haze', version: '9.9.9', commit: 'd'.repeat(40)};
      await fs.outputJson(srcFixture, manifest);
      expect(readBuildInfo()).toEqual(manifest);
      // The hit is cached: a second default call returns the same value.
      expect(readBuildInfo()).toEqual(manifest);
    });

    it('serves repeated default calls from the cache (hit or miss)', async () => {
      // Candidate 2 (<repo>/dist/buildInfo.json) exists after `npm run build`, so
      // an absent src fixture may still resolve — both outcomes must be stable.
      resetBuildInfoCache();
      await fs.remove(srcFixture);
      const fallback = loadBuildInfoFrom([path.join(path.dirname(srcFixture), '..', 'dist', 'buildInfo.json')]);
      expect(readBuildInfo()).toEqual(fallback);
      expect(readBuildInfo()).toEqual(fallback);
    });
  });

  describe('resolvePackageRoot', () => {
    it('walks up to the nearest package.json from a nested directory', async () => {
      const nested = path.join(tmp, 'pkg', 'dist', 'cli', 'utils');
      await fs.outputJson(path.join(tmp, 'pkg', 'package.json'), HAZE_PKG);
      await fs.ensureDir(nested);
      expect(resolvePackageRoot(nested)).toBe(path.join(tmp, 'pkg'));
    });

    it('returns undefined above the filesystem root without a package.json', () => {
      expect(resolvePackageRoot(tmp)).toBeUndefined();
    });
  });

  describe('gitHeadCommit', () => {
    it('reads a detached HEAD sha directly', async () => {
      const root = path.join(tmp, 'repo');
      await fs.outputFile(path.join(root, '.git', 'HEAD'), `${'a'.repeat(40)}\n`);
      expect(gitHeadCommit(root)).toBe('a'.repeat(40));
    });

    it('resolves a symbolic ref through refs/heads', async () => {
      const root = path.join(tmp, 'repo');
      await fs.outputFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await fs.outputFile(path.join(root, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`);
      expect(gitHeadCommit(root)).toBe('b'.repeat(40));
    });

    it('resolves a symbolic ref through packed-refs when the loose ref is absent', async () => {
      const root = path.join(tmp, 'repo');
      await fs.outputFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await fs.outputFile(path.join(root, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled\n${'c'.repeat(40)} refs/heads/main\n`);
      expect(gitHeadCommit(root)).toBe('c'.repeat(40));
    });

    it('returns undefined outside a git checkout or for garbage input', async () => {
      expect(gitHeadCommit(tmp)).toBeUndefined();
      const root = path.join(tmp, 'repo2');
      await fs.outputFile(path.join(root, '.git', 'HEAD'), 'not a ref or sha\n');
      expect(gitHeadCommit(root)).toBeUndefined();
    });
  });

  describe('runtimeCapabilities', () => {
    it('reports the supervisor capability set when the compiled artifact exists', async () => {
      const root = path.join(tmp, 'linked');
      await fs.outputJson(path.join(root, 'package.json'), HAZE_PKG);
      await fs.ensureDir(path.join(root, 'dist', 'cli', 'commands', 'streaming'));
      await fs.outputFile(path.join(root, 'dist', 'cli', 'commands', 'streaming', 'goalSupervisor.js'), '// built\n');
      expect(runtimeCapabilities(root)).toEqual({logicalGoalSupervisor: true, crossTurnCheckpoints: true, automaticBudgetContinuation: true});
      expect(goalSupervisorArtifactPresent(root)).toBe(true);
    });

    it('reports every supervisor capability as unavailable when the artifact is missing (the 0.10.0 global install)', async () => {
      const root = path.join(tmp, 'global-old');
      await fs.outputJson(path.join(root, 'package.json'), HAZE_PKG);
      await fs.ensureDir(path.join(root, 'dist', 'cli', 'commands', 'streaming'));
      expect(runtimeCapabilities(root)).toEqual({logicalGoalSupervisor: false, crossTurnCheckpoints: false, automaticBudgetContinuation: false});
    });
  });

  describe('detectCheckoutMismatch', () => {
    async function makeInstall(dir: string, version: string, options: {goalSupervisor?: boolean; buildCommit?: string} = {}) {
      await fs.outputJson(path.join(dir, 'package.json'), {...HAZE_PKG, version});
      await fs.ensureDir(path.join(dir, 'dist', 'cli', 'commands', 'streaming'));
      if (options.goalSupervisor !== false) {
        await fs.outputFile(path.join(dir, 'dist', 'cli', 'commands', 'streaming', 'goalSupervisor.js'), '// built\n');
      }
      if (options.buildCommit) {
        await fs.outputJson(path.join(dir, 'dist', 'buildInfo.json'), {name: '@denizokcu/haze', version, commit: options.buildCommit});
      }
    }

    it('reports a global 0.10.0 install running beside a 0.10.1 checkout', async () => {
      const install = path.join(tmp, 'global-install');
      const checkout = path.join(tmp, 'checkout');
      const workspace = path.join(checkout, 'workspaces', 'app');
      await makeInstall(install, '0.10.0');
      await makeInstall(checkout, '0.10.1');
      await fs.ensureDir(workspace);
      const mismatch = detectCheckoutMismatch({executingRoot: install, cwd: workspace});
      expect(mismatch).toMatchObject({executingVersion: '0.10.0', checkoutVersion: '0.10.1', checkoutNewer: true});
      const warning = formatMismatchWarning(mismatch!);
      expect(warning).toContain('Running Haze 0.10.0');
      expect(warning).toContain('0.10.1');
      expect(warning).toContain('npm run dev:link');
    });

    it('reports a same-version checkout whose build commit moved ahead', async () => {
      const install = path.join(tmp, 'install-commit');
      const checkout = path.join(tmp, 'checkout-commit');
      await makeInstall(install, '0.10.1', {buildCommit: 'a'.repeat(40)});
      await makeInstall(checkout, '0.10.1', {buildCommit: 'b'.repeat(40)});
      const mismatch = detectCheckoutMismatch({executingRoot: install, cwd: checkout});
      expect(mismatch?.versionDiffers).toBe(false);
      expect(mismatch).toMatchObject({executingCommit: 'a'.repeat(40), checkoutCommit: 'b'.repeat(40)});
      expect(formatMismatchWarning(mismatch!)).toContain('commit');
    });

    it('stays silent when the executing runtime IS the checkout (linked dev setup)', async () => {
      const checkout = path.join(tmp, 'linked-checkout');
      await makeInstall(checkout, '0.10.1');
      expect(detectCheckoutMismatch({executingRoot: checkout, cwd: path.join(checkout, 'subdir-that-does-not-exist-yet')})).toBeUndefined();
    });

    it('stays silent when versions and commits agree across distinct roots', async () => {
      const install = path.join(tmp, 'install-same');
      const checkout = path.join(tmp, 'checkout-same');
      await makeInstall(install, '0.10.1', {buildCommit: 'a'.repeat(40)});
      await makeInstall(checkout, '0.10.1', {buildCommit: 'a'.repeat(40)});
      expect(detectCheckoutMismatch({executingRoot: install, cwd: checkout})).toBeUndefined();
    });

    it('ignores unrelated package.json directories above the workspace', async () => {
      const install = path.join(tmp, 'other-install');
      const workspace = path.join(tmp, 'monorepo', 'app');
      await makeInstall(install, '0.10.0');
      await fs.outputJson(path.join(tmp, 'monorepo', 'package.json'), {name: 'not-haze', version: '9.9.9'});
      await fs.ensureDir(workspace);
      expect(detectCheckoutMismatch({executingRoot: install, cwd: workspace})).toBeUndefined();
    });
  });

  describe('formatVersionVerbose', () => {
    it('prints version, commit, runtime and executable paths, and supervisor state', () => {
      const text = formatVersionVerbose({
        version: '0.10.1',
        build: {name: '@denizokcu/haze', version: '0.10.1', commit: 'd'.repeat(40)},
        runtimeRoot: '/opt/haze',
        executable: '/opt/haze/bin/haze.js',
        capabilities: {logicalGoalSupervisor: true, crossTurnCheckpoints: true, automaticBudgetContinuation: true},
      });
      expect(text).toContain('Haze 0.10.1');
      expect(text).toContain(`commit: ${'d'.repeat(40)}`);
      expect(text).toContain('runtime: /opt/haze/dist');
      expect(text).toContain('executable: /opt/haze/bin/haze.js');
      expect(text).toContain('goal supervisor: enabled');
    });

    it('degrades gracefully when provenance is missing', () => {
      const text = formatVersionVerbose({
        version: '0.10.1',
        capabilities: {logicalGoalSupervisor: false, crossTurnCheckpoints: false, automaticBudgetContinuation: false},
      });
      expect(text).toContain('Haze 0.10.1');
      expect(text).toContain('commit: unknown');
      expect(text).toContain('goal supervisor: disabled');
    });
  });

  it('readPackageVersionAt reads a package.json version or undefined', async () => {
    const root = path.join(tmp, 'pkg');
    await fs.outputJson(path.join(root, 'package.json'), HAZE_PKG);
    expect(readPackageVersionAt(root)).toBe('0.10.0');
    expect(readPackageVersionAt(path.join(tmp, 'nowhere'))).toBeUndefined();
  });
});
