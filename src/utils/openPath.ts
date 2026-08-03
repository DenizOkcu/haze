import {spawn} from 'node:child_process';

/** Open a file with the platform default handler. Tests mock this module. */
export function openPath(filePath: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', filePath] : [filePath];
  const child = spawn(command, args, {stdio: 'ignore', detached: true});
  child.on('error', () => undefined);
  child.unref();
}
