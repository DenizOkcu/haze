import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {BACKGROUND_PROCESS_MAX_CONCURRENCY} from '../../../src/core/agent/budgets.js';
import {readToolOutput} from '../../../src/core/agent/toolOutputStore.js';
import {BACKGROUND_PROCESS_OUTPUT_BYTES} from '../../../src/core/limits.js';
import {getBackgroundProcess, killBackgroundProcess, listBackgroundProcesses, resetBackgroundProcessesForTests, startBackgroundProcess} from '../../../src/core/process/backgroundRegistry.js';

const dirs: string[] = [];
afterEach(async () => {
  await resetBackgroundProcessesForTests();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, {recursive: true, force: true})));
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for background process state.');
}

function nodeCommand(script: string) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

describe('background process registry (F09)', () => {
  it('returns immediately and keeps live output available through its handle', async () => {
    const startedAt = Date.now();
    const started = startBackgroundProcess({command: nodeCommand("console.log('ready');setInterval(()=>console.log('tick'),25)"), cwd: process.cwd()});
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(started).toMatchObject({status: 'running', pid: expect.any(Number), outputHandle: expect.stringMatching(/^output-/)});
    await waitFor(() => (getBackgroundProcess(started.backgroundId)?.outputBytes.totalBytes ?? 0) > 5);
    expect(readToolOutput(started.outputHandle)?.content).toContain('ready');
  });

  it('bounds the output ring by bytes and reports oldest-byte omission truthfully', async () => {
    const byteCount = BACKGROUND_PROCESS_OUTPUT_BYTES + 10_000;
    const started = startBackgroundProcess({command: nodeCommand(`process.stdout.write('x'.repeat(${byteCount})+'TAIL');setInterval(()=>{},1000)`), cwd: process.cwd()});
    await waitFor(() => (getBackgroundProcess(started.backgroundId)?.outputBytes.totalBytes ?? 0) >= byteCount, 5_000);
    const summary = getBackgroundProcess(started.backgroundId)!;
    expect(summary.outputBytes.retainedBytes).toBeLessThanOrEqual(BACKGROUND_PROCESS_OUTPUT_BYTES);
    expect(summary.outputBytes.omittedBytes).toBe(summary.outputBytes.totalBytes - summary.outputBytes.retainedBytes);
    const tail = readToolOutput(started.outputHandle, summary.outputBytes.retainedBytes - 20, 20);
    expect(tail?.content).toContain('TAIL');
    expect(tail?.omittedBytes).toBeGreaterThan(0);
  });

  it.runIf(process.platform !== 'win32')('kills the owned process tree', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-background-tree-'));
    dirs.push(dir);
    const pidFile = path.join(dir, 'child.pid');
    const childScript = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    const parentScript = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const started = startBackgroundProcess({command: nodeCommand(parentScript), cwd: dir});
    await waitFor(async () => fs.stat(pidFile).then(() => true).catch(() => false));
    const childPid = Number(await fs.readFile(pidFile, 'utf8'));

    const killed = await killBackgroundProcess(started.backgroundId, 50);
    expect(killed?.status).toBe('killed');
    await waitFor(() => {
      try { process.kill(childPid, 0); return false; } catch { return true; }
    });
  });

  it.runIf(process.platform !== 'win32')('tears down registered trees when the haze process receives SIGTERM', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-background-signal-'));
    dirs.push(dir);
    const pidFile = path.join(dir, 'server.pid');
    const childScript = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    const registryUrl = pathToFileURL(path.resolve('src/core/process/backgroundRegistry.ts')).href;
    const fixture = path.join(dir, 'fixture.mjs');
    await fs.writeFile(fixture, `import {installBackgroundProcessSignalHandlers,startBackgroundProcess} from ${JSON.stringify(registryUrl)};\ninstallBackgroundProcessSignalHandlers();\nstartBackgroundProcess({command:${JSON.stringify(nodeCommand(childScript))},cwd:${JSON.stringify(dir)}});\nconsole.log('READY');\nsetInterval(()=>{},1000);\n`);
    const haze = spawn(process.execPath, ['--import', 'tsx', fixture], {cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    haze.stdout.on('data', chunk => { stdout += String(chunk); });
    try {
      await waitFor(async () => stdout.includes('READY') && await fs.stat(pidFile).then(() => true).catch(() => false), 5_000);
      const serverPid = Number(await fs.readFile(pidFile, 'utf8'));
      haze.kill('SIGTERM');
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        haze.once('error', reject);
        haze.once('exit', resolve);
      });
      expect(exitCode).toBe(143);
      await waitFor(() => {
        try { process.kill(serverPid, 0); return false; } catch { return true; }
      });
    } finally {
      if (haze.exitCode == null) haze.kill('SIGKILL');
    }
  }, 10_000);

  it('rejects admission beyond the named concurrency cap with an actionable error', () => {
    for (let index = 0; index < BACKGROUND_PROCESS_MAX_CONCURRENCY; index++) {
      startBackgroundProcess({command: nodeCommand('setInterval(()=>{},1000)'), cwd: process.cwd()});
    }
    expect(listBackgroundProcesses().filter(process => process.status === 'running')).toHaveLength(BACKGROUND_PROCESS_MAX_CONCURRENCY);
    expect(() => startBackgroundProcess({command: 'sleep 30', cwd: process.cwd()})).toThrow(/limit reached.*Kill an existing process/i);
  });
});

