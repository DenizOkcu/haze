import {describe, expect, it} from 'vitest';
import type {HazeSettings} from '../../../src/config/settings.js';
import {chatLayoutFor, modelStatusFor} from '../../../src/cli/chat/chatViewModel.js';

// ARCH-05: the status-bar model/reasoning text and the frame layout moved out of
// `ChatScreen` as pure functions, so they get direct unit coverage.
const provider = {name: 'remote', url: 'https://example.invalid/v1', models: ['m-1']};

function settingsWith(overrides: Partial<HazeSettings> = {}): HazeSettings {
  return {provider: 'remote', model: 'm-1', providers: [provider], ...overrides};
}

describe('modelStatusFor', () => {
  it('reports an unconfigured screen without a reasoning suffix', () => {
    expect(modelStatusFor({settings: {}, selectedModel: undefined, sessionReasoning: undefined})).toEqual({activeModelName: 'unconfigured', reasoningSuffix: ''});
  });

  it('names the session selection and marks it unavailable when it no longer resolves', () => {
    const selected = {provider: 'remote', model: 'm-1'};
    expect(modelStatusFor({settings: settingsWith(), selectedModel: selected, sessionReasoning: undefined}).activeModelName).toBe('remote:m-1');
    expect(modelStatusFor({settings: {}, selectedModel: selected, sessionReasoning: undefined}).activeModelName).toBe('remote:m-1 (unavailable)');
  });

  it('renders the resolved reasoning level, the provider default and the unset case', () => {
    const selected = {provider: 'remote', model: 'm-1'};
    const supported = settingsWith({providers: [{...provider, capabilities: {reasoningEffort: true}}]});
    // Nothing stored: the built-in default level is requested and applied.
    expect(modelStatusFor({settings: supported, selectedModel: selected, sessionReasoning: undefined}).reasoningSuffix).toBe(' (low)');
    // A session override wins over the global setting.
    expect(modelStatusFor({settings: supported, selectedModel: selected, sessionReasoning: {'remote:m-1': 'high'}}).reasoningSuffix).toBe(' (high)');
    // `unset` sends no parameter at all.
    expect(modelStatusFor({settings: supported, selectedModel: selected, sessionReasoning: {'remote:m-1': 'provider-default'}}).reasoningSuffix).toBe(' (no reasoning parameter)');
    // A provider whose protocol cannot carry the level falls back to its default.
    const unsupported = settingsWith({providers: [{...provider, capabilities: {reasoningEffort: false}}]});
    expect(modelStatusFor({settings: unsupported, selectedModel: selected, sessionReasoning: undefined}).reasoningSuffix).toBe(' (provider default)');
  });

  it('shows no reasoning suffix when no provider selection resolves', () => {
    expect(modelStatusFor({settings: {providers: [provider]}, selectedModel: undefined, sessionReasoning: undefined})).toEqual({activeModelName: 'unconfigured', reasoningSuffix: ''});
  });
});

describe('chatLayoutFor', () => {
  it('pads wide frames by one column each side and never drops below one content column', () => {
    expect(chatLayoutFor(80, 80)).toEqual({horizontalPadding: 1, contentWidth: 78, replayContentWidth: 78});
    expect(chatLayoutFor(12, 12)).toEqual({horizontalPadding: 1, contentWidth: 10, replayContentWidth: 10});
  });

  it('goes borderless on tiny terminals', () => {
    expect(chatLayoutFor(8, 8)).toEqual({horizontalPadding: 0, contentWidth: 8, replayContentWidth: 8});
    expect(chatLayoutFor(1, 1)).toEqual({horizontalPadding: 0, contentWidth: 1, replayContentWidth: 1});
  });
});
