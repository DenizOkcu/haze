import {describe, expect, it} from 'vitest';
import {isHiddenUnstartedFinalText, isShortUnfinishedBridgeBeforeTool, shouldStartAssistantStream} from '../../src/cli/commands/streaming.js';

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

  it('detects short unfinished pre-tool bridges without language-specific matching', () => {
    const startedAt = Date.now() - 1_000;

    expect(shouldStartAssistantStream('Now let me', startedAt)).toBe(true);
    expect(isHiddenUnstartedFinalText('Now let me')).toBe(false);
    expect(isShortUnfinishedBridgeBeforeTool('Now let me')).toBe(true);
    expect(isShortUnfinishedBridgeBeforeTool('Voy a revisar las pruebas')).toBe(true);
    expect(isShortUnfinishedBridgeBeforeTool('I checked the tests.')).toBe(false);
  });
});
