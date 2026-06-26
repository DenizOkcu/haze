import {describe, expect, it} from 'vitest';
import {inputSuggestionsForState} from '../../src/cli/chat/inputSuggestions.js';

describe('inputSuggestionsForState', () => {
  it('returns chat commands plus enabled skill slash commands', () => {
    const suggestions = inputSuggestionsForState({
      mode: 'chat',
      settings: {skills: [{name: 'disabled-skill', enabled: false}]},
      skills: [
        {name: 'enabled-skill', description: 'Enabled', body: '', references: [], dir: '/tmp/enabled', path: '/tmp/enabled/SKILL.md', source: 'global'},
        {name: 'disabled-skill', description: 'Disabled', body: '', references: [], dir: '/tmp/disabled', path: '/tmp/disabled/SKILL.md', source: 'global'},
      ],
    });

    expect(suggestions.map(suggestion => suggestion.value)).toContain('/help');
    expect(suggestions.map(suggestion => suggestion.value)).toContain('/enabled-skill');
    expect(suggestions.map(suggestion => suggestion.value)).not.toContain('/disabled-skill');
  });

  it('delegates provider modes to provider suggestions', () => {
    const suggestions = inputSuggestionsForState({
      mode: 'provider',
      settings: {providers: [{name: 'local', url: 'http://localhost:1234/v1', models: ['llama']}]},
      skills: [],
    });

    expect(suggestions.map(suggestion => suggestion.value)).toEqual(['local', 'add provider']);
  });
});
