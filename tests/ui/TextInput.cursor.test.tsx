import React from 'react';
import {Box, Static, Text} from 'ink';
import {describe, expect, it} from 'vitest';
import {DynamicFrame} from '../../src/cli/chat/DynamicFrame.js';
import {TextInput} from '../../src/ui/components/TextInput.js';
import {inkHarness} from '../inkHarness.js';

/**
 * Minimal VT emulator covering the sequences Ink's log-update emits
 * (cursorUp/Down/To, erase line/display, next line, show/hide, sync markers).
 * Tracks the final hardware cursor cell so cursor-position regressions are
 * asserted against real escape output, not component internals.
 */
export class MiniTerminal {
  lines: string[][] = [[]];
  row = 0;
  col = 0;

  write(text: string) {
    let index = 0;
    while (index < text.length) {
      const char = text[index]!;
      if (char === '\u001b') {
        const match = /^\u001b\[([0-9;?]*)([A-Za-z])/.exec(text.slice(index));
        if (match) {
          this.control(match[1] ?? '', match[2]!);
          index += match[0].length;
          continue;
        }
        index += 1;
        continue;
      }
      if (char === '\n') {
        this.row += 1;
        this.ensureRow(this.row);
        index += 1;
        continue;
      }
      if (char === '\r') {
        this.col = 0;
        index += 1;
        continue;
      }
      const codePoint = String.fromCodePoint(text.codePointAt(index)!);
      this.put(codePoint);
      index += codePoint.length;
    }
  }

  lineText(row: number) {
    return (this.lines[row] ?? []).join('');
  }

  cursorLineText() {
    return this.lineText(this.row);
  }

  private control(parameters: string, final: string) {
    // A/B/G/E take a repeat count defaulting to 1; J/K take an erase mode
    // defaulting to 0 (cursor-to-end), so `ESC[K` clears the line tail.
    const raw = parameters === '' || parameters.startsWith('?') ? undefined : Number.parseInt(parameters, 10);
    const count = raw || 1;
    const mode = raw ?? 0;
    switch (final) {
      case 'A': this.row = Math.max(0, this.row - count); break;
      case 'B': this.row += count; this.ensureRow(this.row); break;
      case 'G': this.col = Math.max(0, count - 1); break;
      case 'E': this.row += count; this.ensureRow(this.row); this.col = 0; break;
      case 'J': this.eraseDisplay(mode); break;
      case 'K': this.eraseLine(mode); break;
      default: break; // show/hide cursor, sync markers, and unused modes are stateless here
    }
  }

  private eraseDisplay(mode: number) {
    if (mode === 2 || mode === 3) {
      this.lines = [[]];
      this.row = 0;
      this.col = 0;
      return;
    }
    const current = this.lines[this.row];
    if (current) current.length = Math.min(current.length, this.col);
    this.lines.length = this.row + 1;
  }

  private eraseLine(mode: number) {
    const line = this.lines[this.row] ?? [];
    if (mode === 2) {
      line.length = 0;
    } else if (mode === 1) {
      for (let index = 0; index <= this.col && index < line.length; index += 1) line[index] = ' ';
    } else {
      line.length = Math.min(line.length, this.col);
    }
    this.lines[this.row] = line;
  }

  private put(codePoint: string) {
    const line = this.lines[this.row] ?? [];
    while (line.length < this.col) line.push(' ');
    line[this.col] = codePoint;
    this.col += 1;
    this.lines[this.row] = line;
  }

  private ensureRow(row: number) {
    while (this.lines.length <= row) this.lines.push([]);
  }
}

function renderChatFixture() {
  const suggestions = Array.from({length: 8}, (_, index) => ({value: `choice-${index}`, kind: 'command' as const}));
  function Fixture() {
    return <Box flexDirection="column" paddingX={1}>
      <Static items={[{key: 'history', text: 'history-line'}]}>{item => <Text key={item.key}>{item.text}</Text>}</Static>
      <DynamicFrame rows={24} columns={78} sections={{status: <Text>status</Text>}}
        input={limits => <TextInput width={limits.width} inputRows={limits.inputRows} suggestionRows={limits.suggestionRows}
          onRowsChange={limits.onRowsChange} suggestions={suggestions} suggestionMode="always" onSubmit={() => {}} />}/>
    </Box>;
  }
  return inkHarness(<Fixture />);
}

function terminalFromWrites(writes: string[]) {
  const terminal = new MiniTerminal();
  terminal.write(writes.join(''));
  return terminal;
}

describe('TextInput terminal cursor', () => {
  const snapshot = (writes: string[]) => {
    const terminal = terminalFromWrites(writes);
    const inputRow = terminal.lines.findIndex(line => line.join('').includes('Type a message'));
    return {inputRow, row: terminal.row, col: terminal.col, text: terminal.cursorLineText(),
      above: inputRow > 0 ? terminal.lineText(inputRow - 1) : ''};
  };

  it('places the hardware cursor on the input line, not above it', async () => {
    const fixture = renderChatFixture();
    try {
      await fixture.app.waitUntilRenderFlush();
      // The frame nests the input inside border + padding below suggestion rows
      // (like the chat screen). The hardware cursor must sit on the input row
      // itself, on the placeholder's inverse cell: outer padding 1 + border 1 +
      // inner padding 1 + '› ' prefix 2 = column 5. The parent-relative metrics
      // this guards against landed one row up on the border, columns behind.
      await expect.poll(() => {
        const state = snapshot(fixture.stdout.writes);
        return state.inputRow > 0 && state.row === state.inputRow && state.col === 5
          && state.above.includes('choice-');
      }).toBe(true);

      fixture.stdout.writes.length = 0;
      fixture.stdin.write('ab');
      await fixture.app.waitUntilRenderFlush();
      // Two typed cells move the editing point from column 5 to 7 on the input row.
      await expect.poll(() => {
        const state = snapshot(fixture.stdout.writes);
        return state.row >= 0 && state.col === 7 && state.text.includes('ab');
      }).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
