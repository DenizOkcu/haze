import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

const MAX_LOG_BYTES = 50 * 1024 * 1024;
const LOG_TAIL_LINES = 10_000;
const SESSION_RETENTION_DAYS = 30;

function hazeDir() {
  return process.env.HAZE_DIR ? path.resolve(process.env.HAZE_DIR) : path.join(os.homedir(), '.haze');
}

export interface SanityResult {
  action: string;
  detail: string;
}

async function listLogs() {
  const dir = path.join(hazeDir(), 'logs');
  await fs.ensureDir(dir);
  const names = await fs.readdir(dir);
  const logs: Array<{id: string; file: string; size: number}> = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) continue;
    logs.push({id: name.replace(/\.jsonl$/, ''), file, size: stat.size});
  }
  return logs;
}

async function rotateOversizedLogs(): Promise<SanityResult[]> {
  const results: SanityResult[] = [];
  const logs = await listLogs();
  for (const log of logs) {
    if (log.size <= MAX_LOG_BYTES) continue;
    const raw = await fs.readFile(log.file, 'utf8');
    const tail = raw.split('\n').slice(-LOG_TAIL_LINES).join('\n');
    await fs.writeFile(log.file, tail, 'utf8');
    results.push({
      action: 'rotated log',
      detail: `${log.id} was ${log.size} bytes; kept last ${LOG_TAIL_LINES} lines`,
    });
  }
  return results;
}

async function pruneOldSessions(): Promise<SanityResult[]> {
  const results: SanityResult[] = [];
  const sessionsDir = path.join(hazeDir(), 'sessions');
  if (!(await fs.pathExists(sessionsDir))) return results;
  const cutoff = Date.now() - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const workspaceDirs = await fs.readdir(sessionsDir);
  for (const workspaceDir of workspaceDirs) {
    const dir = path.join(sessionsDir, workspaceDir);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const files = await fs.readdir(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const fileStat = await fs.stat(filePath).catch(() => null);
      if (!fileStat) continue;
      if (fileStat.mtime.getTime() < cutoff) {
        await fs.remove(filePath);
        results.push({action: 'pruned session', detail: filePath});
      }
    }
  }
  return results;
}

export async function runStartupSanity(): Promise<SanityResult[]> {
  const results: SanityResult[] = [];
  results.push(...(await rotateOversizedLogs()));
  results.push(...(await pruneOldSessions()));
  return results;
}
