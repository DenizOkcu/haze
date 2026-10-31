import {describe, expect, it} from 'vitest';
import React from 'react';
import {Text} from 'ink';
import {stripTerminalControlSequences} from '../../src/ui/terminalSanitize.js';
import {inkHarness} from '../inkHarness.js';

const OSC_52 = '\x1b]52;c;AAAA\x07'; // clipboard write (BEL-terminated)
const OSC_8 = '\x1b]8;;https://evil.example\x1b\\click here\x1b]8;;\x1b\\'; // hyperlink spoofing (ST-terminated)

describe('stripTerminalControlSequences', () => {
  it('removes OSC 52 clipboard-write sequences (BEL-terminated)', () => {
    expect(stripTerminalControlSequences(`const a = 1; ${OSC_52} const b = 2;`)).toBe('const a = 1;  const b = 2;');
  });

  it('removes OSC 8 hyperlink sequences (ST-terminated)', () => {
    expect(stripTerminalControlSequences(`see ${OSC_8} for details`)).toBe('see click here for details');
  });

  it('removes CSI color/cursor sequences', () => {
    expect(stripTerminalControlSequences('\x1b[31mred\x1b[0m and \x1b[2Jcleared')).toBe('red and cleared');
  });

  it('removes DCS, APC, and PM sequences', () => {
    expect(stripTerminalControlSequences('a\x1bP1;2q data\x1b\\b')).toBe('ab');
    expect(stripTerminalControlSequences('a\x1b_x\x1b\\b')).toBe('ab');
    expect(stripTerminalControlSequences('a\x1b^y\x07b')).toBe('ab');
  });

  it('removes other C0 control bytes but keeps newline and tab', () => {
    expect(stripTerminalControlSequences('a\x00b\x01c\x0bd\x0ce\x0ff\rg')).toBe('abcdefg');
    expect(stripTerminalControlSequences('keep\nnewlines\tand tabs')).toBe('keep\nnewlines\tand tabs');
  });

  it('drops a trailing lone ESC and charset-designator escapes', () => {
    expect(stripTerminalControlSequences('abc\x1b')).toBe('abc');
    expect(stripTerminalControlSequences('a\x1b(Bb')).toBe('ab');
  });

  it('strips 8-bit C1 CSI sequences (no ESC byte needed)', () => {
    expect(stripTerminalControlSequences('a\u009b31mRED\u009b0mb')).toBe('aREDb');
    expect(stripTerminalControlSequences('\u009b2Jclear')).toBe('clear');
  });

  it('strips C1 OSC 52 clipboard writes with BEL, ESC \\, and C1 ST terminators', () => {
    expect(stripTerminalControlSequences(`a \u009d52;c;AAAA\u0007 b`)).toBe('a  b');
    expect(stripTerminalControlSequences(`a \u009d52;c;AAAA\u001b\\ b`)).toBe('a  b');
    expect(stripTerminalControlSequences(`a \u009d52;c;AAAA\u009c b`)).toBe('a  b');
  });

  it('strips C1 DCS, PM, and SOS string sequences', () => {
    expect(stripTerminalControlSequences('a\u00901;2q data\u009cb')).toBe('ab');
    expect(stripTerminalControlSequences('a\u009ey\u0007b')).toBe('ab');
    expect(stripTerminalControlSequences('a\u009fz\u001b\\b')).toBe('ab');
  });

  it('strips remaining C1 controls outright, leaving other Unicode intact', () => {
    expect(stripTerminalControlSequences('a\u0085b\u0081c\u009cd\u0088')).toBe('abcd');
    expect(stripTerminalControlSequences('ünïcödé ✓ 中文')).toBe('ünïcödé ✓ 中文');
  });

  it('leaves plain text unchanged', () => {
    const plain = 'const value = "unsafe <script>"; ünïcödé ✓';
    expect(stripTerminalControlSequences(plain)).toBe(plain);
  });
});

describe('Ink terminal-control passthrough (empirical premise for HZA-3)', () => {
  // Empirical findings against the project's Ink version (probe 2026-10-31):
  // CSI sequences (e.g. \x1b[31m) and ST-terminated OSC sequences (e.g. OSC 8
  // hyperlinks) pass through <Text> children to stdout verbatim, so a file
  // line rendered in an edit preview can inject them. BEL-terminated OSC 52
  // was observed suppressed by Ink itself in this version; the sink stripper
  // covers it regardless (defense in depth — do not rely on Ink internals).
  it('Ink passes embedded CSI and OSC 8 (ST-terminated) sequences through to stdout', async () => {
    const csi = 'a \x1b[31mRED\x1b[0m b';
    const hyperlink = `see ${OSC_8} for details`;
    const {stdout, close} = inkHarness(
      <Text>{`${csi}\n${hyperlink}`}</Text>,
    );
    try {
      await new Promise(resolve => setTimeout(resolve, 60));
      const written = stdout.writes.join('');
      expect(written).toContain('\x1b[31m');
      expect(written).toContain(']8;;https://evil.example');
    } finally {
      await close();
    }
  });
});
