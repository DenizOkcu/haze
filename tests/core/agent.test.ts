import {describe, expect, it} from 'vitest';
import type {ModelMessage} from 'ai';
import {buildLlmCompactionPrompt, chooseBoundaryCompactionMethod, compactModelMessages, compactModelMessagesWithSummary, extractExistingCompactionSummary, modelMessageText, splitForCompaction} from '../../src/core/agent/compaction.js';
import {createWorkState} from '../../src/core/agent/workState.js';
import {isContextOverflowError, isRetryableModelError} from '../../src/core/agent/errors.js';
import {goalContinuationPrompt} from '../../src/core/agent/goalPolicy.js';

function msg(role: 'user' | 'assistant' | 'system', content: string): ModelMessage {
  return {role, content};
}

describe('agent compaction', () => {
  it('does not compact when message count is below threshold', () => {
    const messages = [msg('user', 'hello'), msg('assistant', 'hi')];
    const result = compactModelMessages(messages, {keepRecentMessages: 3});
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.keptCount).toBe(2);
  });

  it('adds a summary user context message and keeps the recent tail', () => {
    const messages = [
      msg('user', 'old request'),
      msg('assistant', 'old answer'),
      msg('user', 'recent request'),
      msg('assistant', 'recent answer'),
    ];
    const result = compactModelMessages(messages, {keepRecentMessages: 2});
    expect(result.compacted).toBe(true);
    expect(result.olderCount).toBe(2);
    expect(result.keptCount).toBe(2);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toMatchObject({role: 'user'});
    expect(modelMessageText(result.messages[0])).toContain('<haze_compaction>');
    expect(modelMessageText(result.messages[0])).toContain('old request');
    expect(result.messages.slice(1)).toEqual(messages.slice(-2));
  });

  it('includes optional compaction instructions', () => {
    const result = compactModelMessages([
      msg('user', 'a'),
      msg('assistant', 'b'),
      msg('user', 'c'),
    ], {keepRecentMessages: 1, instructions: 'keep validation details'});
    expect(result.summary).toContain('keep validation details');
  });

  it('uses the token budget for the recent tail and preserves structured work state', () => {
    const state = createWorkState('finish the implementation', 'implementation', ['tests pass']);
    state.files.push({path: 'src/index.ts', action: 'modified'});
    state.nextAction = 'Run npm test.';
    const messages = [
      msg('user', 'old '.repeat(200)),
      msg('assistant', 'middle '.repeat(200)),
      msg('user', 'recent request'),
      msg('assistant', 'recent answer'),
    ];
    const result = compactModelMessages(messages, {tokenBudget: 20, workState: state});
    expect(result.compacted).toBe(true);
    expect(result.keptCount).toBeGreaterThan(0);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    expect(result.summary).toContain('<work_state>');
    expect(result.summary).toContain('src/index.ts');
    expect(result.summary).toContain('Run npm test.');
  });

  it('extracts text from array content safely', () => {
    const message = {role: 'user', content: [{type: 'text', text: 'hello'}, {type: 'image', image: 'ignored'}]} as unknown as ModelMessage;
    expect(modelMessageText(message)).toBe('hello');
  });

  it('preserves the full text of older messages without truncation', () => {
    const longText = 'x'.repeat(1200);
    const result = compactModelMessages([
      msg('user', longText),
      msg('assistant', 'answer'),
      msg('user', 'recent'),
    ], {keepRecentMessages: 1});
    expect(result.compacted).toBe(true);
    expect(result.summary).toContain(longText);
  });

  it('keeps the older-context excerpt bounded for very long conversations (regression CR-008)', () => {
    const messages: ModelMessage[] = [];
    for (let index = 0; index < 100; index++) {
      messages.push(msg(index % 2 === 0 ? 'user' : 'assistant', `message ${index} `.repeat(200)));
    }
    messages.push(msg('user', 'recent'));
    const result = compactModelMessages(messages, {keepRecentMessages: 1});
    expect(result.compacted).toBe(true);
    expect(result.summary!.length).toBeLessThan(20_000);
    expect(result.summary).toContain('omitted from the excerpt');
    // The most recent older messages survive; the oldest do not.
    expect(result.summary).toContain('message 99');
    expect(result.summary).not.toContain('message 0 ');
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
  });

  it('does not split a retained tool result from its preceding tool call', () => {
    const messages = [
      msg('user', 'old request '.repeat(100)),
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'call-1', toolName: 'readFile', input: {path: 'a.ts'}}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 'call-1', toolName: 'readFile', output: {type: 'json', value: {ok: true}}}]},
    ] as unknown as ModelMessage[];
    const result = compactModelMessages(messages, {tokenBudget: 20});
    expect(result.compacted).toBe(true);
    expect(result.messages.slice(1)).toEqual(messages.slice(1));
  });
});

