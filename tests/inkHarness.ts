import {PassThrough, Writable} from 'node:stream';
import {render, type RenderOptions} from 'ink';
import type {ReactNode} from 'react';

/** Capability-correct streams, not a cast to process.stdin/stdout. No emulator claims. */
export class FixtureInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(raw: boolean) { this.isRaw = raw; return this; }
  ref() { return this; }
  unref() { return this; }
}
export class FixtureOutput extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  writes: string[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.writes.push(chunk.toString());
    callback();
  }
  resize(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}
export function inkHarness(node: ReactNode, options: RenderOptions = {}) {
  const stdin = new FixtureInput();
  const stdout = new FixtureOutput();
  const stderr = new FixtureOutput();
  const app = render(node, {stdin, stdout, stderr, interactive: true, patchConsole: false,
    exitOnCtrlC: false, incrementalRendering: true, maxFps: 15, ...options});
  return {app, stdin, stdout, stderr, async close() {
    app.unmount();
    await app.waitUntilExit();
    app.cleanup();
    stdin.destroy(); stdout.destroy(); stderr.destroy();
  }};
}
