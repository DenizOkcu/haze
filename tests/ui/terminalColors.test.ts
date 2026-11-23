import {describe, expect, it} from 'vitest';
import {applyTerminalColors, resetTerminalColors, type TerminalColorStream} from '../../src/ui/terminalColors.js';

function fakeStream(isTTY: boolean): {stream: TerminalColorStream; writes: string[]} {
  const writes: string[] = [];
  return {stream: {write: (chunk: string) => writes.push(chunk), isTTY}, writes};
}

const TRUECOLOR = {COLORTERM: 'truecolor'};

describe('applyTerminalColors (OSC 10 + 11)', () => {
  it('emits paired foreground/background sequences with rgb: parts on a truecolor TTY', () => {
    const {stream, writes} = fakeStream(true);
    applyTerminalColors('#657B83', '#FDF6E3', stream, TRUECOLOR); // solarized-light pair
    expect(writes).toEqual([
      '\u001B]10;rgb:65/7b/83\u0007',
      '\u001B]11;rgb:fd/f6/e3\u0007',
    ]);
  });

  it('emits nothing off-TTY (piped output must stay clean)', () => {
    const {stream, writes} = fakeStream(false);
    applyTerminalColors('#657b83', '#fdf6e3', stream, TRUECOLOR);
    expect(writes).toEqual([]);
  });

  it('emits nothing on a TTY without truecolor capability, under NO_COLOR, or with TERM=dumb (FE-13)', () => {
    for (const env of [{}, {COLORTERM: '256color'}, {NO_COLOR: '1', COLORTERM: 'truecolor'}, {TERM: 'dumb', COLORTERM: 'truecolor'}]) {
      const {stream, writes} = fakeStream(true);
      applyTerminalColors('#657b83', '#fdf6e3', stream, env);
      resetTerminalColors(stream, env);
      expect(writes).toEqual([]);
    }
    const forced = fakeStream(true);
    applyTerminalColors('#657b83', '#fdf6e3', forced.stream, {FORCE_COLOR: '1'});
    expect(forced.writes.length).toBe(2);
  });

  it('skips malformed parts but still emits valid ones (never garbage sequences)', () => {
    const {stream, writes} = fakeStream(true);
    applyTerminalColors('white', '#fdf6e3', stream, TRUECOLOR);
    expect(writes).toEqual(['\u001B]11;rgb:fd/f6/e3\u0007']);
    const second = fakeStream(true);
    applyTerminalColors('#657b83', '#12345', second.stream, TRUECOLOR);
    expect(second.writes).toEqual(['\u001B]10;rgb:65/7b/83\u0007']);
    const third = fakeStream(true);
    applyTerminalColors('', '', third.stream, TRUECOLOR);
    expect(third.writes).toEqual([]);
  });
});

describe('resetTerminalColors (OSC 110 + 111)', () => {
  it('restores both terminal defaults on a truecolor TTY', () => {
    const {stream, writes} = fakeStream(true);
    resetTerminalColors(stream, TRUECOLOR);
    expect(writes).toEqual(['\u001B]110\u0007', '\u001B]111\u0007']);
  });

  it('emits nothing off-TTY', () => {
    const {stream, writes} = fakeStream(false);
    resetTerminalColors(stream, TRUECOLOR);
    expect(writes).toEqual([]);
  });
});
