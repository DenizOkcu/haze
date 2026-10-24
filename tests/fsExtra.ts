// fs-extra-shaped facade over Node built-ins plus the small helpers from
// src/utils/fs.ts, so the test suite does not depend on the removed package.
// Promise APIs win over same-named sync ones (matching fs-extra's export shape).
import fsSync from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {ensureDir, move, pathExists, readJson, remove} from '../src/utils/fs.js';

/** Create parent directories, then write the file (string or bytes, default utf8). */
async function outputFile(file: string, data: string | Uint8Array): Promise<void> {
  await fsPromises.mkdir(path.dirname(file), {recursive: true});
  await fsPromises.writeFile(file, data);
}

/** Serialize JSON with optional indentation and write it, creating parent directories. */
function writeJson(file: string, value: unknown, options?: {spaces?: number | string}): Promise<void> {
  return outputFile(file, JSON.stringify(value, null, options?.spaces));
}

/** Create the file (and parents) if missing; existing files are left untouched. */
async function ensureFile(file: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(file), {recursive: true});
  try {
    await fsPromises.writeFile(file, '', {flag: 'wx'});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Delete a directory's contents but keep the directory itself. */
async function emptyDir(dir: string): Promise<void> {
  for (const entry of await fsPromises.readdir(dir)) {
    await fsPromises.rm(path.join(dir, entry), {recursive: true, force: true});
  }
}

type FsFacade = typeof fsSync & typeof fsPromises & {
  pathExists: typeof pathExists;
  readJson: typeof readJson;
  ensureDir: typeof ensureDir;
  remove: typeof remove;
  move: typeof move;
  outputFile: typeof outputFile;
  writeJson: typeof writeJson;
  outputJson: typeof writeJson;
  ensureFile: typeof ensureFile;
  emptyDir: typeof emptyDir;
};

const fs = {
  ...fsSync,
  ...fsPromises,
  pathExists,
  readJson,
  ensureDir,
  remove,
  move,
  outputFile,
  writeJson,
  outputJson: writeJson,
  ensureFile,
  emptyDir,
} as FsFacade;

export default fs;