describe('background process registry env sanitizer (HZ-10)', () => {
  afterEach(() => { delete process.env.HAZE_TEST_FAKE_API_KEY; });

  it('omits secret-shaped variables when sanitizeEnv is requested', async () => {
    process.env.HAZE_TEST_FAKE_API_KEY = 'secret-value';
    const started = startBackgroundProcess({command: nodeCommand("console.log(process.env.HAZE_TEST_FAKE_API_KEY ?? 'ABSENT')"), cwd: process.cwd(), sanitizeEnv: {}});
    await waitFor(() => (getBackgroundProcess(started.backgroundId)?.outputBytes.totalBytes ?? 0) > 0);
    expect(readToolOutput(started.outputHandle)?.content).toContain('ABSENT');
    expect(readToolOutput(started.outputHandle)?.content).not.toContain('secret-value');
  });

  it('inherits the parent environment unchanged by default', async () => {
    process.env.HAZE_TEST_FAKE_API_KEY = 'secret-value';
    const started = startBackgroundProcess({command: nodeCommand("console.log(process.env.HAZE_TEST_FAKE_API_KEY ?? 'ABSENT')"), cwd: process.cwd()});
    await waitFor(() => (getBackgroundProcess(started.backgroundId)?.outputBytes.totalBytes ?? 0) > 0);
    expect(readToolOutput(started.outputHandle)?.content).toContain('secret-value');
  });
});

describe('background process teardown escape reporting (HZ-11)', () => {
  it.runIf(process.platform !== 'win32')('records an advisory note when a descendant escapes the process group', async () => {
    // The grandchild detaches into its own session and inherits stdout, so the
    // registry's SIGKILL to the parent's group cannot reach it and no close
    // event ever fires — exactly the setsid/daemonize escape the note reports.
    const escapedScript = 'setInterval(()=>{},5000)';
    const parentScript = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(escapedScript)}],{detached:true,stdio:['ignore',1,2]});child.unref();process.stdout.write(String(child.pid));setInterval(()=>{},1000)`;
    const started = startBackgroundProcess({command: nodeCommand(parentScript), cwd: process.cwd()});
    await waitFor(() => (getBackgroundProcess(started.backgroundId)?.outputBytes.totalBytes ?? 0) > 0, 3_000);
    const escapedPid = Number(readToolOutput(started.outputHandle)?.content.trim());
    try {
      const killed = await killBackgroundProcess(started.backgroundId, 30);
      expect(killed?.status).toBe('killed');
      expect(killed?.teardownNote).toMatch(/not be fully reaped/i);
    } finally {
      if (Number.isInteger(escapedPid) && escapedPid > 0) {
        try { process.kill(escapedPid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  it('leaves the teardown note absent for a fully reaped tree', async () => {
    const started = startBackgroundProcess({command: nodeCommand('setInterval(()=>{},1000)'), cwd: process.cwd()});
    await waitFor(() => getBackgroundProcess(started.backgroundId)?.status === 'running');
    const killed = await killBackgroundProcess(started.backgroundId, 2_000);
    expect(killed?.status).toBe('killed');
    expect(killed?.teardownNote).toBeUndefined();
  });
});
