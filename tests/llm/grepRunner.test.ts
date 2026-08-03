import {describe, expect, it} from 'vitest';
import {runRipgrepBounded} from '../../src/llm/tools/grepRunner.js';
import {runBoundedProcess} from '../../src/core/process/runBoundedProcess.js';

// runRipgrepBounded is executable-agnostic (spawn + bounded collection), so
// these guards use bash standing in for ripgrep. They pin the teardown
// behavior inherited from the shared bounded-process primitive (CR-004).
describe('runRipgrepBounded', () => {
  it('terminates the process and reports timedOut on timeout', async () => {
    const startedAt = Date.now();
    const result = await runRipgrepBounded({executable: 'bash', args: ['-c', 'sleep 30'], cwd: process.cwd(), maxMatches: 10, timeoutMs: 100});
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 10_000);

  it('terminates the process and reports aborted on an abort signal', async () => {
    const controller = new AbortController();
    const pending = runRipgrepBounded({executable: 'bash', args: ['-c', 'sleep 30'], cwd: process.cwd(), maxMatches: 10, signal: controller.signal});
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 10_000);

  it('stops early at the global match cap and keeps collected lines', async () => {
    const result = await runRipgrepBounded({executable: 'bash', args: ['-c', 'for i in $(seq 1 100000); do echo \'{"type":"match"}\'; done'], cwd: process.cwd(), maxMatches: 3});
    expect(result.capped).toBe(true);
    const lines = result.stdout.split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.length).toBeGreaterThanOrEqual(3);
  }, 10_000);

  it('propagates spawn errors as rejections like the bounded primitive reports them', async () => {
    const result = await runBoundedProcess({command: 'definitely-not-a-real-binary', args: [], cwd: process.cwd(), timeoutMs: 1000, maxStdoutBytes: 1024, maxStderrBytes: 1024});
    expect(result.error).toBeDefined();
    await expect(runRipgrepBounded({executable: 'definitely-not-a-real-binary', args: [], cwd: process.cwd(), maxMatches: 1})).rejects.toThrow();
  });
});
