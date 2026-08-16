import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {hazeTools} from '../../src/llm/hazeTools.js';
import {teardownBackgroundProcesses} from '../../src/core/process/backgroundRegistry.js';

describe('shell tool safety', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
  });

  afterEach(async () => {
    await teardownBackgroundProcesses(25);
    await fs.remove(tmp);
  });

  async function shell(command: string, abortSignal?: AbortSignal, background = false) {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      return await hazeTools.shell.execute({command, background}, {abortSignal});
    } finally {
      process.chdir(originalCwd);
    }
  }

  it('exposes the 1.0 schema without pre-release compatibility fields', () => {
    const parsed = hazeTools.shell.inputSchema.safeParse({command: 'pwd', allowMutation: true});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).not.toHaveProperty('allowMutation');
  });

  it('runs read-only commands with classification metadata', async () => {
    const result = await shell('pwd');
    expect(result.ok).toBe(true);
    await expect(fs.realpath(result.cwd)).resolves.toBe(await fs.realpath(tmp));
    expect(result.classification.riskLevel).toBe('read_only');
  });

  it('runs destructive commands without confirmation', async () => {
    await fs.outputFile(path.join(tmp, 'dist/file.txt'), 'temporary build output');
    const result = await shell('rm -rf dist');
    expect(result.ok).toBe(true);
    expect(result.classification.riskLevel).toBe('destructive');
    await expect(fs.pathExists(path.join(tmp, 'dist'))).resolves.toBe(false);
  });

  it('runs non-destructive mutating commands without confirmation', async () => {
    const result = await shell('touch file.txt');
    expect(result.ok).toBe(true);
    expect(result.classification.riskLevel).toBe('mutating');
    await expect(fs.pathExists(path.join(tmp, 'file.txt'))).resolves.toBe(true);
  });

  it('runs unknown-but-recoverable validation commands without confirmation', async () => {
    await fs.outputFile(path.join(tmp, 'public/app.js'), 'const value = 1;\n');
    const result = await shell('node --check public/app.js');
    expect(result.ok).toBe(true);
  });

  it('stores oversized output behind a retrievable handle', async () => {
    const result = await shell("node -e \"process.stdout.write('x'.repeat(20000))\"");
    expect(result.stdout.truncated).toBe(true);
    expect(result.stdout.handle).toMatch(/^output-/);
    const page = await hazeTools.readToolOutput.execute({handle: result.stdout.handle, offset: 0, limit: 1000}, {abortSignal: undefined});
    expect(page.content).toHaveLength(1000);
    expect(page.nextOffset).toBe(1000);
  });

  it('searches stored output handles with context lines', async () => {
    const result = await shell("node -e \"for (let i = 0; i < 2000; i++) console.log(i === 1234 ? 'needle failure' : 'line ' + i)\"");
    expect(result.stdout.handle).toMatch(/^output-/);
    const page = await hazeTools.readToolOutput.execute({handle: result.stdout.handle, offset: 0, limit: 1000, query: 'needle', contextLines: 1}, {abortSignal: undefined});
    expect(page.query).toBe('needle');
    expect(page.content).toContain('needle failure');
    expect(page.content).toContain('1234: line 1233');
    expect(page.content).toContain('1236: line 1235');
  });

  it('bounds runaway command output without hanging reducers', async () => {
    const result = await shell("node -e \"process.stdout.write('line\\n'.repeat(600000))\"");
    expect(result.ok).toBe(true);
    expect(result.stdout.text.length).toBeLessThan(20_000);
    expect(result.stdoutBytes.omittedBytes).toBeGreaterThan(0);
    const page = await hazeTools.readToolOutput.execute({handle: result.stdout.handle, offset: 0, limit: 1000}, {abortSignal: undefined});
    expect(page.content).toHaveLength(1000);
  }, 15_000);

  it('starts background commands immediately and manages them through the process tool (F09)', async () => {
    const result = await shell("node -e \"console.log('server ready');setInterval(()=>console.log('tick'),25)\"", undefined, true);
    expect(result).toMatchObject({ok: true, background: true, backgroundId: expect.any(String), pid: expect.any(Number), outputHandle: expect.stringMatching(/^output-/)});
    if (!('backgroundId' in result) || !('outputHandle' in result)) throw new Error('Expected a background result.');
    let output: Awaited<ReturnType<typeof hazeTools.process.execute>> | undefined;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      output = await hazeTools.process.execute({action: 'output', backgroundId: result.backgroundId, offset: 0, limit: 12_000}, {abortSignal: undefined});
      if ('content' in output && output.content.includes('server ready')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    const listed = await hazeTools.process.execute({action: 'list', offset: 0, limit: 12_000}, {abortSignal: undefined});
    expect(listed).toMatchObject({ok: true, processes: [expect.objectContaining({backgroundId: result.backgroundId, status: 'running'})]});
    expect(output).toMatchObject({ok: true, outputHandle: result.outputHandle});
    expect(output && 'content' in output && output.content).toContain('server ready');
    const killed = await hazeTools.process.execute({action: 'kill', backgroundId: result.backgroundId, offset: 0, limit: 12_000}, {abortSignal: undefined});
    expect(killed).toMatchObject({ok: true, process: expect.objectContaining({status: 'killed'})});
  });

  it('does not start background work after turn abort or inside a worker', async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = await shell('sleep 30', controller.signal, true);
    expect(aborted).toMatchObject({ok: false, reasonCode: 'aborted'});

    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      const worker = await hazeTools.shell.execute({command: 'sleep 30', background: true}, {context: {isSubagent: true}});
      expect(worker).toMatchObject({ok: false, reasonCode: 'background_not_allowed'});
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('reports explicit abort separately from timeout', async () => {
    const controller = new AbortController();
    const pending = shell("node -e 'setInterval(()=>{},1000)'", controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result).toMatchObject({ok: false, aborted: true, timedOut: false});
  });

  it('keeps full raw output retrievable when reducer input is capped', async () => {
    const script = "let s='a'.repeat(250000); s += 'NEEDLE_END'; process.stdout.write(s)";
    const result = await shell(`node -e "${script}"`);
    expect(result.stdout.handle).toMatch(/^output-/);
    const page = await hazeTools.readToolOutput.execute({handle: result.stdout.handle, offset: 250000, limit: 20}, {abortSignal: undefined});
    expect(page.content).toContain('NEEDLE_END');
  }, 15_000);

  it('does not embed raw stream text in the tool result (regression CR-001)', async () => {
    const result = await shell("node -e \"process.stdout.write('y'.repeat(150000))\"");
    expect(result.stdoutBytes.retainedBytes).toBeGreaterThan(100_000);
    expect(result.stdoutBytes).toEqual({totalBytes: expect.any(Number), retainedBytes: expect.any(Number), omittedBytes: expect.any(Number)});
    expect(result.stderrBytes).toEqual({totalBytes: expect.any(Number), retainedBytes: expect.any(Number), omittedBytes: expect.any(Number)});
    const serialized = JSON.stringify(result);
    expect(serialized.length).toBeLessThan(60_000);
    expect('text' in result.stdoutBytes).toBe(false);
    expect('text' in result.stderrBytes).toBe(false);
  }, 15_000);
});
