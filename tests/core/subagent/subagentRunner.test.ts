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
    expect(internals.toolSummary({totalMatches: 12, matchCountIsLowerBound: true})).toBe('at least 12 matches');
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
  function streamTextMock(stream: AsyncIterable<string>, callbacks: {onStepEnd?: (event: {stepNumber: number}) => void; onEnd?: (event: {usage?: {inputTokens?: number; outputTokens?: number}}) => void} = {}) {
    if (callbacks.onStepEnd) callbacks.onStepEnd({stepNumber: 0});
    if (callbacks.onEnd) callbacks.onEnd({usage: {inputTokens: 0, outputTokens: 0}});
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
        streamText: () => streamTextMock((async function*() { yield 'done'; })(), {onStepEnd: () => undefined, onEnd: () => undefined}),
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
        streamText: ({onStepEnd}: {onStepEnd?: (e: {stepNumber: number}) => void}) => {
          onStepEnd?.({stepNumber: 25});
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
        streamText: () => streamTextMock((async function*() { yield 'partial'; })(), {onStepEnd: () => undefined, onEnd: () => undefined}),
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
    // The cap is a private constant (STEP_LIMIT = 25) passed to isStepCount.
    // Verify behaviorally: a stream whose onStepEnd reports 100 steps
    // cannot make runSubagent think the limit was 100; we can only verify
    // by direct source inspection. Here we just confirm runSubagent accepts
    // a large maxSteps without crashing and returns a defined status.
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        streamText: ({onStepEnd}: {onStepEnd?: (e: {stepNumber: number}) => void}) => {
          onStepEnd?.({stepNumber: 25});
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
        streamText: () => streamTextMock((async function*() { /* empty */ })(), {onStepEnd: () => undefined, onEnd: () => undefined}),
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
        streamText: () => streamTextMock((async function*() { yield huge; })(), {onStepEnd: () => undefined, onEnd: () => undefined}),
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

describe('createSubagentTool abort propagation (FR-008, /fleet US3)', () => {
  // The /fleet command relies on an existing core guarantee: the turn's AbortSignal
  // is forwarded from the tool execution context through runSubagent into the
  // streamText call, so one user abort cancels every in-flight subagent.
  it('forwards the turn AbortSignal from the tool context and cancels the in-flight subagent', async () => {
    const captured: {abortSignal?: AbortSignal} = {};
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        streamText: ({abortSignal, onStepEnd, onEnd}: {abortSignal?: AbortSignal; onStepEnd?: (e: {stepNumber: number}) => void; onEnd?: (e: {usage?: {inputTokens?: number; outputTokens?: number}}) => void}) => {
          captured.abortSignal = abortSignal;
          onStepEnd?.({stepNumber: 0});
          onEnd?.({usage: {inputTokens: 0, outputTokens: 0}});
          return {
            textStream: (async function* () { yield 'partial'; })(),
            response: Promise.resolve({messages: []}),
          };
        },
      };
    });
    vi.resetModules();
    const {createSubagentTool} = await import('../../../src/core/subagent/subagentRunner.js');
    const controller = new AbortController();
    controller.abort();
    const subagentTool = createSubagentTool({model: noopModel, contextFiles: []});
    const result = await subagentTool.execute({task: 'abort me'}, {abortSignal: controller.signal} as never);
    // The tool forwarded the turn's abort signal into the subagent run...
    expect(captured.abortSignal).toBe(controller.signal);
    // ...and the aborted run reports cancelled, restoring user control.
    expect(result.status).toBe('cancelled');
  });
});

describe('runSubagent parallel isolation (FR-009, /fleet US4)', () => {
  // A /fleet run fans out several subagents; one failing or timing out must not
  // collapse the others. Each parallel subagent is an independent streamText run
  // with its own try/catch, so failures are returned per subtask, never thrown.
  it('a failing subagent does not collapse parallel subagents; each result is returned independently', async () => {
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        streamText: ({messages, onStepEnd, onEnd}: {messages?: Array<{role: string; content: string}>; onStepEnd?: (e: {stepNumber: number}) => void; onEnd?: (e: {usage?: {inputTokens?: number; outputTokens?: number}}) => void}) => {
          const task = messages?.[0]?.content ?? '';
          if (task === 'fail') throw new Error('boom');
          onStepEnd?.({stepNumber: 0});
          onEnd?.({usage: {inputTokens: 0, outputTokens: 0}});
          return {
            textStream: (async function* () { yield `ok: ${task}`; })(),
            response: Promise.resolve({messages: []}),
          };
        },
      };
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const results = await Promise.all([
      runSubagent('audit', {model: noopModel, contextFiles: []}),
      runSubagent('fail', {model: noopModel, contextFiles: []}),
      runSubagent('research', {model: noopModel, contextFiles: []}),
    ]);
    expect(results).toHaveLength(3);
    // None of the three collapsed the parallel group; statuses are per subtask.
    expect(results.map(r => r.status)).toEqual(['ok', 'error', 'ok']);
    // The healthy subtasks still produced their own summaries.
    expect(results[0]?.summary).toBe('ok: audit');
    expect(results[2]?.summary).toBe('ok: research');
    // The failing subtask is reported, not swallowed.
    expect(results[1]?.status).toBe('error');
    expect(results[1]?.error).toBe('boom');
    // Timeout-status mapping for a single subagent is covered by the suite above.
  });
});

describe('runSubagent independent context (FR-010, /fleet)', () => {
  // Every subagent spawned by /fleet must operate with no shared conversation
  // history. runSubagent builds its own messages — a single user turn carrying
  // only the task — so sibling subagents never see each other's context.
  it('each subagent receives only its own task with no shared conversation history', async () => {
    const captured: Array<Array<{role: string; content: string}>> = [];
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        streamText: ({messages, onStepEnd, onEnd}: {messages?: Array<{role: string; content: string}>; onStepEnd?: (e: {stepNumber: number}) => void; onEnd?: (e: {usage?: {inputTokens?: number; outputTokens?: number}}) => void}) => {
          captured.push(messages ?? []);
          onStepEnd?.({stepNumber: 0});
          onEnd?.({usage: {inputTokens: 0, outputTokens: 0}});
          return {
            textStream: (async function* () { yield 'ok'; })(),
            response: Promise.resolve({messages: []}),
          };
        },
      };
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    await Promise.all([
      runSubagent('task-a', {model: noopModel, contextFiles: []}),
      runSubagent('task-b', {model: noopModel, contextFiles: []}),
    ]);
    expect(captured).toHaveLength(2);
    // Each call sees exactly one user message — its own task — never its sibling's history.
    expect(captured[0]).toEqual([{role: 'user', content: 'task-a'}]);
    expect(captured[1]).toEqual([{role: 'user', content: 'task-b'}]);
  });
});
