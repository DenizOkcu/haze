import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {detectSandboxBackend} from '../../../src/core/sandbox/detect.js';
import {buildSandboxBoundary, defaultSandboxRuntimeFacts} from '../../../src/core/sandbox/boundary.js';
import {wrapInvocation, resolveSandboxRuntime} from '../../../src/core/sandbox/runner.js';
import {runBoundedProcess} from '../../../src/core/process/runBoundedProcess.js';
import {shellInvocation} from '../../../src/core/process/userShell.js';

/**
 * Live OS-sandbox matrix (specs/os-sandbox plan §9). Opt-in via
 * HAZE_SANDBOX_E2E=1 AND a probe-detected backend; otherwise the whole suite
 * skips. macOS exercises seatbelt; Linux with bwrap exercises bubblewrap.
 *
 * Hermetic layout: one temp base under the REAL home (the workspace must not
 * sit inside os.tmpdir(), which is itself an rw root and would absorb the
 * outside-boundary assertions). The child's HOME env stays the real home, so
 * all assertions use absolute paths — `~` would resolve outside the boundary.
 * Credential assertions check emptiness/denial, never real secret contents.
 */

const enabled = process.env.HAZE_SANDBOX_E2E === '1';
const backendInfo = enabled ? await detectSandboxBackend({probeTimeoutMs: 10_000}) : undefined;
const live = enabled && backendInfo?.backend !== 'none';
const skipReason = !enabled ? 'set HAZE_SANDBOX_E2E=1 to run live sandbox tests' : `no sandbox backend on this machine (${backendInfo?.reason ?? 'probe failed'})`;

let baseDir = '';
let workspace = '';
let fakeHome = '';
let outsideDir = '';
let runtime: Awaited<ReturnType<typeof resolveSandboxRuntime>> | undefined;

function sandboxFacts() {
  return {...defaultSandboxRuntimeFacts(), homedir: fakeHome, hazeDir: path.join(fakeHome, '.haze'), claudeDir: path.join(fakeHome, '.claude')};
}

beforeAll(async () => {
  if (!live) return;
  baseDir = await fs.mkdtemp(path.join(os.homedir(), '.haze-sandbox-e2e-'));
  workspace = path.join(baseDir, 'ws');
  fakeHome = path.join(baseDir, 'home');
  outsideDir = path.join(baseDir, 'outside');
  await fs.mkdir(workspace, {recursive: true});
  await fs.mkdir(path.join(fakeHome, '.haze'), {recursive: true});
  await fs.mkdir(path.join(fakeHome, '.claude'), {recursive: true});
  await fs.mkdir(outsideDir, {recursive: true});
  await fs.writeFile(path.join(fakeHome, '.haze', 'settings.json'), 'FAKE-KEY-MATERIAL', 'utf8');
  await fs.writeFile(path.join(fakeHome, '.haze', 'AGENTS.md'), 'global guidance', 'utf8');
  runtime = await resolveSandboxRuntime({workspaceRoot: workspace, backendInfo: backendInfo!, runtime: sandboxFacts()});
});

afterAll(async () => {
  if (baseDir) await fs.rm(baseDir, {recursive: true, force: true});
});

async function run(command: string, state = runtime): Promise<{code: number | null; stdout: string; stderr: string}> {
  if (!state) throw new Error('sandbox runtime unavailable');
  const wrapped = wrapInvocation(shellInvocation(command), state);
  if ('unavailable' in wrapped) throw new Error(wrapped.error);
  const result = await runBoundedProcess({...wrapped.invocation, cwd: workspace, timeoutMs: 30_000, maxStdoutBytes: 4_096, maxStderrBytes: 4_096});
  return {code: result.code, stdout: result.stdout.text, stderr: result.stderr.text};
}

