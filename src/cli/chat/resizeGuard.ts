/** Minimal TTY stdout shape for the resize guard (tests pass a fake stream). */
export interface ResizeGuardStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
  write(chunk: string): unknown;
}

const HOME_AND_ERASE_DOWN = '\u001B[H\u001B[J';

/**
 * Clear the viewport on width changes before Ink's resize repaint. Pair this
 * with a width-keyed <Static> in ChatScreen: clearing alone loses the visible
 * transcript, whereas remounting Static re-renders the history and Markdown
 * at the new width. The dynamic input stays mounted to preserve its draft.
 *
 * Register before render() so this listener precedes Ink's resize handler.
 * This does not erase terminal scrollback; replay can leave earlier copies
 * of the transcript there.
 */
export function installViewportResizeGuard(stream: ResizeGuardStream = process.stdout): () => void {
  if (!stream.isTTY) return () => undefined;
  let previousColumns = stream.columns;
  const onResize = () => {
    const {columns} = stream;
    if (typeof columns === 'number' && columns !== previousColumns) {
      stream.write(HOME_AND_ERASE_DOWN);
    }
    previousColumns = columns;
  };
  stream.on('resize', onResize);
  return () => { stream.off('resize', onResize); };
}
