import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runBoundedProcess} from '../../../src/core/process/runBoundedProcess.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, {recursive: true, force: true}))); });

describe('runBoundedProcess', () => {
  it('bounds each stream while retaining byte metadata', async () => {
    const result = await runBoundedProcess({command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(10000));process.stderr.write('y'.repeat(8000))"], cwd: process.cwd(), timeoutMs: 5000, maxStdoutBytes: 100, maxStderrBytes: 80});
    expect(result.code).toBe(0);
    expect(result.stdout.retainedBytes).toBe(100);
    expect(result.stdout.omittedBytes).toBe(9900);
    expect(result.stderr.retainedBytes).toBe(80);
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
      if (Number.isInteger(escapedPid)) {
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
    const childScript = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)`;
    const parentScript = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const result = await runBoundedProcess({command: process.execPath, args: ['-e', parentScript], cwd: dir, timeoutMs: 1000, killGraceMs: 50, maxStdoutBytes: 100, maxStderrBytes: 100});
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
});
