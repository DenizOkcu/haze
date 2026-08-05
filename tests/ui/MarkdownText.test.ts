import {describe, expect, it} from 'vitest';
import {marked, type Tokens} from 'marked';
import {markdownRootChunks, renderMarkdownTable} from '../../src/ui/components/MarkdownText.js';

describe('streaming Markdown root chunks', () => {
  it('keeps the active root block live and commits earlier blocks exactly', () => {
    const content = 'First **complete** paragraph.\n\nSecond partial paragraph';

    expect(markdownRootChunks(content)).toEqual([
      'First **complete** paragraph.\n\n',
      'Second partial paragraph',
    ]);
  });

  it('does not commit a block until a following root block has started', () => {
    expect(markdownRootChunks('Still streaming one paragraph')).toEqual(['Still streaming one paragraph']);
    expect(markdownRootChunks('- first\n- second')).toEqual(['- first\n- second']);
    expect(markdownRootChunks('- first\n- second\n\nNext')).toEqual(['- first\n- second\n\n', 'Next']);
  });

  it('keeps a source-path lead attached to its fenced code block', () => {
    const leadAndFence = '**Implementation** — `src/App.tsx:105`\n\n```tsx\nconst app = true;\n```';
    expect(markdownRootChunks(leadAndFence)).toEqual([leadAndFence]);
    expect(markdownRootChunks(`${leadAndFence}\n\nNext block`)).toEqual([
      `${leadAndFence}\n\n`,
      'Next block',
    ]);
  });

  it('withholds roots that Marked may reclassify while more text arrives', () => {
    expect(markdownRootChunks('Title')).toEqual(['Title']);
    expect(markdownRootChunks('Title\n---')).toEqual(['Title\n---']);
    expect(markdownRootChunks('Name | Count\n--- | ---')).toEqual(['Name | Count\n--- | ---']);
  });
});

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
