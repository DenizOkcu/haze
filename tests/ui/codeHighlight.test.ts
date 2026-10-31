import {describe, expect, it} from 'vitest';
import stripAnsi from 'strip-ansi';
import {highlightedCodeLine, languageForPath} from '../../src/ui/codeHighlight.js';

describe('languageForPath', () => {
  it('maps known extensions and aliases to highlight.js languages', () => {
    expect(languageForPath('src/app.ts')).toBe('typescript');
    expect(languageForPath('script.cjs')).toBe('javascript');
    expect(languageForPath('deploy.yml')).toBe('yaml');
    expect(languageForPath('README')).toBeUndefined();
  });
});

describe('highlightedCodeLine terminal-control sanitization (R2-HZ-4)', () => {
  it('strips OSC 52 / CSI / 8-bit C1 from the source line while keeping its own styling', () => {
    const line = `printf '\x1b]52;c;aGVsbG8=\x07' && \u009b31mecho done`;
    const rendered = highlightedCodeLine(line, 80, 'sh');
    expect(rendered).not.toContain('\x1b]52');
    expect(rendered).not.toContain('aGVsbG8=');
    expect(rendered).not.toContain('\u009b');
    const visible = stripAnsi(rendered);
    expect(visible).toContain("printf ''");
    expect(visible).toContain('echo done');
  });

  it('keeps highlight-generated SGR styling for clean input', () => {
    const rendered = highlightedCodeLine('const value = 1;', 60, 'ts');
    expect(stripAnsi(rendered)).toContain('const value = 1;');
    // The module's own 24-bit color styling survives (input had nothing to strip).
    expect(rendered).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
  });
});
