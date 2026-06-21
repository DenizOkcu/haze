import {describe, expect, it} from 'vitest';
import {pickLspServer} from '../../src/llm/lsp.js';
import type {HazeLspServer} from '../../src/config/lspSettings.js';

const ts: HazeLspServer = {name: 'typescript', command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx']};
const py: HazeLspServer = {name: 'python', command: 'pyright-langserver', args: ['--stdio'], extensions: ['.py']};

describe('pickLspServer', () => {
  it('matches a server by file extension', () => {
    expect(pickLspServer([ts, py], 'src/app.ts')?.name).toBe('typescript');
    expect(pickLspServer([ts, py], 'src/app.tsx')?.name).toBe('typescript');
    expect(pickLspServer([ts, py], 'scripts/main.py')?.name).toBe('python');
  });

  it('matches case-insensitively', () => {
    expect(pickLspServer([ts], 'SRC/APP.TSX')?.name).toBe('typescript');
  });

  it('skips disabled servers and falls through to the next match', () => {
    expect(pickLspServer([{...ts, enabled: false}, py], 'app.ts')).toBeUndefined();
    expect(pickLspServer([{...ts, enabled: false}, py], 'app.py')?.name).toBe('python');
  });

  it('returns undefined when no server covers the extension', () => {
    expect(pickLspServer([ts, py], 'README.md')).toBeUndefined();
    expect(pickLspServer([], 'app.ts')).toBeUndefined();
  });

  it('handles a server without an extensions list', () => {
    const noext: HazeLspServer = {name: 'none', command: 'x'};
    expect(pickLspServer([noext], 'app.ts')).toBeUndefined();
  });

  it('prefers the first matching server when several could match', () => {
    const ts2: HazeLspServer = {...ts, name: 'typescript-2'};
    expect(pickLspServer([ts, ts2], 'app.ts')?.name).toBe('typescript');
  });
});
