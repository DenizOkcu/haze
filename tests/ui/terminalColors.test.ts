import {describe, expect, it} from 'vitest';
import {applyTerminalColors, resetTerminalColors, type TerminalColorStream} from '../../src/ui/terminalColors.js';

function fakeStream(isTTY: boolean): {stream: TerminalColorStream; writes: string[]} {
  const writes: string[] = [];
  return {stream: {write: (chunk: string) => writes.push(chunk), isTTY}, writes};
}

describe('applyTerminalColors (OSC 10 + 11)', () => {
  it('emits paired foreground/background sequences with rgb: parts on a TTY', () => {
    const {stream, writes} = fakeStream(true);
    applyTerminalColors('#657B83', '#FDF6E3', stream); // solarized-light pair
    expect(writes).toEqual([
      '\u001B]10;rgb:65/7b/83\u0007',
      '\u001B]11;rgb:fd/f6/e3\u0007',
    ]);
  });

  it('emits nothing off-TTY (piped output must stay clean)', () => {
    const {stream, writes} = fakeStream(false);
    applyTerminalColors('#657b83', '#fdf6e3', stream);
    expect(writes).toEqual([]);
  });

  it('skips malformed parts but still emits valid ones (never garbage sequences)', () => {
    const {stream, writes} = fakeStream(true);
    applyTerminalColors('white', '#fdf6e3', stream);
    expect(writes).toEqual(['\u001B]11;rgb:fd/f6/e3\u0007']);
    const second = fakeStream(true);
    applyTerminalColors('#657b83', '#12345', second.stream);
    expect(second.writes).toEqual(['\u001B]10;rgb:65/7b/83\u0007']);
    const third = fakeStream(true);
    applyTerminalColors('', '', third.stream);
    expect(third.writes).toEqual([]);
  });
});

describe('resetTerminalColors (OSC 110 + 111)', () => {
  it('restores both terminal defaults on a TTY', () => {
    const {stream, writes} = fakeStream(true);
    resetTerminalColors(stream);
    expect(writes).toEqual(['\u001B]110\u0007', '\u001B]111\u0007']);
  });

  it('emits nothing off-TTY', () => {
    const {stream, writes} = fakeStream(false);
    resetTerminalColors(stream);
    expect(writes).toEqual([]);
  });
});
