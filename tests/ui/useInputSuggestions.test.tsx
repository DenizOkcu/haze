import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Text} from 'ink';
import {render} from 'ink-testing-library';
import React from 'react';
import {useInputSuggestions} from '../../src/ui/components/useInputSuggestions.js';
import type {TextInputSuggestion} from '../../src/ui/components/TextInput.js';

type Suggestions = TextInputSuggestion[];

/** Probe component exposing the hook's suggestion surface as rendered text. */
function Probe({provider, value, cursor}: {provider: (token: string) => Promise<Suggestions>; value: string; cursor: number}) {
  const state = useInputSuggestions({value, cursor, suggestions: [], suggestionMode: 'slash', getMentionSuggestions: provider});
  const payload = JSON.stringify({mode: state.inMentionMode, list: state.mentionList.map(item => item.value)});
  return <Text>{payload}</Text>;
}

describe('useInputSuggestions mention staleness (SU-06)', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.restoreAllMocks());

  function setup(provider: (token: string) => Promise<Suggestions>, value: string, cursor: number) {
    return render(<Probe provider={provider} value={value} cursor={cursor}/>);
  }

  it('never applies the previous token\'s results to a new token while refetching', async () => {
    let resolveAlpha: ((value: Suggestions) => void) | undefined;
    const provider = (token: string) => new Promise<Suggestions>(resolve => {
      if (token === 'alpha') resolveAlpha = resolve;
      else resolve([{label: `result-${token}`, value: `@${token}-one`}]);
    });
    const rendered = setup(provider, 'check @alpha', 'check @alpha'.length);
    // Token changes while alpha's promise is still pending: no old entries may show.
    rendered.rerender(<Probe provider={provider} value="check @beta" cursor={"check @beta".length}/>);
    await vi.waitFor(() => {
      const frame = rendered.lastFrame() ?? '';
      expect(frame).toContain('"mode":true');
      expect(frame).toContain('"list":[]');
    });
    // Alpha resolves late; its entries still must not surface for the beta token.
    resolveAlpha?.([{label: 'alpha-file', value: '@alpha-file'}]);
    await vi.waitFor(() => expect(rendered.lastFrame() ?? '').toContain('@beta-one'));
    expect(rendered.lastFrame() ?? '').not.toContain('@alpha-file');
  });

  it('clears results when the mention disappears', async () => {
    const provider = async () => [{label: 'x', value: '@xy'}] as Suggestions;
    const rendered = setup(provider, 'hi @x', 'hi @x'.length);
    await vi.waitFor(() => expect(rendered.lastFrame() ?? '').toContain('@xy'));
    rendered.rerender(<Probe provider={provider} value="hi " cursor={3}/>);
    await vi.waitFor(() => expect(rendered.lastFrame() ?? '').toContain('"mode":false'));
    expect(rendered.lastFrame() ?? '').not.toContain('@xy');
  });
});
