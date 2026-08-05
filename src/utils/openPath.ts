import {spawn} from 'node:child_process';

/** Open a file or URL with the platform default handler. Tests mock this module. */
export function openPath(target: string): Promise<boolean> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  return new Promise(resolve => {
    const child = spawn(command, args, {stdio: 'ignore', detached: true, windowsHide: true});
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
