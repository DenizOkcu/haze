import {spawn} from 'node:child_process';

/** Open a file or URL with the platform default handler. Tests mock this module. */
export function openPath(target: string, onError?: (error: Error) => void): Promise<boolean> {
  // Darwin: `open`. POSIX/Linux: `xdg-open`. Windows: `cmd /c start <title> url` —
  // the empty string is the start command's title argument; without it, start
  // would treat a quoted URL as the window title.
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  return new Promise(resolve => {
    const child = spawn(command, args, {stdio: 'ignore', detached: true, windowsHide: true});
    child.once('error', error => {
      // Callers like the OAuth wizard print the URL regardless, so a non-opening
      // browser is recoverable; the optional callback lets debug builds log why.
      onError?.(error);
      resolve(false);
    });
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
