import React from 'react';
import {Box, Static, Text} from 'ink';
import {render} from 'ink-testing-library';
import {expect, it} from 'vitest';

it('keeps a deterministic long transcript ordered across tail updates and finalization', async () => {
  const history = Array.from({length: 100}, (_, index) => `history-${index}`);
  function Fixture({tail, done = false}: {tail: string; done?: boolean}) {
    return <Box flexDirection="column">
      <Static items={done ? [...history, tail] : history}>{text => <Text key={text}>{text}</Text>}</Static>
      {!done && <Text>{tail}</Text>}
    </Box>;
  }
  const app = render(<Fixture tail="stream-start" />);
  try {
    await expect.poll(() => app.lastFrame()).toContain('stream-start');
    app.rerender(<Fixture tail="stream-end" />);
    await expect.poll(() => app.lastFrame()).toContain('stream-end');
    app.rerender(<Fixture tail="stream-end" done />);
    await expect.poll(() => app.stdout.frames.join('')).toContain('history-99');
    const output = app.stdout.frames.join('');
    expect(output.indexOf('history-0')).toBeLessThan(output.indexOf('history-99'));
    expect(app.lastFrame()?.match(/history-99/g)).toHaveLength(1);
    expect(output).not.toContain('\x1b[3J');
  } finally {
    app.unmount();
    app.cleanup();
  }
});

// Unlike testing-library's debug frames, these assertions inspect actual writes.
import {PassThrough} from 'node:stream';
import {render as inkRender} from 'ink';
import {inkHarness} from '../inkHarness.js';

it('renders generic non-TTY streams without raw mode and writes the final frame', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  stdout.on('data', chunk => { output += String(chunk); });
  const app = inkRender(<Text>generic stream</Text>, {stdin, stdout, stderr, patchConsole: false});
  try {
    await app.waitUntilRenderFlush();
    app.unmount();
    await app.waitUntilExit();
    expect(output).toContain('generic stream');
    expect(output).not.toContain('\x1b[3J');
  } finally {
    app.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy();
  }
});

it('writes Static history once across real incremental renders and resize', async () => {
  function Fixture({tail}: {tail: string}) {
    return <Box flexDirection="column">
      <Static items={Array.from({length: 100}, (_, index) => `record-${index}`)}>
        {text => <Text key={text}>{text}</Text>}
      </Static>
      <Text>{tail}</Text>
    </Box>;
  }
  const fixture = inkHarness(<Fixture tail="first" />);
  try {
    await fixture.app.waitUntilRenderFlush();
    fixture.app.rerender(<Fixture tail="second" />);
    await fixture.app.waitUntilRenderFlush();
    fixture.stdout.resize(40, 12);
    fixture.app.rerender(<Fixture tail="third" />);
    await fixture.app.waitUntilRenderFlush();
    const output = fixture.stdout.writes.join('');
    expect(output.match(/record-99/g)).toHaveLength(1);
    expect(output.indexOf('record-0')).toBeLessThan(output.indexOf('record-99'));
    expect(output).not.toContain('\x1b[3J');
  } finally { await fixture.close(); }
});
