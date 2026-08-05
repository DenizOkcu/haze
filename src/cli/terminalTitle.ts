import {basename} from 'node:path';

/**
 * Terminal tab/window title for interactive runs. Uses the OSC 0 escape
 * sequence, understood by xterm-compatible terminals (Terminal.app, iTerm2,
 * VS Code, etc.). Guarded to real TTYs so piped/redirected output is never
 * polluted, and cleared on exit so the tab falls back to the shell's own
 * naming instead of showing a stale haze title.
 */

function titleEscape(label: string): string {
  return `\u001B]0;${label}\u0007`;
}

export function terminalTitleLabel(cwd: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point here.
  const dir = basename(cwd).replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
  return `haze${dir ? ` - ${dir}` : ''}`;
}

/**
 * Set the terminal title for the duration of this run. No-op when stdout is
 * not a TTY (headless, piped, or redirected runs).
 */
export function installTerminalTitle(label: string): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(titleEscape(label));
  process.once('exit', () => {
    // Re-check at exit time: the terminal may no longer be attached.
    if (!process.stdout.isTTY) return;
    try {
      process.stdout.write(titleEscape(''));
    } catch {
      // Best effort only: title restoration must never break shutdown.
    }
  });
}
