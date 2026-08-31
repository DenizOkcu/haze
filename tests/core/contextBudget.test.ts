import {describe, expect, it} from 'vitest';
import {tool, type ModelMessage} from 'ai';
import {z} from 'zod';
import {cacheHitRatio, calculateRequestTokenBudget, contextBreakdown, contextTokensFromUsage, effectiveNonCachedInput, estimateConversationTokens, estimateMessagesTokens, estimateTextTokens, estimateValueTokens, FALLBACK_CONTEXT_WINDOW_TOKENS, IMAGE_BYTES_PER_TOKEN_ESTIMATE} from '../../src/core/agent/contextBudget.js';

describe('context budget', () => {
  it('accounts for system, messages, project context, and exact tool schemas', () => {
    const tools = {sample: tool({description: 'Sample tool', inputSchema: z.object({value: z.string()})})};
    const result = contextBreakdown({
      system: 'system',
      contextFiles: [{path: 'AGENTS.md', content: 'rules'}],
      messages: [{role: 'user', content: 'hello'}],
      tools,
    });
    expect(result.system).toBe(estimateTextTokens('system'));
    expect(result.projectContext[0]?.path).toBe('AGENTS.md');
    expect(result.toolSchemas[0]?.tokens).toBeGreaterThan(0);
    expect(result.messagesByRole.user).toBeGreaterThan(0);
    expect(result.logicalInputEstimate).toBeGreaterThan(result.system);
  });

  it('calculates non-cached provider input', () => {
    expect(effectiveNonCachedInput(1000, 750)).toBe(250);
    expect(effectiveNonCachedInput(undefined, 0)).toBeUndefined();
  });

  it('calculates cache hit ratio', () => {
    expect(cacheHitRatio(10000, 9500)).toBeCloseTo(0.95, 5);
    expect(cacheHitRatio(10743, 512)).toBeCloseTo(0.0477, 3);
    expect(cacheHitRatio(undefined, 1000)).toBeUndefined();
    expect(cacheHitRatio(1000, undefined)).toBeUndefined();
    expect(cacheHitRatio(0, 0)).toBeUndefined();
    expect(cacheHitRatio(1000, 0)).toBeUndefined();
  });

  it('estimates image file parts from byte size instead of serializing bytes (F03)', () => {
    const bytes = IMAGE_BYTES_PER_TOKEN_ESTIMATE * 100;
    const part = {type: 'file', mediaType: 'image/png', data: new Uint8Array(bytes)};
    expect(estimateValueTokens(part)).toBe(100);
    // Tagged data shape and base64 strings are handled too.
    expect(estimateValueTokens({type: 'file', mediaType: 'image/jpeg', data: {type: 'data', data: new Uint8Array(bytes)}})).toBe(100);
    expect(estimateValueTokens({type: 'file', mediaType: 'image/png', data: 'A'.repeat(400)})).toBe(1);
  });

  it('counts image parts in user messages without serializing the payload (F03)', () => {
    const message = {
      role: 'user',
      content: [
        {type: 'text', text: 'fix this layout'},
        {type: 'file', mediaType: 'image/png', data: new Uint8Array(IMAGE_BYTES_PER_TOKEN_ESTIMATE * 200), filename: 'shot.png'},
      ],
    };
    const tokens = estimateValueTokens(message);
    // Text envelope + text part + the 200-token image estimate: nowhere near
    // the millions of tokens a serialized payload would imply.
    expect(tokens).toBeGreaterThan(200);
    expect(tokens).toBeLessThan(400);
  });
});

describe('calculateRequestTokenBudget', () => {
  it('derives the message allowance from the full input breakdown', () => {
    const budget = calculateRequestTokenBudget({contextWindowTokens: 128_000, requestedOutputTokens: 16_384, system: 'system prompt', tools: {}});
    const overhead = budget.systemTokens + budget.toolSchemaTokens + budget.outputReserveTokens + budget.safetyMarginTokens;
    expect(budget.messageTokens + overhead).toBe(128_000);
    expect(budget.messageTokens).toBeGreaterThan(100_000);
  });

  it('keeps the request within capacity for a small 16K context', () => {
    const budget = calculateRequestTokenBudget({contextWindowTokens: 16_384, requestedOutputTokens: 4_096, system: 's', tools: {}});
    expect(budget.messageTokens).toBeLessThanOrEqual(16_384);
    expect(budget.messageTokens).toBeGreaterThan(0);
  });

  it('falls back to a conservative window when no metadata is declared', () => {
    const budget = calculateRequestTokenBudget({requestedOutputTokens: 4_096, system: 's', tools: {}});
    expect(budget.contextWindowTokens).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });

  it('reduces the message allowance as system/tool overhead grows', () => {
    const tools = {a: tool({description: 'a'.repeat(200), inputSchema: z.object({value: z.string()})})};
    const lean = calculateRequestTokenBudget({contextWindowTokens: 32_768, requestedOutputTokens: 4_096, system: 's', tools: {}});
    const heavy = calculateRequestTokenBudget({contextWindowTokens: 32_768, requestedOutputTokens: 4_096, system: 's', tools});
    expect(heavy.messageTokens).toBeLessThan(lean.messageTokens);
  });
});

