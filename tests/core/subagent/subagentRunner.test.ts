import {describe, expect, it, vi} from 'vitest';
import {createSubagentTool, internals, runSubagent, type SubagentResult} from '../../../src/core/subagent/subagentRunner.js';

const noopModel = {} as Parameters<typeof runSubagent>[0]['model'];

const capture = vi.hoisted(() => ({maxSteps: 0, lastStep: 0}));

describe('subagent internals.toolSummary', () => {
  it('returns "no matches" when totalMatches is zero', () => {
    expect(internals.toolSummary({totalMatches: 0})).toBe('no matches');
  });

  it('returns "<n> matches" when totalMatches is positive', () => {
    expect(internals.toolSummary({totalMatches: 12})).toBe('12 matches');
  });

  it('returns "exit <code>" for bash-style outputs', () => {
    expect(internals.toolSummary({code: 0})).toBe('exit 0');
    expect(internals.toolSummary({code: 127})).toBe('exit 127');
  });

  it('returns "completed" for explicit ok:true payloads', () => {
    expect(internals.toolSummary({ok: true})).toBe('completed');
  });

  it('returns "failed: <error>" trimmed to 120 chars for explicit ok:false payloads', () => {
    const error = 'a'.repeat(150);
    expect(internals.toolSummary({ok: false, error})).toBe(`failed: ${'a'.repeat(120)}`);
  });

  it('falls back to "completed" for unknown shapes', () => {
    expect(internals.toolSummary({foo: 'bar'})).toBe('completed');
    expect(internals.toolSummary(null)).toBe('completed');
    expect(internals.toolSummary('string')).toBe('completed');
    expect(internals.toolSummary(42)).toBe('completed');
  });
});

describe('subagent internals.toolOnlyStepCount', () => {
  it('returns 0 for an empty step list', () => {
    expect(internals.toolOnlyStepCount([])).toBe(0);
  });

  it('counts only consecutive trailing steps that have tool calls and no text', () => {
    const steps = [
      {toolCalls: [{}], text: 'thinking aloud'},
      {toolCalls: [{}], text: ''},
      {toolCalls: [{}], text: '   '},
      {toolCalls: [{}, {}], text: ''},
    ];
    expect(internals.toolOnlyStepCount(steps)).toBe(3);
  });

  it('stops at the first step that emitted non-empty text', () => {
    expect(internals.toolOnlyStepCount([
      {toolCalls: [{}], text: 'wrap-up'},
      {toolCalls: [{}], text: ''},
    ])).toBe(1);
  });

  it('stops at a step with no tool calls even if text is empty', () => {
    expect(internals.toolOnlyStepCount([
      {toolCalls: [], text: ''},
      {toolCalls: [{}], text: ''},
    ])).toBe(1);
  });

  it('returns 0 when the most recent step has text', () => {
    expect(internals.toolOnlyStepCount([{toolCalls: [{}], text: 'final.'}])).toBe(0);
  });
});

let lastStepSeen = 0;