describe.skipIf(!live)('sandbox e2e (live backend)', () => {
  it('workspace write/read works', async () => {
    const result = await run('echo probe > e2e.txt && cat e2e.txt');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('probe');
  });

  it('write outside the boundary is denied', async () => {
    const result = await run(`echo x > ${JSON.stringify(path.join(outsideDir, 'blocked.txt'))}`);
    expect(result.code).not.toBe(0);
  });

  it('real home secrets are unreadable/absent', async () => {
    const result = await run(`ls ${JSON.stringify(path.join(os.homedir(), '.ssh'))} 2>&1; echo "exit=$?"`);
    expect(result.stdout).not.toMatch(/id_rsa|id_ed25519/);
  });

  it('masked config credentials never leak (empty or denied)', async () => {
    const result = await run(`cat ${JSON.stringify(path.join(fakeHome, '.haze', 'settings.json'))} 2>&1 || true`);
    expect(result.stdout).not.toContain('FAKE-KEY-MATERIAL');
  });

  it('config guidance stays readable', async () => {
    const result = await run(`cat ${JSON.stringify(path.join(fakeHome, '.haze', 'AGENTS.md'))}`);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('global guidance');
  });

  it('sibling directory outside the boundary is denied/absent', async () => {
    const marker = path.join(outsideDir, 'marker.txt');
    await fs.writeFile(marker, 'sibling', 'utf8');
    const result = await run(`cat ${JSON.stringify(marker)}`);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('sibling');
  });

  it('blessed paths become read-only roots for the turn', async () => {
    const blessed = path.join(baseDir, 'blessed-dir');
    await fs.mkdir(blessed, {recursive: true});
    await fs.writeFile(path.join(blessed, 'note.txt'), 'blessed', 'utf8');
    const blessedRuntime = await resolveSandboxRuntime({workspaceRoot: workspace, backendInfo: backendInfo!, blessedPaths: [{realPath: blessed, isDirectory: true}], runtime: sandboxFacts()});
    const read = await run(`cat ${JSON.stringify(path.join(blessed, 'note.txt'))}`, blessedRuntime);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain('blessed');
    const write = await run(`touch ${JSON.stringify(path.join(blessed, 'new.txt'))}`, blessedRuntime);
    expect(write.code).not.toBe(0);
  });

  it('/add-dir session dirs become read-write roots (attemptSetup wiring shape)', async () => {
    const added = path.join(baseDir, 'added-dir');
    await fs.mkdir(added, {recursive: true});
    // attemptSetup passes session dirs as rwRoots (same trust level as settings grants).
    const addedRuntime = await resolveSandboxRuntime({
      workspaceRoot: workspace,
      backendInfo: backendInfo!,
      settings: {rwRoots: [added]},
      runtime: sandboxFacts(),
    });
    const write = await run(`echo ok > ${JSON.stringify(path.join(added, 'probe.txt'))} && cat ${JSON.stringify(path.join(added, 'probe.txt'))}`, addedRuntime);
    expect(write.code).toBe(0);
    expect(write.stdout).toContain('ok');
  });

  it('workspace symlink escape is refused', async () => {
    await fs.symlink(path.join(os.homedir(), '.ssh'), path.join(workspace, 'link-ssh'));
    const result = await run('cat link-ssh/id_rsa 2>&1 || cat link-ssh 2>&1 || true');
    expect(result.stdout).not.toContain('PRIVATE KEY');
  });

  it('network: workspace profile can reach a local server', async () => {
    if (runtime?.boundary?.network !== 'allow') return;
    const {createServer} = await import('node:http');
    const server = createServer((request, response) => response.end('pong'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as {port: number}).port;
    try {
      const result = await run(`curl -s http://127.0.0.1:${port}/ 2>&1 || echo net-unavailable`);
      expect(result.stdout).toContain('pong');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('boundary covers the workspace canonically', async () => {
    const boundary = await buildSandboxBoundary({workspaceRoot: workspace, runtime: sandboxFacts()});
    const realWorkspace = await fs.realpath(workspace);
    expect(boundary.workspaceRoot).toBe(realWorkspace);
    expect(boundary.roots.some(root => root.realPath === realWorkspace && root.access === 'rw')).toBe(true);
    expect(boundary.roots.some(root => root.access === 'ro' && root.origin === 'blessed')).toBe(false);
  });
});

describe.skipIf(live)('sandbox e2e skipped', () => {
  it('documents why live tests are skipped', () => {
    expect(skipReason).toBeTruthy();
  });
});
