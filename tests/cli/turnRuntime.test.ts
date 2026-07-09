import {describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {estimateInputBreakdown, extractUsage, rememberContextFilesFromToolOutput, responseCompletionMetrics, retryDelayMs, stepCacheMetrics, subagentTokenEstimate, abortableDelay} from '../../src/cli/commands/streaming/turnRuntime.js';

describe('turnRuntime', () => {
  it('caps retry delay growth', () => {
    expect(retryDelayMs(0)).toBe(1000);
    expect(retryDelayMs(1)).toBe(2000);
    expect(retryDelayMs(10)).toBe(4000);
  });

  it('normalizes provider usage details', () => {
    expect(extractUsage({usage: {inputTokens: 100, outputTokens: 20, inputTokenDetails: {cacheReadTokens: 25}, outputTokenDetails: {reasoningTokens: 3}}})).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 25,
      noCacheTokens: 75,
      effectiveNonCachedInput: 75,
      reasoningTokens: 3,
    });
  });

  it('extractUsage handles missing usage and computes noCacheTokens from effectiveNonCachedInput', () => {
    expect(extractUsage({})).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
      effectiveNonCachedInput: undefined,
      reasoningTokens: 0,
    });
  });

  it('stepCacheMetrics computes a cache hit ratio', () => {
    const metrics = stepCacheMetrics({inputTokens: 100, inputTokenDetails: {cacheReadTokens: 25, cacheWriteTokens: 5}, outputTokenDetails: {reasoningTokens: 2}});
    expect(metrics).toMatchObject({inputTokens: 100, cacheReadTokens: 25, cacheWriteTokens: 5, reasoningTokens: 2, noCacheTokens: 75});
    expect(metrics.cacheHitRatio).toBe(0.25);
  });

  it('stepCacheMetrics returns cacheHitRatio undefined when inputTokens are missing', () => {
    expect(stepCacheMetrics({inputTokenDetails: {cacheReadTokens: 25}}).cacheHitRatio).toBeUndefined();
  });

  it('responseCompletionMetrics emits a positive tokensPerSecond for non-empty text', () => {
    const startedAt = Date.now() - 2000;
    const metrics = responseCompletionMetrics('hello world', startedAt);
    expect(metrics.finishedAt).toBeGreaterThanOrEqual(startedAt);
    expect(metrics.tokensPerSecond).toBeGreaterThan(0);
  });

  it('responseCompletionMetrics returns no tokensPerSecond for empty text', () => {
    expect(responseCompletionMetrics('', Date.now()).tokensPerSecond).toBeUndefined();
  });

  it('estimateInputBreakdown reduces messages, tools, and system to token counts', () => {
    const breakdown = estimateInputBreakdown({
      system: 'You are haze.',
      contextFiles: [{path: 'AGENTS.md', content: 'rules'}],
      messages: [{role: 'user', content: 'hi'}, {role: 'assistant', content: 'hello'}],
      tools: {readFile: {description: 'r'}, bash: {description: 'b'}},
    });
    expect(breakdown.systemPrompt).toBeGreaterThan(0);
    expect(breakdown.messages).toBeGreaterThan(0);
    expect(breakdown.toolSchemas).toBeGreaterThan(0);
    expect(breakdown.logicalInputEstimate).toBeGreaterThan(0);
    expect(breakdown.breakdown.system).toBe(breakdown.systemPrompt);
  });

  it('remembers applicable scoped context files only once', () => {
    const existing = [{path: 'AGENTS.md', content: 'root'}];
    const next = rememberContextFilesFromToolOutput(existing, {
      applicableProjectInstructions: [
        {path: 'AGENTS.md', content: 'duplicate'},
        {path: 'pkg/AGENTS.md', content: 'pkg'},
        {path: 1, content: 'invalid'},
      ],
    });

    expect(next).toEqual([{path: 'AGENTS.md', content: 'root'}, {path: 'pkg/AGENTS.md', content: 'pkg'}]);
  });

  it('rememberContextFilesFromToolOutput returns the original list for non-object outputs', () => {
    const existing = [{path: 'AGENTS.md', content: 'root'}];
    expect(rememberContextFilesFromToolOutput(existing, null)).toBe(existing);
    expect(rememberContextFilesFromToolOutput(existing, 'string')).toBe(existing);
    expect(rememberContextFilesFromToolOutput(existing, {applicableProjectInstructions: 'not an array'})).toBe(existing);
  });

  it('rememberContextFilesFromToolOutput ignores malformed instruction entries', () => {
    const existing = [{path: 'AGENTS.md', content: 'root'}];
    const next = rememberContextFilesFromToolOutput(existing, {
      applicableProjectInstructions: [
        null,
        {content: 'no path'},
        {path: 'p'},
        {path: 5, content: 'x'},
      ],
    });
    expect(next).toEqual(existing);
  });

  it('extracts subagent token estimates from structured outputs', () => {
    expect(subagentTokenEstimate({tokens: {in: 12, out: 3}})).toEqual({input: 12, output: 3});
    expect(subagentTokenEstimate({tokens: {in: 0, out: 0}})).toBeUndefined();
  });

  it('subagentTokenEstimate returns undefined when no tokens object is present', () => {
    expect(subagentTokenEstimate({foo: 'bar'})).toBeUndefined();
    expect(subagentTokenEstimate(null)).toBeUndefined();
  });

  it('abortableDelay resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableDelay(5000, controller.signal)).resolves.toBeUndefined();
  });

  it('abortableDelay resolves after the timeout when not aborted', async () => {
    const controller = new AbortController();
    const start = Date.now();
    await abortableDelay(50, controller.signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('abortableDelay resolves early when the signal aborts mid-wait', async () => {
    const controller = new AbortController();
    const promise = abortableDelay(5000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    const start = Date.now();
    await promise;
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('estimateInputBreakdown tolerates missing fields', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-tr-'));
    const originalCwd = process.cwd;
    process.cwd = () => tmp;
    try {
      const breakdown = estimateInputBreakdown({system: '', contextFiles: [], messages: []});
      expect(breakdown.systemPrompt).toBe(0);
      expect(breakdown.messages).toBe(0);
      expect(breakdown.toolSchemas).toBe(0);
    } finally {
      process.cwd = originalCwd;
      await fs.remove(tmp);
    }
  });
});