describe('memoized message estimation (F-07)', () => {
  it('sums per-message estimates identically to whole-array estimation', () => {
    const messages: ModelMessage[] = [
      {role: 'user', content: 'hello world, this is a request'},
      {role: 'assistant', content: [{type: 'text', text: 'an answer with some length to it'}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 'c1', toolName: 'shell', output: {type: 'json', value: {ok: true}}}]},
    ];
    expect(estimateMessagesTokens(messages)).toBe(estimateValueTokens(messages));
  });

  it('re-estimating the same message objects is stable across calls', () => {
    const messages: ModelMessage[] = [{role: 'user', content: 'stable '.repeat(50)}];
    const first = estimateMessagesTokens(messages);
    expect(estimateMessagesTokens([...messages, {role: 'user', content: 'more'}])).toBeGreaterThan(first);
    expect(estimateMessagesTokens(messages)).toBe(first);
  });
});

describe('usage-backed context estimation (Pillar 1.1)', () => {
  it('derives context tokens from provider usage without double-counting cached input', () => {
    // Exclusive-style reporting (Anthropic-like: cache read outside inputTokens).
    expect(contextTokensFromUsage({inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 0})).toBe(4200);
    // Subset-style reporting (OpenAI-like: cached tokens already inside
    // inputTokens) must not count the cached prefix twice — a cache-heavy
    // successful finish is not an overflow.
    expect(contextTokensFromUsage({inputTokens: 120_000, outputTokens: 500, cacheReadTokens: 110_000, cacheWriteTokens: 0})).toBe(120_500);
    // All-zero or absent usage never anchors.
    expect(contextTokensFromUsage({})).toBeUndefined();
    expect(contextTokensFromUsage({inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0})).toBeUndefined();
  });

  it('uses the anchor for the covered prefix and estimates only trailing messages', () => {
    const covered: ModelMessage[] = [
      {role: 'user', content: 'x'.repeat(400)},
      {role: 'assistant', content: 'y'.repeat(400)},
      {role: 'user', content: 'z'.repeat(400)},
    ];
    const trailing: ModelMessage[] = [{role: 'user', content: 'a'.repeat(400)}];
    const anchor = {messageCount: covered.length, contextTokens: 10_000};
    const estimate = estimateConversationTokens([...covered, ...trailing], anchor, 2_000);
    expect(estimate.basis).toBe('usage');
    // 10k reported minus 2k non-message overhead, plus the trailing message's own estimate.
    expect(estimate.tokens).toBe(10_000 - 2_000 + estimateMessagesTokens(trailing));
  });

  it('falls back to pure estimates without an anchor or after a history rewrite', () => {
    const messages: ModelMessage[] = [
      {role: 'user', content: 'x'.repeat(400)},
      {role: 'assistant', content: 'y'.repeat(400)},
    ];
    expect(estimateConversationTokens(messages, undefined).basis).toBe('estimate');
    expect(estimateConversationTokens(messages, undefined).tokens).toBe(estimateMessagesTokens(messages));
    // A stale anchor (history shrank below its boundary, e.g. after compaction) is ignored.
    const stale = {messageCount: 5, contextTokens: 10_000};
    expect(estimateConversationTokens(messages, stale).basis).toBe('estimate');
  });

  it('excludes synthetic control messages from both sides so anchor indices stay aligned', () => {
    const history: ModelMessage[] = [
      {role: 'user', content: 'x'.repeat(400)},
      {role: 'user', content: '<haze_control>\nmid-turn nudge\n</haze_control>'},
      {role: 'assistant', content: 'y'.repeat(400)},
    ];
    // Anchor covered the two durable messages (controls excluded).
    const anchor = {messageCount: 2, contextTokens: 5_000};
    const estimate = estimateConversationTokens([...history, {role: 'user', content: '<haze_control>\nlate control\n</haze_control>'}], anchor, 1_000);
    expect(estimate.basis).toBe('usage');
    expect(estimate.tokens).toBe(4_000);
  });
});
