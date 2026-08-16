import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {createSubagentTool, internals, runSubagent, type SubagentResult} from '../../../src/core/subagent/subagentRunner.js';

const noopModel = {} as Parameters<typeof runSubagent>[0]['model'];

// Subagents use generateText (non-streaming). Mocks return a fully-resolved
// result whose `text` is the final step's text and `steps`/`usage` are read
// directly — mirroring the real AI SDK contract.
type GenConfig = {
  messages?: Array<{role: string; content: string}>;
  abortSignal?: AbortSignal;
  tools?: Record<string, {execute?: (...args: unknown[]) => unknown}>;
  prepareStep?: (args: {steps: Array<{toolCalls: unknown[]; text: string}>; messages: Array<{role: string; content: string}>}) => unknown;
};
type GenStep = {stepNumber: number; text: string};
type GenResult = {
  text: string;
  steps: GenStep[];
  finalStep: GenStep;
  usage: {inputTokens: number; outputTokens: number};
  response: {messages: unknown[]};
};
function genResult(opts: {text?: string; steps?: GenStep[]; usage?: {inputTokens?: number; outputTokens?: number}} = {}): GenResult {
  const text = opts.text ?? '';
  const steps = opts.steps ?? [{stepNumber: 0, text}];
  return {
    text,
    steps,
    finalStep: steps[steps.length - 1] ?? {stepNumber: 0, text},
    usage: opts.usage ?? {inputTokens: 0, outputTokens: 0},
    response: {messages: []},
  };
}
function steps(n: number, text = ''): GenStep[] {
  return Array.from({length: n}, (_, i) => ({stepNumber: i, text}));
}

