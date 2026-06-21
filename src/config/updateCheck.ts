import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'fs-extra';
import path from 'node:path';
import {HAZE_DIR} from './paths.js';
import {isNewer} from '../utils/version.js';

const execFile = promisify(execFileCallback);

export const UPDATE_CHECK_FILE = path.join(HAZE_DIR, 'updateCheck.json');
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_TIMEOUT_MS = 5000;

export interface UpdateCheckResult {
  latestVersion: string;
  isOutdated: boolean;
  checkedAt: number;
}

interface UpdateCheckStore {
  checkedAt?: number;
  latestVersion?: string;
}

/**
 * Resolves the latest published version of a package. Defaults to shelling out
 * to `npm view <pkg> version` so proxies/scopes/private registries from the
 * user's `.npmrc` are respected. Injectable for deterministic tests.
 */
export type ExecVersionFn = (packageName: string, options: {timeout: number}) => Promise<string>;

async function defaultExecVersion(packageName: string, options: {timeout: number}): Promise<string> {
  const {stdout} = await execFile('npm', ['view', packageName, 'version'], {timeout: options.timeout});
  return stdout;
}

async function defaultReadStore(file: string): Promise<UpdateCheckStore> {
  return fs.readJson(file).catch(() => ({}));
}

async function defaultWriteStore(file: string, store: UpdateCheckStore): Promise<void> {
  await fs.ensureDir(path.dirname(file));
  await fs.writeJson(file, store, {spaces: 2});
}

/**
 * Non-blockingly check whether a newer version of `packageName` is published.
 *
 * Throttled by a small JSON store (`~/.haze/updateCheck.json`) so we hit the
 * registry at most once per `intervalMs`. Within the window, the cached
 * `latestVersion` is reused (and recompared against `currentVersion` so a user
 * who updates without clearing the cache still gets correct status).
 *
 * Every failure mode (no npm, offline, timeout, 404, malformed output, store
 * read/write error) resolves to `undefined` — the caller never sees an error.
 *
 * Everything except `currentVersion` and `packageName` is injectable so the
 * spawn/timeout/throttle logic is testable without network or the filesystem.
 */
export async function checkForUpdate(input: {
  currentVersion: string;
  packageName: string;
  now?: number;
  intervalMs?: number;
  timeoutMs?: number;
  storePath?: string;
  exec?: ExecVersionFn;
  readStoreFn?: (file: string) => Promise<UpdateCheckStore>;
  writeStoreFn?: (file: string, store: UpdateCheckStore) => Promise<void>;
}): Promise<UpdateCheckResult | undefined> {
  const now = input.now ?? Date.now();
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const storePath = input.storePath ?? UPDATE_CHECK_FILE;
  const exec = input.exec ?? defaultExecVersion;
  const readStoreFn = input.readStoreFn ?? defaultReadStore;
  const writeStoreFn = input.writeStoreFn ?? defaultWriteStore;

  let store: UpdateCheckStore;
  try {
    store = await readStoreFn(storePath);
  } catch {
    store = {};
  }

  // Within the throttle window: reuse the cached latestVersion without spawning npm.
  if (
    typeof store.checkedAt === 'number' &&
    typeof store.latestVersion === 'string' &&
    now - store.checkedAt < intervalMs
  ) {
    return {
      latestVersion: store.latestVersion,
      isOutdated: isNewer(store.latestVersion, input.currentVersion),
      checkedAt: store.checkedAt,
    };
  }

  let latestVersion: string;
  try {
    const raw = await exec(input.packageName, {timeout: timeoutMs});
    latestVersion = (raw.split(/\r?\n/)[0] ?? '').trim();
  } catch {
    return undefined;
  }
  if (!latestVersion) return undefined;

  const checkedAt = now;
  try {
    await writeStoreFn(storePath, {checkedAt, latestVersion});
  } catch {
    // Store write failure is non-fatal; we still report the fresh result.
  }

  return {
    latestVersion,
    isOutdated: isNewer(latestVersion, input.currentVersion),
    checkedAt,
  };
}
