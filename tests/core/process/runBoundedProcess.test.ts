import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runBoundedProcess, sanitizeChildEnv, signalProcessTree} from '../../../src/core/process/runBoundedProcess.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, {recursive: true, force: true}))); });

describe('signalProcessTree', () => {
  it('uses taskkill tree semantics for graceful and forced Windows termination', () => {
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({unref})) as unknown as typeof import('node:child_process').spawn;
    const child = {pid: 42, kill: vi.fn()};

    signalProcessTree(child, 'SIGTERM', {platform: 'win32', spawnProcess});
    expect(spawnProcess).toHaveBeenNthCalledWith(1, 'taskkill', ['/pid', '42', '/T'], {stdio: 'ignore'});
    signalProcessTree(child, 'SIGKILL', {platform: 'win32', spawnProcess});
    expect(spawnProcess).toHaveBeenNthCalledWith(2, 'taskkill', ['/pid', '42', '/T', '/F'], {stdio: 'ignore'});
    expect(unref).toHaveBeenCalledTimes(2);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== 'win32')('falls back to child.kill when the POSIX group signal fails', () => {
    const kill = vi.fn();
    // Use a pid that does not exist as a process group; process.kill(-pid) will throw.
    const fakeChild = {pid: 2147483647, kill} as unknown as import('node:child_process').ChildProcess;
    signalProcessTree(fakeChild, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('sanitizeChildEnv (HZ-10)', () => {
  it('omits secret-shaped keys in any case while keeping essential variables', () => {
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/u',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      TZ: 'Europe/Berlin',
      COLORTERM: 'truecolor',
      npm_node_execpath: '/usr/local/bin/node',
      GITHUB_TOKEN: 't1',
      OPENAI_API_KEY: 'k1',
      DATABASE_PASSWORD: 'p1',
      AWS_SECRET_ACCESS_KEY: 's1',
      SERVICE_CREDENTIAL: 'c1',
    };
    const child = sanitizeChildEnv(env);
    expect(Object.keys(child).sort()).toEqual(['COLORTERM', 'HOME', 'LANG', 'PATH', 'TZ', 'TERM', 'npm_node_execpath'].sort());
  });

  it('omits keys matching configured extra substrings (case-insensitive) and ignores blank entries', () => {
    const env = {PATH: '/bin', MYAPP_COOKIE: 'z', OTHER_VAR: 'v'};
    const child = sanitizeChildEnv(env, {extra: ['  myapp_cookie  ', '']});
    expect(child).toEqual({PATH: '/bin', OTHER_VAR: 'v'});
  });

  it('omits values with embedded URL credentials or a token shape, whatever the key is called (SEC-02)', () => {
    // Values split across concatenation so scanners don't flag test fixtures.
    const child = sanitizeChildEnv({
      PATH: '/usr/bin:/bin',
      DATABASE_URL: 'postgres://app:s3cret-' + 'Passw0rd@db.example.com:5432/app',
      QUEUE_DSN: 'amqp://guest:gu' + 'est-R4bb1t@mq.internal:5672//',
      REDIS_URL: 'redis://:r3dis-' + 'Passw0rd@cache.internal:6379/0',
      AUTH_HEADER: 'Bearer Qm9ndXNTb3Bh' + 'cXVlVG9rZW4xMjM0NTY',
      NPM_VALUE: 'npm_a1b2c3d4e5f60718' + '293a4b5c6d7e8f9a0123',
      // No credentials: ordinary URLs and DSNs stay available to the child.
      SITE_URL: 'https://example.com/path',
      PUBLIC_DSN: 'amqp://mq.internal:5672//',
    });
    expect(child).toEqual({PATH: '/usr/bin:/bin', SITE_URL: 'https://example.com/path', PUBLIC_DSN: 'amqp://mq.internal:5672//'});
  });
});

describe('runBoundedProcess natural exit with escaped descendant', () => {
  it.runIf(process.platform !== 'win32')('settles on the child\'s exit when a disowned descendant keeps the stdio pipes open', async () => {
    // `echo done; sleep 2 &` : the shell exits immediately, but the backgrounded
    // sleeper inherits stdout, so the 'close' event only fires ~2s later. The
    // bounded result must settle on the shell's exit within a short grace
    // instead of waiting for the descendant (pre-fix: waited the full timeout).
    const result = await runBoundedProcess({
      command: '/bin/sh', args: ['-c', 'echo done; sleep 2 &'], cwd: process.cwd(), timeoutMs: 8000,
      maxStdoutBytes: 1000, maxStderrBytes: 1000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.text).toContain('done');
    expect(result.durationMs).toBeLessThan(1500);
  });
});

describe('runBoundedProcess env sanitizer (HZ-10)', () => {
  const probe = "process.stdout.write(process.env.HAZE_TEST_FAKE_API_KEY ?? 'ABSENT')";

  afterEach(() => { delete process.env.HAZE_TEST_FAKE_API_KEY; });

  it('passes the parent environment through unchanged by default (sanitizer off)', async () => {
    process.env.HAZE_TEST_FAKE_API_KEY = 'secret-value';
    const result = await runBoundedProcess({command: process.execPath, args: ['-e', probe], cwd: process.cwd(), timeoutMs: 5000, maxStdoutBytes: 1000, maxStderrBytes: 1000});
    expect(result.code).toBe(0);
    expect(result.stdout.text).toBe('secret-value');
  });

  it('omits secret-shaped variables when enabled while keeping PATH', async () => {
    process.env.HAZE_TEST_FAKE_API_KEY = 'secret-value';
    const result = await runBoundedProcess({command: process.execPath, args: ['-e', `${probe};process.stdout.write(typeof process.env.PATH)`], cwd: process.cwd(), timeoutMs: 5000, maxStdoutBytes: 1000, maxStderrBytes: 1000, sanitizeEnv: {}});
    expect(result.code).toBe(0);
    expect(result.stdout.text).toBe('ABSENTstring');
  });
});

describe('runBoundedProcess', () => {
  it('bounds each stream while retaining byte metadata', async () => {
    const result = await runBoundedProcess({command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(10000));process.stderr.write('y'.repeat(8000))"], cwd: process.cwd(), timeoutMs: 5000, maxStdoutBytes: 100, maxStderrBytes: 80});
    expect(result.code).toBe(0);
    expect(result.stdout.retainedBytes).toBe(100);
    expect(result.stdout.omittedBytes).toBe(9900);
    expect(result.stderr.retainedBytes).toBe(80);
  });

  it('keeps draining omitted output so a chatty child can exit without blocking on a full pipe', async () => {
    const result = await runBoundedProcess({command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(2_000_000))"], cwd: process.cwd(), timeoutMs: 2000, maxStdoutBytes: 100, maxStderrBytes: 100});
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.retainedBytes).toBe(100);
    expect(result.stdout.omittedBytes).toBe(1_999_900);
  });

  it('distinguishes timeout termination', async () => {
    const result = await runBoundedProcess({command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: process.cwd(), timeoutMs: 20, killGraceMs: 20, maxStdoutBytes: 100, maxStderrBytes: 100});
    expect(result.timedOut).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('settles after timeout when an escaped descendant retains stdout', async () => {
    const escapedScript = 'setInterval(()=>{},2000)';
    const parentScript = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(escapedScript)}],{detached:true,stdio:['ignore',1,2]});child.unref();process.stdout.write(String(child.pid));setInterval(()=>{},1000)`;
    const startedAt = Date.now();
    const result = await runBoundedProcess({command: process.execPath, args: ['-e', parentScript], cwd: process.cwd(), timeoutMs: 50, killGraceMs: 30, maxStdoutBytes: 100, maxStderrBytes: 100});
    const escapedPid = Number(result.stdout.text);
    try {
      expect(result.timedOut).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(750);
    } finally {
      if (Number.isInteger(escapedPid) && escapedPid > 0) {
        try { process.kill(escapedPid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  it('does not spawn work for an already-aborted signal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-process-abort-'));
    dirs.push(dir);
    const marker = path.join(dir, 'started');
    const controller = new AbortController();
    controller.abort();
    const result = await runBoundedProcess({command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], cwd: dir, timeoutMs: 5000, signal: controller.signal, maxStdoutBytes: 100, maxStderrBytes: 100});
    expect(result.aborted).toBe(true);
    await expect(fs.stat(marker)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('aborts an in-flight child when the abort signal fires mid-execution', async () => {
    const controller = new AbortController();
    // Long-running child; abort after 20ms.
    const result = await new Promise<{aborted: boolean}>(resolve => {
      const promise = runBoundedProcess({command: process.execPath, args: ['-e', 'setInterval(()=>{}, 1000)'], cwd: process.cwd(), timeoutMs: 5000, signal: controller.signal, maxStdoutBytes: 100, maxStderrBytes: 100});
      setTimeout(() => controller.abort(), 20);
      void promise.then(resolve);
    });
    expect(result.aborted).toBe(true);
  });

  it('preserves valid UTF-8 when a retained stream ends mid-character', async () => {
    const script = "process.stdout.write(Buffer.from([0x61,0xf0,0x9f]));setTimeout(()=>process.stdout.write(Buffer.from([0x99,0x82,0x62])),5)";
    const result = await runBoundedProcess({command: process.execPath, args: ['-e', script], cwd: process.cwd(), timeoutMs: 5000, maxStdoutBytes: 3, maxStderrBytes: 100});
    expect(result.stdout.text).toBe('a');
    expect(result.stdout.text).not.toContain('�');
  });

  it.runIf(process.platform !== 'win32')('terminates descendants in the child process group', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-process-tree-'));
    dirs.push(dir);
    const pidFile = path.join(dir, 'child.pid');
    const childScript = 'setInterval(()=>{},1000)';
    const parentScript = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000)`;
    const result = await runBoundedProcess({command: process.execPath, args: ['-e', parentScript], cwd: dir, timeoutMs: 2000, killGraceMs: 50, maxStdoutBytes: 100, maxStderrBytes: 100});
    expect(result.timedOut).toBe(true);
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    let alive = true;
    const deadline = Date.now() + 1000;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(alive).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('settles bounded even when a descendant escapes the process group via setsid (BE-04)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-setsid-'));
    dirs.push(dir);
    // setsid detaches into its own session/group, so the group kill cannot
    // reach it; the bounded close fallback must still settle the run.
    // (detached:true makes libuv call setsid(2) — no setsid binary needed.)
    const script = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore', detached: true}).unref(); setInterval(()=>{}, 1000);`;
    const started = Date.now();
    const result = await runBoundedProcess({command: process.execPath, args: ['-e', script], cwd: dir, timeoutMs: 1500, killGraceMs: 50, maxStdoutBytes: 100, maxStderrBytes: 100});
    // The detached grandchild survives the group kill, but the run must still
    // settle within its bound instead of hanging on the retained pipes.
    expect(result.timedOut || result.exitCode != null).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