describe('agent provider error classification', () => {
  it('detects context overflow errors', () => {
    expect(isContextOverflowError(new Error('maximum context length exceeded'))).toBe(true);
    expect(isContextOverflowError('input too long: too many tokens')).toBe(true);
  });

  it('separates retryable transient errors from account/request errors', () => {
    expect(isRetryableModelError(new Error('503 provider overloaded'))).toBe(true);
    expect(isRetryableModelError(new Error('network connection lost'))).toBe(true);
    expect(isRetryableModelError(new TypeError('terminated'))).toBe(true);
    expect(isRetryableModelError(new Error('insufficient quota'))).toBe(false);
    expect(isRetryableModelError(new Error('invalid api key'))).toBe(false);
    expect(isRetryableModelError(new Error('maximum context length exceeded'))).toBe(false);
  });

  it('matches status codes as whole words, not substrings (regression CR-020)', () => {
    expect(isRetryableModelError(new Error('HTTP 500 from provider'))).toBe(true);
    expect(isRetryableModelError(new Error('429 rate limit'))).toBe(true);
    expect(isRetryableModelError(new Error('processed 5000 files'))).toBe(false);
    expect(isRetryableModelError(new Error('context of 15000 tokens'))).toBe(false);
    expect(isRetryableModelError(new Error('streaming response closed'))).toBe(false);
    expect(isRetryableModelError(new Error('stream disconnected unexpectedly'))).toBe(true);
    expect(isRetryableModelError(new Error('bad request 400'))).toBe(false);
    expect(isRetryableModelError(new Error('payment method declined (card 4001)'))).toBe(false);
  });
});