describe('subagent internals.toolSummary', () => {
  it('returns "no matches" when totalMatches is zero', () => {
    expect(internals.toolSummary({totalMatches: 0})).toBe('no matches');
  });

  it('returns "<n> matches" when totalMatches is positive', () => {
    expect(internals.toolSummary({totalMatches: 12})).toBe('12 matches');
    expect(internals.toolSummary({totalMatches: 12, matchCountIsLowerBound: true})).toBe('at least 12 matches');
  });

  it('returns "exit <code>" for shell-style outputs', () => {
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

describe('subagent validation evidence', () => {
  it('does not treat generic successful shell commands as validation', () => {
    expect(internals.validationFromOutput('shell', {command: 'git status', ok: true, code: 0})).toBeUndefined();
    expect(internals.validationFromOutput('shell', {command: 'npm test', ok: true, code: 0, validationSummary: {status: 'passed'}})).toEqual({command: 'npm test', ok: true});
  });
});

describe('subagent internals.toolOnlyStepCount', () => {
  it('returns 0 for an empty step list', () => {
    expect(internals.toolOnlyStepCount([])).toBe(0);
  });

  it('counts only consecutive trailing steps that have tool calls and no text', () => {
    const stepList = [
      {toolCalls: [{}], text: 'thinking aloud'},
      {toolCalls: [{}], text: ''},
      {toolCalls: [{}], text: '   '},
      {toolCalls: [{}, {}], text: ''},
    ];
    expect(internals.toolOnlyStepCount(stepList)).toBe(3);
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

describe('internals.shouldForceSynthesis (subagent budget guard)', () => {
  // Regression for the fleet review failure: a chatty model that narrates on
  // every step defeated the old toolOnly guard (it only counts trailing steps
  // with tool calls AND no text). Total tool-call volume must still force a
  // synthesis turn.
  it('forces synthesis on tool-call volume even when every step has narration text (P2)', () => {
    const narrating = Array.from({length: 20}, () => ({toolCalls: [{toolName: 'readFile', input: {}}], text: 'Let me read the next file.'}));
    expect(internals.shouldForceSynthesis(narrating, 25)).toBe(true);
  });

  it('does NOT force synthesis below the tool-call budget when steps narrate (no premature cutoff)', () => {
    const narrating = Array.from({length: 19}, () => ({toolCalls: [{}], text: 'reading…'}));
    expect(internals.shouldForceSynthesis(narrating, 25)).toBe(false);
  });

  // Reserve the tail of the step budget for synthesis so a subagent never ends
  // on read-narration just because it ran out of steps.
  it('forces synthesis within the reserved tail of the step budget (P1)', () => {
    const nearBudget = Array.from({length: 23}, () => ({toolCalls: [], text: ''})); // 25 - 2 = 23
    expect(internals.shouldForceSynthesis(nearBudget, 25)).toBe(true);
    const beforeTail = Array.from({length: 22}, () => ({toolCalls: [], text: ''}));
    expect(internals.shouldForceSynthesis(beforeTail, 25)).toBe(false);
  });

  it('still forces synthesis on a long tool-only run (original guard preserved)', () => {
    const toolOnly = Array.from({length: 12}, () => ({toolCalls: [{}], text: ''}));
    expect(internals.shouldForceSynthesis(toolOnly, 25)).toBe(true);
  });

  it('leaves quick tasks untouched (no synthesis forcing)', () => {
    expect(internals.shouldForceSynthesis([{toolCalls: [{toolName: 'readFile', input: {}}], text: ''}], 25)).toBe(false);
    expect(internals.shouldForceSynthesis([], 25)).toBe(false);
  });
});

describe('runSubagent status mapping', () => {
  it('returns ok status when the model finishes within the step budget', async () => {
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {...actual, generateText: async () => genResult({text: 'done'})};
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

  it('returns timeout status when the model hits the step limit (steps.length >= maxSteps)', async () => {
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {...actual, generateText: async () => genResult({text: '', steps: steps(25)})};
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const result = await runSubagent('long task', {model: noopModel, contextFiles: [], maxSteps: 25});
    expect(result.status).toBe('timeout');
  });

  it('blocks excess executions from a single emitted tool-call burst', async () => {
    let actualExecutions = 0;
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {...actual, generateText: async (config: GenConfig) => {
        await Promise.all(Array.from({length: 12}, () => config.tools?.probe?.execute?.({})));
        return genResult({text: 'partial evidence'});
      }};
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const profile = {...(await import('../../../src/core/subagent/executionProfiles.js')).COMPATIBILITY_PROFILE, maxToolCalls: 3};
    const result = await runSubagent('burst', {model: noopModel, profile, contextBundle: {
      instructions: [], systemPrompt: '', tools: {probe: {execute: async () => { actualExecutions++; return {ok: true}; }} as never}, taskTokens: 1, estimatedTokens: 1, validatedScope: [], loadedPaths: new Set(), loadedSignatures: new Map(),
    }});
    expect(actualExecutions).toBe(3);
    expect(result.capsule.termination).toBe('tool_limit');
    expect(result.telemetry.toolCallCount).toBe(3);
    expect(result.telemetry.toolCalls.length).toBeLessThanOrEqual(3);
  });

  it('returns cancelled status when the abort signal is already aborted', async () => {
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {...actual, generateText: async () => genResult({text: 'partial'})};
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
        generateText: async () => {
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

  it('policy-blocks an out-of-range maxSteps instead of silently clamping it', async () => {
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const result = await runSubagent('huge', {model: noopModel, contextFiles: [], maxSteps: 999});
    expect(result.status).toBe('error');
    expect(result.capsule.termination).toBe('policy_blocked');
  });

  it('uses a no-text fallback summary when the model produces no text', async () => {
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {...actual, generateText: async () => genResult({text: ''})};
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const result = await runSubagent('silent', {model: noopModel, contextFiles: []});
    expect(result.summary).toBe('Subagent completed without text output.');
  });

  it('truncates oversized deliverables with explicit metadata and a handle', async () => {
    const huge = 'x'.repeat(5000);
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {...actual, generateText: async () => genResult({text: huge})};
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const result = await runSubagent('huge summary', {model: noopModel, contextFiles: []});
    expect(result.summary.startsWith('x'.repeat(4000))).toBe(true);
    expect(result.capsule.truncated).toBe(true);
    expect(result.capsule.resultHandle).toMatch(/^output-/);
    expect(result.summary).toContain('Result truncated');
  });

  it('reports token usage from the resolved result', async () => {
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {...actual, generateText: async () => genResult({text: 'done', usage: {inputTokens: 42, outputTokens: 7}})};
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const result = await runSubagent('metered', {model: noopModel, contextFiles: []});
    expect(result.tokens).toEqual({in: 42, out: 7});
  });
});

describe('runSubagent synthesis capture & prepareStep history preservation', () => {
  // Regression for the /fleet review failure: the forced-synthesis turn sent
  // ONLY the directive to the model because prepareStep returned a bare
  // messages array, which the AI SDK uses verbatim (replacing the accumulated
  // conversation). The model then truthfully reported "no task / no tools
  // executed" and discarded every finding it had gathered. prepareStep must
  // preserve the full history and append the directive.
  it('prepareStep preserves the conversation and appends the synthesis directive (does not clobber history)', async () => {
    const captured: {prepareStep?: GenConfig['prepareStep']} = {};
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        generateText: async (config: GenConfig) => {
          captured.prepareStep = config.prepareStep;
          return genResult({text: ''});
        },
      };
    });
    vi.resetModules();
    const {runSubagent, internals} = await import('../../../src/core/subagent/subagentRunner.js');
    await runSubagent('the assigned task', {model: noopModel, contextFiles: []});

    // Force synthesis via tool-call volume (TOOL_CALL_BUDGET = 20).
    const forceSteps = Array.from({length: 20}, () => ({toolCalls: [{}], text: ''}));
    const history = [{role: 'user', content: 'the assigned task'}, {role: 'assistant', content: '[tool-call readFile]'}];
    const res = captured.prepareStep!({steps: forceSteps, messages: history}) as {toolChoice?: string; messages?: Array<{role: string; content: string}>};

    expect(res.toolChoice).toBe('none');
    expect(res.messages).toBeDefined();
    // The original task message must survive (history was not replaced).
    expect(res.messages?.[0]).toEqual({role: 'user', content: 'the assigned task'});
    // The directive is appended as a final user control message.
    const appended = res.messages?.at(-1);
    expect(appended?.role).toBe('user');
    expect(appended?.content).toContain(internals.SYNTHESIS_DIRECTIVE);
    // History preserved + exactly one appended directive.
    expect(res.messages?.length).toBe(history.length + 1);
  });

  it('prepareStep returns undefined when synthesis is not forced (normal steps untouched)', async () => {
    const captured: {prepareStep?: GenConfig['prepareStep']} = {};
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        generateText: async (config: GenConfig) => {
          captured.prepareStep = config.prepareStep;
          return genResult({text: ''});
        },
      };
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    await runSubagent('quick task', {model: noopModel, contextFiles: []});
    expect(captured.prepareStep!({steps: [{toolCalls: [{}], text: ''}], messages: [{role: 'user', content: 'quick task'}]})).toBeUndefined();
  });

  // Guard: the summary is the FINAL step's text (the deliverable), never the
  // first step's narration and never a concatenation of all steps.
  it('uses the final step text as the summary, not earlier narration or a concatenation', async () => {
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        generateText: async () => genResult({
          text: '# Findings\n- shell tool lacks timeout\n- fetch SSRF in webFetch.ts',
          steps: [
            {stepNumber: 0, text: 'Now let me look at the MCP/LSP settings.'},
            {stepNumber: 1, text: '# Findings\n- shell tool lacks timeout\n- fetch SSRF in webFetch.ts'},
          ],
        }),
      };
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const result: SubagentResult = await runSubagent('security review', {model: noopModel, contextFiles: []});
    expect(result.summary).toBe('# Findings\n- shell tool lacks timeout\n- fetch SSRF in webFetch.ts');
    expect(result.summary.startsWith('Now let me')).toBe(false);
  });
});

describe('createSubagentTool', () => {
  it('describes disposable context isolation and permits one substantial task', () => {
    const toolObj = createSubagentTool({model: noopModel, contextFiles: []});
    expect(toolObj.description).toContain('fresh disposable context');
    expect(toolObj.description).toContain('one substantial task');
    expect(toolObj.description).toContain('multiple calls');
  });

  it('requires the flat objective, deliverable, and mode capsule', () => {
    const toolObj = createSubagentTool({model: noopModel, contextFiles: []});
    expect(toolObj.inputSchema.safeParse({}).success).toBe(false);
    expect(toolObj.inputSchema.safeParse({objective: 'Inspect auth'}).success).toBe(false);
    expect(toolObj.inputSchema.safeParse({objective: 'Inspect auth', deliverable: 'Findings', mode: 'invalid'}).success).toBe(false);
    expect(toolObj.inputSchema.safeParse({objective: 'Inspect auth', deliverable: 'Findings', mode: 'inspect'}).success).toBe(true);
  });

  it('exposes one flat JSON schema without union branches for local model compatibility', () => {
    const toolObj = createSubagentTool({model: noopModel, contextFiles: []});
    const schema = z.toJSONSchema(toolObj.inputSchema) as {required?: string[]; anyOf?: unknown; oneOf?: unknown};
    expect(schema.required).toEqual(expect.arrayContaining(['objective', 'deliverable', 'mode']));
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
  });

  it('does not expose the ambiguous legacy task/tools/maxSteps shape', () => {
    const toolObj = createSubagentTool({model: noopModel, contextFiles: []});
    expect(toolObj.inputSchema.safeParse({task: 'do something', tools: ['shell', 'grep'], maxSteps: 10}).success).toBe(false);
  });
});

describe('createSubagentTool abort propagation (FR-008, /fleet US3)', () => {
  // The /fleet command relies on an existing core guarantee: the turn's AbortSignal
  // is forwarded from the tool execution context through runSubagent into the
  // generateText call, so one user abort cancels every in-flight subagent.
  it('cancels a queued/pre-aborted worker without invoking the provider', async () => {
    const captured: {abortSignal?: AbortSignal} = {};
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        generateText: async (config: GenConfig) => {
          captured.abortSignal = config.abortSignal;
          return genResult({text: 'partial'});
        },
      };
    });
    vi.resetModules();
    const {createSubagentTool} = await import('../../../src/core/subagent/subagentRunner.js');
    const controller = new AbortController();
    controller.abort();
    const subagentTool = createSubagentTool({model: noopModel, contextFiles: []});
    const result = await subagentTool.execute({objective: 'Abort me', deliverable: 'Return cancellation status', mode: 'inspect'}, {abortSignal: controller.signal} as never);
    expect(captured.abortSignal).toBeUndefined();
    expect(result.status).toBe('cancelled');
    expect(result.capsule.termination).toBe('cancelled');
  });
});

describe('runSubagent parallel isolation (FR-009, /fleet US4)', () => {
  // A /fleet run fans out several subagents; one failing or timing out must not
  // collapse the others. Each parallel subagent is an independent generateText
  // run with its own try/catch, so failures are returned per subtask, never thrown.
  it('a failing subagent does not collapse parallel subagents; each result is returned independently', async () => {
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        generateText: async (config: GenConfig) => {
          const message = config.messages?.[0]?.content ?? '';
          const objective = JSON.parse(message).objective as string;
          if (objective === 'fail') throw new Error('boom');
          return genResult({text: `ok: ${objective}`});
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
        generateText: async (config: GenConfig) => {
          captured.push(config.messages ?? []);
          return genResult({text: 'ok'});
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
    // Each call sees one bounded JSON capsule—never sibling or parent history.
    expect(captured.every(messages => messages.length === 1 && messages[0]?.role === 'user')).toBe(true);
    const objectives = captured.map(messages => JSON.parse(messages[0]!.content).objective).sort();
    expect(objectives).toEqual(['task-a', 'task-b']);
    expect(captured.map(messages => messages[0]!.content).join(' ')).not.toContain('/fleet');
  });
});

describe('subagent V2 boundary', () => {
  it('accepts the preferred flat bounded capsule and rejects oversized fields', () => {
    const toolObj = createSubagentTool({model: noopModel, contextFiles: []});
    expect(toolObj.inputSchema.safeParse({objective: 'Inspect logs', deliverable: 'Root cause with evidence', mode: 'inspect', scope: ['src'], acceptanceCriteria: ['cite files']}).success).toBe(true);
    expect(toolObj.inputSchema.safeParse({objective: 'Inspect mapped files', deliverable: 'Findings', mode: 'inspect', scope: Array.from({length: 13}, (_, i) => `src/file-${i}.ts`)}).success).toBe(true);
    expect(toolObj.inputSchema.safeParse({objective: 'Too many paths', deliverable: 'Findings', mode: 'inspect', scope: Array.from({length: 33}, (_, i) => `src/file-${i}.ts`)}).success).toBe(false);
    expect(toolObj.inputSchema.safeParse({objective: 'x'.repeat(4001), deliverable: 'result', mode: 'inspect'}).success).toBe(false);
    expect(toolObj.inputSchema.safeParse({task: 'legacy', maxSteps: 10}).success).toBe(false);
  });

  it('serializes only the compact capsule to parent model context', async () => {
    const toolObj = createSubagentTool({model: noopModel, contextFiles: []});
    const capsule = {id: 'w', termination: 'completed' as const, usable: true, deliverable: 'done', changedPaths: [], validation: [], coverageGaps: [], truncated: false};
    const raw = {capsule, telemetry: {private: 'not model visible'}};
    const modelOutput = await toolObj.toModelOutput!({toolCallId: 'call', input: {objective: 'x', deliverable: 'y', mode: 'inspect'}, output: raw as never});
    expect(modelOutput).toEqual({type: 'json', value: capsule});
    expect(JSON.stringify(modelOutput)).not.toContain('telemetry');
  });

  it('passes provider options and profile retry/output limits to worker generation', async () => {
    let captured: Record<string, unknown> = {};
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {...actual, generateText: async (config: Record<string, unknown>) => { captured = config; return genResult({text: 'done'}); }};
    });
    vi.resetModules();
    const {runSubagent} = await import('../../../src/core/subagent/subagentRunner.js');
    const profile = {name: 'test', maxConcurrency: 1, maxSteps: 8, maxToolCalls: 6, maxOutputTokens: 2048, maxSummaryChars: 4000, maxInputTokens: 40000, deadlineMs: 1000, maxRetries: 1};
    await runSubagent('provider parity', {contextFiles: [], runtime: {model: noopModel, selector: 'openai:worker', providerName: 'openai', capabilities: {reportsCacheUsage: true, supportsPromptCacheKey: true, supportsExtendedCacheRetention: false, supportsStickySessionId: false, supportsServerCompaction: false, supportsTextVerbosity: true}, requestOptions: {providerOptions: {openai: {promptCacheKey: 'key'}}, headers: {'x-test': 'yes'}}}, profile});
    expect(captured).toMatchObject({providerOptions: {openai: {promptCacheKey: 'key'}}, headers: {'x-test': 'yes'}, maxRetries: 1, maxOutputTokens: 2048});
  });
});
