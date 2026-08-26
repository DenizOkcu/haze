import {describe, expect, it} from 'vitest';
import type {ModelMessage} from 'ai';
import {buildLlmCompactionPrompt, compactModelMessages, compactModelMessagesWithSummary, modelMessageText, splitForCompaction} from '../../src/core/agent/compaction.js';
import {createWorkState} from '../../src/core/agent/workState.js';
import {isContextOverflowError, isRetryableModelError} from '../../src/core/agent/errors.js';
import {askRefinementPrompt, classifyGoalShape, createSessionGoal, deriveRequestAsks, escalateGoalShape, goalContinuationPrompt} from '../../src/core/agent/goalPolicy.js';

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
});

describe('ask extraction (P2: deterministic, request-derived)', () => {
  it('derives separate asks for coordinated imperatives and implied asks', () => {
    expect(deriveRequestAsks('add the export button and a test for it')).toEqual(['Add the export button', 'A test for it']);
    expect(deriveRequestAsks('create the parser. Then document it and update the docs page')).toEqual(['Create the parser', 'Document it', 'Update the docs page']);
  });

  it('keeps plain noun conjunctions as one ask', () => {
    expect(deriveRequestAsks('add foo and bar to the config')).toEqual(['Add foo and bar to the config']);
  });

  it('bounds, dedupes, and caps asks', () => {
    const long = deriveRequestAsks(`add ${'x'.repeat(300)}`);
    expect(long).toHaveLength(1);
    expect(long[0]!.length).toBeLessThanOrEqual(160);
    const many = deriveRequestAsks('add one. add two. add three. add four. add five. add six. add seven. add eight.');
    expect(many).toHaveLength(7);
  });

  it('degrades to an empty list (no ask gate) when no imperative clause exists', () => {
    expect(deriveRequestAsks('what does this repo do')).toEqual([]);
    expect(deriveRequestAsks('')).toEqual([]);
  });
});

describe('goal shapes (P5: proportional ceremony)', () => {
  it('classifies deterministically: fix→debug, 3+ asks→multi-lane, short single-ask→trivial, else bounded', () => {
    expect(classifyGoalShape('fix the crash', 'fix', 1)).toBe('debug');
    expect(classifyGoalShape('do a, b, c', 'implement', 3)).toBe('multi-lane');
    expect(classifyGoalShape('rename X to Y', 'implement', 1)).toBe('trivial');
    expect(classifyGoalShape('add a feature', 'implement', 1)).toBe('trivial');
    expect(classifyGoalShape(`refactor the whole subsystem carefully across ${'many '.repeat(30)}files`, 'implement', 1)).toBe('bounded');
  });

  it('escalates upward only, never downward', () => {
    expect(escalateGoalShape('trivial', 'bounded')).toEqual({shape: 'bounded', escalated: true});
    expect(escalateGoalShape('bounded', 'debug')).toEqual({shape: 'debug', escalated: true});
    expect(escalateGoalShape('multi-lane', 'bounded')).toEqual({shape: 'multi-lane', escalated: false});
    expect(escalateGoalShape('debug', 'trivial')).toEqual({shape: 'debug', escalated: false});
  });
});

describe('createSessionGoal (P2/P5 wiring)', () => {
  it('seeds request-derived asks and a shape for mutating intents', () => {
    const goal = createSessionGoal('add the endpoint and a test for it');
    expect(goal.asks!.map(ask => ask.text)).toEqual(['Add the endpoint', 'A test for it']);
    expect(goal.shape).toBe('bounded');
    expect(goal.successCriteria).toEqual(goal.asks!.map(ask => ask.text));
  });

  it('keeps plan/review/answer goals ask-free (regression-safe)', () => {
    expect(createSessionGoal('create a plan for the refactor').asks).toBeUndefined();
    expect(createSessionGoal('review the auth flow').asks).toBeUndefined();
    expect(createSessionGoal('what is haze').asks).toBeUndefined();
  });
});

describe('goal continuation prompt (P2/P4 payload)', () => {
  it('names unmet asks and the structured closure path', () => {
    const prompt = goalContinuationPrompt('asks from the original request remain unmet: Add a test for it', undefined, ['Add a test for it']);
    expect(prompt).toContain('Unmet asks from the original request: Add a test for it');
    expect(prompt).toContain('askUpdates');
  });

  it('names the red→green requirement and waiver path for fix readiness', () => {
    const prompt = goalContinuationPrompt('no failing repro was captured before the fix landed (red→green pair missing)');
    expect(prompt).toContain('redWaiver');
    expect(prompt).toContain('Reproduce the reported failure');
  });

  it('appends verifier-provided gap detail', () => {
    const prompt = goalContinuationPrompt('independent verification rejected completion', undefined, undefined, 'Independent verification named these gaps: the new file has no test');
    expect(prompt).toContain('the new file has no test');
  });
});

describe('ask refinement nudge (P2b)', () => {
  it('lists the derived asks and requires one pre-work writeTasks amendment', () => {
    const prompt = askRefinementPrompt('add the export button and a test for it', ['Add the export button', 'A test for it']);
    expect(prompt).toContain('Add the export button');
    expect(prompt).toContain('askAmendments');
    expect(prompt).toContain('before any file edit or command');
    expect(prompt).toContain('waived with a waiverReason');
  });

  it('asks for declarations when extraction produced no asks', () => {
    const prompt = askRefinementPrompt('make the CLI nicer', []);
    expect(prompt).toContain('none derived');
    expect(prompt).toContain('declare each as a new ask');
  });
});

describe('multi-lane continuation hint (P5)', () => {
  it('encourages parallel lanes only for multi-lane goals', () => {
    const lane = goalContinuationPrompt('asks from the original request remain unmet: a', undefined, ['a'], undefined, 'multi-lane');
    expect(lane).toContain('disjoint lanes');
    expect(lane).toContain('parallel subagents');
    expect(lane).toContain('serialized');
    const bounded = goalContinuationPrompt('asks from the original request remain unmet: a', undefined, ['a'], undefined, 'bounded');
    expect(bounded).not.toContain('parallel subagents');
    expect(goalContinuationPrompt('asks remain', undefined, ['a'])).not.toContain('parallel subagents');
  });
});
