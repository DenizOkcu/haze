import fs from 'node:fs/promises';
import path from 'node:path';
import {HAZE_DIR} from './paths.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export async function ensurePrivateDir(dir: string): Promise<void> {
  const absolute = path.resolve(dir);
  await fs.mkdir(absolute, {recursive: true, mode: DIRECTORY_MODE});
  if (process.platform === 'win32') return;
  const hazeRoot = path.resolve(HAZE_DIR);
  const relative = path.relative(hazeRoot, absolute);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    await fs.chmod(hazeRoot, DIRECTORY_MODE);
    let current = hazeRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      await fs.chmod(current, DIRECTORY_MODE);
    }
    return;
  }
  await fs.chmod(absolute, DIRECTORY_MODE);
}

export async function ensurePrivateFile(file: string): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  const handle = await fs.open(file, 'a', FILE_MODE);
  await handle.close();
  if (process.platform !== 'win32') await fs.chmod(file, FILE_MODE);
}

export async function tightenPrivateFile(file: string): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  if (process.platform !== 'win32') await fs.chmod(file, FILE_MODE);
}

export async function appendPrivateFile(file: string, content: string): Promise<void> {
  await ensurePrivateFile(file);
  await fs.appendFile(file, content, {encoding: 'utf8', mode: FILE_MODE});
}

export async function writePrivateFileAtomic(file: string, content: string): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temp, 'wx', FILE_MODE);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, file);
    if (process.platform !== 'win32') await fs.chmod(file, FILE_MODE);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temp, {force: true}).catch(() => undefined);
  }
}

export async function writePrivateJsonAtomic(file: string, value: unknown): Promise<void> {
  await writePrivateFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}