describe('runSubagent status mapping', () => {
  function streamTextMock(stream: AsyncIterable<string>, callbacks: {onStepFinish?: (event: {stepNumber: number}) => void; onFinish?: (event: {usage?: {inputTokens?: number; outputTokens?: number}}) => void} = {}) {
    if (callbacks.onStepFinish) callbacks.onStepFinish({stepNumber: 0});
    if (callbacks.onFinish) callbacks.onFinish({usage: {inputTokens: 0, outputTokens: 0}});
    return {
      textStream: stream,
      response: Promise.resolve({messages: []}),
    };
  }

  it('returns ok status when the model finishes within the step budget', async () => {
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        streamText: () => streamTextMock((async function*() { yield 'done'; })(), {onStepFinish: () => undefined, onFinish: () => undefined}),
      };
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const result: SubagentResult = await runSubagent('inspect', {model: noopModel, contextFiles: []});
    expect(result.status).toBe('ok');
    expect(result.summary).toBe('done');
    expect(result.tokens.in).toBe(0);
    expect(result.tokens.out).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns timeout status when the model hits the step limit (lastStep >= maxSteps)', async () => {
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        streamText: ({onStepFinish}: {onStepFinish?: (e: {stepNumber: number}) => void}) => {
          onStepFinish?.({stepNumber: 25});
          return streamTextMock((async function*() { /* empty */ })());
        },
      };
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const result = await runSubagent('long task', {model: noopModel, contextFiles: [], maxSteps: 25});
    expect(result.status).toBe('timeout');
  });

  it('returns cancelled status when the abort signal is already aborted', async () => {
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        streamText: () => streamTextMock((async function*() { yield 'partial'; })(), {onStepFinish: () => undefined, onFinish: () => undefined}),
      };
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const controller = new AbortController();
    controller.abort();
    const result = await runSubagent('aborted task', {model: noopModel, contextFiles: [], abortSignal: controller.signal});
    expect(result.status).toBe('cancelled');
  });

  it('returns error status when the model throws', async () => {
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        streamText: () => {
          throw new Error('boom');
        },
      };
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const result = await runSubagent('explodes', {model: noopModel, contextFiles: []});
    expect(result.status).toBe('error');
    expect(result.error).toBe('boom');
  });

  it('caps maxSteps at the configured STEP_LIMIT (25) even when caller asks for more', async () => {
    // The cap is a private constant (STEP_LIMIT = 25) passed to stepCountIs.
    // Verify behaviorally: a stream whose onStepFinish reports 100 steps
    // cannot make runSubagent think the limit was 100; we can only verify
    // by direct source inspection. Here we just confirm runSubagent accepts
    // a large maxSteps without crashing and returns a defined status.
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        streamText: ({onStepFinish}: {onStepFinish?: (e: {stepNumber: number}) => void}) => {
          onStepFinish?.({stepNumber: 25});
          return streamTextMock((async function*() { /* nothing */ })());
        },
      };
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const result = await runSubagent('huge', {model: noopModel, contextFiles: [], maxSteps: 999});
    expect(result.status).toBe('timeout');
  });

  it('uses a no-text fallback summary when the stream produces nothing', async () => {
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        streamText: () => streamTextMock((async function*() { /* empty */ })(), {onStepFinish: () => undefined, onFinish: () => undefined}),
      };
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const result = await runSubagent('silent', {model: noopModel, contextFiles: []});
    expect(result.summary).toBe('Subagent completed without text output.');
  });

  it('truncates summaries longer than MAX_SUMMARY (4000 chars)', async () => {
    const huge = 'x'.repeat(5000);
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        streamText: () => streamTextMock((async function*() { yield huge; })(), {onStepFinish: () => undefined, onFinish: () => undefined}),
      };
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const result = await runSubagent('huge summary', {model: noopModel, contextFiles: []});
    expect(result.summary.length).toBe(4000);
  });
});

describe('createSubagentTool', () => {
  it('exposes a stable description that encourages parallel-only use', () => {
    const tool = createSubagentTool({model: noopModel, contextFiles: []});
    expect(tool.description).toContain('parallel');
    expect(tool.description).toContain('no conversation history');
  });

  it('rejects an empty task via the input schema', () => {
    const tool = createSubagentTool({model: noopModel, contextFiles: []});
    const result = tool.inputSchema.safeParse({task: ''});
    expect(result.success).toBe(false);
  });

  it('rejects a negative maxSteps via the input schema', () => {
    const tool = createSubagentTool({model: noopModel, contextFiles: []});
    const result = tool.inputSchema.safeParse({task: 'x', maxSteps: -1});
    expect(result.success).toBe(false);
  });

  it('accepts a valid task', () => {
    const tool = createSubagentTool({model: noopModel, contextFiles: []});
    const result = tool.inputSchema.safeParse({task: 'do something', tools: ['bash', 'grep'], maxSteps: 10});
    expect(result.success).toBe(true);
    expect(result.data?.tools).toEqual(['bash', 'grep']);
    expect(result.data?.maxSteps).toBe(10);
  });
});
