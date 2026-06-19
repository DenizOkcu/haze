import {describe, expect, it} from 'vitest';
import {marked, type Tokens} from 'marked';
import {renderMarkdownTable} from '../../src/ui/components/MarkdownText.js';

describe('MarkdownText table rendering', () => {
  it('renders GFM tables as bordered terminal tables', () => {
    const [token] = marked.lexer([
      'Package | Version | Role',
      '--- | --- | ---',
      '@types/react | ^19.0.0 | TS types for React',
      'vite | ^6.0.0 | Dev server + bundler',
    ].join('\n'), {gfm: true, breaks: true});

    expect(token.type).toBe('table');
    expect(renderMarkdownTable(token as Tokens.Table)).toEqual([
      '┌──────────────┬─────────┬──────────────────────┐',
      '│ Package      │ Version │ Role                 │',
      '├──────────────┼─────────┼──────────────────────┤',
      '│ @types/react │ ^19.0.0 │ TS types for React   │',
      '│ vite         │ ^6.0.0  │ Dev server + bundler │',
      '└──────────────┴─────────┴──────────────────────┘',
    ]);
  });

  it('honors right and center table alignment', () => {
    const [token] = marked.lexer([
      'Name | Count | State',
      ':--- | ---: | :---:',
      'A | 12 | ok',
    ].join('\n'), {gfm: true, breaks: true});

    expect(renderMarkdownTable(token as Tokens.Table)).toContain('│ A    │    12 │  ok   │');
  });

  it('wraps long cells to fit the available terminal width', () => {
    const [token] = marked.lexer([
      'Package | Version | Usage',
      '--- | --- | ---',
      'react | ^19.0.0 | Core hooks used directly across App and detail views without manual React import.',
    ].join('\n'), {gfm: true, breaks: true});

    const lines = renderMarkdownTable(token as Tokens.Table, 50);

    expect(lines.every(line => line.length <= 50)).toBe(true);
    expect(lines).toContain('│ react   │ ^19.0.0 │ Core hooks used directly   │');
    expect(lines).toContain('│         │         │ across App and detail      │');
  });
});