describe('LLM-summarized compaction pieces (F-09)', () => {
  const many: ModelMessage[] = Array.from({length: 30}, (_, i) => msg('user', `older message ${i} ` + 'x'.repeat(50)));

  it('splitForCompaction mirrors the heuristic split rules', () => {
    const split = splitForCompaction([...many, msg('user', 'recent')], {keepRecentMessages: 3});
    expect(split?.older).toHaveLength(28);
    expect(split?.recent).toHaveLength(3);
    expect(splitForCompaction(many.slice(0, 2), {keepRecentMessages: 5})).toBeUndefined();
  });

  it('buildLlmCompactionPrompt bounds the transcript and keeps the most recent entries', () => {
    const prompt = buildLlmCompactionPrompt({older: many, instructions: 'focus on decisions', maxChars: 600});
    expect(prompt).toContain('<older_conversation>');
    expect(prompt).toContain('User compaction instructions: focus on decisions');
    expect(prompt).toContain('older message 29');
    expect(prompt).not.toContain('older message 0 ');
    const transcript = prompt.slice(prompt.indexOf('<older_conversation>'), prompt.indexOf('</older_conversation>'));
    expect(transcript.length).toBeLessThanOrEqual(620);
  });

  it('compactModelMessagesWithSummary wraps the model summary with continuity framing', () => {
    const result = compactModelMessagesWithSummary([...many, msg('user', 'recent')], {summaryText: 'THE SUMMARY', keepRecentMessages: 3});
    expect(result.compacted).toBe(true);
    expect(result.olderCount).toBe(28);
    expect(result.keptCount).toBe(3);
    const first = result.messages[0] as {role: string; content: string};
    expect(first.role).toBe('user');
    expect(first.content).toContain('<haze_compaction>');
    expect(first.content).toContain('Model-written summary of the older conversation:');
    expect(first.content).toContain('THE SUMMARY');
    expect(result.messages.at(-1)).toEqual(msg('user', 'recent'));
  });

  it('flags a split turn when the recent window lands mid-turn (Pillar 1.6)', () => {
    // A user message starts a turn; cutting at an assistant message keeps the
    // turn's early prefix in the older half — a split turn.
    const turn = [msg('user', 'do the big task'), msg('assistant', 'step one'), msg('assistant', 'step two'), msg('assistant', 'step three')];
    const split = splitForCompaction(turn, {keepRecentMessages: 1});
    expect(split?.splitTurn).toBe(true);
    expect(split?.older).toHaveLength(3);
    // Cutting at a user message boundary is not a split turn.
    const clean = splitForCompaction([msg('user', 'old request'), msg('assistant', 'old answer'), msg('user', 'new request'), msg('assistant', 'new answer')], {keepRecentMessages: 2});
    expect(clean?.splitTurn).toBe(false);
  });

  it('extracts an existing compaction summary for iterative chaining (Pillar 1.5)', () => {
    const compacted = compactModelMessages([...many, msg('user', 'recent')], {keepRecentMessages: 3});
    const extracted = extractExistingCompactionSummary(compacted.messages);
    expect(extracted).toBe(compacted.summary);
    expect(extractExistingCompactionSummary([msg('user', 'plain'), msg('assistant', 'answer')])).toBeUndefined();
  });

  it('buildLlmCompactionPrompt chains a previous summary and flags split turns', () => {
    const chained = buildLlmCompactionPrompt({older: many, previousSummary: 'PREVIOUS SUMMARY', splitTurn: true});
    expect(chained).toContain('<previous-summary>');
    expect(chained).toContain('PREVIOUS SUMMARY');
    expect(chained).toContain('MIDDLE of an unfinished task');
    const plain = buildLlmCompactionPrompt({older: many});
    expect(plain).not.toContain('<previous-summary>');
    expect(plain).not.toContain('MIDDLE of an unfinished task');
  });

  it('chooses the boundary compaction method from budget and older-half size (Pillar 1.5)', () => {
    const small = [msg('user', 'old request'), msg('assistant', 'old answer'), msg('user', 'recent'), msg('assistant', 'recent answer')];
    // Fits the budget: no compaction.
    expect(chooseBoundaryCompactionMethod({messages: small, messageTokenBudget: 10_000, olderTokenThreshold: 6_000}).method).toBe('none');
    // Over budget with a small older half: deterministic heuristic excerpt.
    const overBudget = chooseBoundaryCompactionMethod({messages: [...many, msg('user', 'recent')], messageTokenBudget: 50, olderTokenThreshold: 6_000});
    expect(overBudget.method).toBe('heuristic');
    expect(overBudget.split?.older.length).toBeGreaterThan(0);
    // Over budget with a large older half: LLM-written summary.
    const large = Array.from({length: 80}, (_, index) => msg(index % 2 === 0 ? 'user' : 'assistant', `older message ${index} ${'x'.repeat(500)}`));
    const llm = chooseBoundaryCompactionMethod({messages: [...large, msg('user', 'recent')], messageTokenBudget: 400, olderTokenThreshold: 6_000});
    expect(llm.method).toBe('llm');
  });

  it('lets a usage-anchored total override the chars/4 estimate for the over-budget check (Pillar 1.1 × 1.5)', () => {
    // 14 short messages: the chars/4 estimate fits a 10K budget (no
    // compaction by default), but a compaction split still exists past the
    // 12-message recent window.
    const short = Array.from({length: 14}, (_, index) => msg(index % 2 === 0 ? 'user' : 'assistant', `short ${index}`));
    expect(chooseBoundaryCompactionMethod({messages: short, messageTokenBudget: 10_000, olderTokenThreshold: 6_000}).method).toBe('none');
    // The provider-anchored total says over budget (token-dense history):
    // compaction must still fire.
    const anchored = chooseBoundaryCompactionMethod({messages: short, messageTokenBudget: 10_000, olderTokenThreshold: 6_000, totalTokens: 20_000});
    expect(anchored.method).toBe('heuristic');
    // …and an anchored total inside the budget suppresses it despite the
    // heuristic estimate being over.
    const fits = chooseBoundaryCompactionMethod({messages: [...many, msg('user', 'recent')], messageTokenBudget: 50, olderTokenThreshold: 6_000, totalTokens: 10});
    expect(fits.method).toBe('none');
  });
});

describe('goal continuation prompt (opportunistic red→green)', () => {
  it('asks for the same captured failing check to turn green', () => {
    const prompt = goalContinuationPrompt('the captured pre-edit failing check has not passed after the fix');
    expect(prompt).toContain('same validation command');
    expect(prompt).not.toContain('waiver');
  });
});
