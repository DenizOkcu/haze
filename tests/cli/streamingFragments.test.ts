import {describe, expect, it} from 'vitest';
import {isHiddenUnstartedFinalText, isShortLeadInBeforeTool, isShortUnfinishedLeadIn, shouldStartAssistantStream} from '../../src/cli/commands/streaming/assistantText.js';

describe('assistant streaming fragment gating', () => {
  it('keeps incomplete markdown fragments hidden even after debounce', () => {
    const startedAt = Date.now() - 1_000;

    expect(shouldStartAssistantStream('## Summary\n-', startedAt)).toBe(false);
    expect(isHiddenUnstartedFinalText('## Summary\n-')).toBe(true);
  });

  it('allows short complete final answers', () => {
    expect(isHiddenUnstartedFinalText('yes')).toBe(false);
    expect(isHiddenUnstartedFinalText('ok')).toBe(false);
  });

  it('does not promote short incomplete prefixes before debounce', () => {
    expect(shouldStartAssistantStream('The', Date.now())).toBe(false);
    expect(shouldStartAssistantStream('Let me', Date.now())).toBe(false);
  });

  it('hides short pre-tool lead-ins regardless of trailing punctuation', () => {
    const startedAt = Date.now() - 1_000;

    expect(shouldStartAssistantStream('Now let me', startedAt)).toBe(true);
    expect(isHiddenUnstartedFinalText('Now let me')).toBe(false);
    // Reported leaks — Gap #1 (sentence-boundary chars).
    expect(isShortLeadInBeforeTool('Confirmed:')).toBe(true);
    expect(isShortLeadInBeforeTool('Files written.')).toBe(true);
    expect(isShortLeadInBeforeTool('Done.')).toBe(true);
    expect(isShortLeadInBeforeTool("Here's the plan:")).toBe(true);
    // Previously-hidden lead-ins still hidden.
    expect(isShortLeadInBeforeTool('Now let me')).toBe(true);
    expect(isShortLeadInBeforeTool('Voy a revisar las pruebas')).toBe(true);
    // This one flipped: pre-tool, a finished short sentence is still preamble.
    expect(isShortLeadInBeforeTool('I checked the tests.')).toBe(true);
    // Guards: markdown fragment and >12-word text are NOT hidden by this gate.
    expect(isShortLeadInBeforeTool('## Summary\n-')).toBe(false);
    expect(isShortLeadInBeforeTool('This is a deliberately long sentence with well over twelve separate words present right here today.')).toBe(false);
  });

  it('hides 3-word end-of-step lead-ins while keeping real short answers', () => {
    // Hidden: 3-word dangling lead-ins (Gap #2).
    expect(isShortUnfinishedLeadIn('Let me read')).toBe(true);
    expect(isShortUnfinishedLeadIn('I now have')).toBe(true);
    expect(isShortUnfinishedLeadIn("Good — I've")).toBe(true);
    // Kept: boundary-ending answers survive at end-of-step.
    expect(isShortUnfinishedLeadIn('Done.')).toBe(false);
    expect(isShortUnfinishedLeadIn('Files written.')).toBe(false);
    // Kept: 1-2 word answers retain existing behavior.
    expect(isShortUnfinishedLeadIn('yes')).toBe(false);
    expect(isShortUnfinishedLeadIn('ok')).toBe(false);
    // Kept: 4-word statements are substantive.
    expect(isShortUnfinishedLeadIn('This is really great')).toBe(false);
    // Kept: markdown fragment handled by the other gate.
    expect(isShortUnfinishedLeadIn('## Summary\n-')).toBe(false);
  });
});
