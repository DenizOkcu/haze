import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {HAZE_DIR} from './paths.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export async function ensurePrivateDir(dir: string): Promise<void> {
  const absolute = path.resolve(dir);
  await fs.mkdir(absolute, {recursive: true, mode: DIRECTORY_MODE});
  if (process.platform === 'win32') return;
  // Walk every ancestor under ~/.haze and chmod each one. Per-ancestor calls
  // are necessary because mkdir's mode only applies to leaves created by this
  // call — pre-existing ancestors may have permissive umask-derived modes.
  // Cost: O(depth) syscalls per ensure. Session append paths are amortized by
  // the caller batching writes; do not add a per-call cache without one.
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
  // Crypto-random suffix (not Math.random) so a same-user attacker cannot win a
  // temp-file race on platforms where the private dir is not strictly 0700
  // (Windows relies on inherited ACLs from the user profile).
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temp, 'wx', FILE_MODE);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameAtomic(temp, file);
    if (process.platform !== 'win32') await fs.chmod(file, FILE_MODE);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temp, {force: true}).catch(() => undefined);
  }
}

async function renameAtomic(temp: string, target: string): Promise<void> {
  // POSIX rename is atomic. On Windows, rename over an existing file fails
  // with EPERM when the target is held open by another process (e.g., a second
  // haze instance reading auth.json). Retry by unlinking the target first.
  try {
    await fs.rename(temp, target);
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      await fs.unlink(target).catch(() => undefined);
      await fs.rename(temp, target);
    } else {
      throw error;
    }
  }
}

export async function writePrivateJsonAtomic(file: string, value: unknown): Promise<void> {
  await writePrivateFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}
