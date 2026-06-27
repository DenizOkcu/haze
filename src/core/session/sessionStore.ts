import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import type {ModelMessage} from 'ai';
import {HAZE_DIR} from '../../config/paths.js';
import type {WorkState} from '../agent/workState.js';

export type SessionEntry =
  | {type: 'header'; id: string; cwd: string; createdAt: string; hazeVersion?: string}
  | {type: 'ui_message'; at: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string}
  | {type: 'conversation_snapshot'; at: string; messages: ModelMessage[]}
  | {type: 'work_state_snapshot'; at: string; state: WorkState}
  | {type: 'event'; at: string; name: string; text?: string};

export interface HazeSession {
  id: string;
  file: string;
  cwd: string;
}

const DEFAULT_SESSIONS_DIR = path.join(HAZE_DIR, 'sessions');

function cwdHash(cwd = process.cwd()) {
  return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

function sessionDir(cwd = process.cwd(), sessionsDir = DEFAULT_SESSIONS_DIR) {
  return path.join(sessionsDir, cwdHash(cwd));
}

function sessionFile(id: string, cwd = process.cwd(), sessionsDir = DEFAULT_SESSIONS_DIR) {
  return path.join(sessionDir(cwd, sessionsDir), `${id}.jsonl`);
}

function newSessionId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

export async function createSession(options: {cwd?: string; hazeVersion?: string; sessionsDir?: string} = {}): Promise<HazeSession> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const id = newSessionId();
  const file = sessionFile(id, cwd, options.sessionsDir);
  await fs.ensureDir(path.dirname(file));
  await appendSessionEntry({id, file, cwd}, {type: 'header', id, cwd, createdAt: new Date().toISOString(), hazeVersion: options.hazeVersion});
  return {id, file, cwd};
}

export async function latestSession(cwd = process.cwd(), sessionsDir = DEFAULT_SESSIONS_DIR): Promise<HazeSession | undefined> {
  const dir = sessionDir(cwd, sessionsDir);
  const files = (await fs.readdir(dir).catch(() => []))
    .filter(file => file.endsWith('.jsonl'))
    .sort();
  const latest = files.at(-1);
  if (!latest) return undefined;
  const id = path.basename(latest, '.jsonl');
  return {id, file: path.join(dir, latest), cwd: path.resolve(cwd)};
}

export async function appendSessionEntry(session: HazeSession, entry: SessionEntry): Promise<void> {
  await fs.ensureDir(path.dirname(session.file));
  await fs.appendFile(session.file, `${JSON.stringify(entry)}\n`, 'utf8');
}

export interface ReadSessionEntriesResult {
  entries: SessionEntry[];
  /** Per-line parse failures, e.g. `Line 3: Unexpected token...`. Empty when every line parsed. */
  parseErrors: string[];
}

/**
 * Read a session file and parse each non-empty line as a JSONL entry.
 *
 * Malformed lines are not silently discarded: they are reported in
 * `parseErrors` (with their 1-based line number) so callers can surface the
 * loss in debug mode instead of silently dropping messages.
 */
export async function readSessionEntries(session: HazeSession): Promise<ReadSessionEntriesResult> {
  const raw = await fs.readFile(session.file, 'utf8');
  const entries: SessionEntry[] = [];
  const parseErrors: string[] = [];
  // Number by true file position: a stray blank line (e.g. from corruption) must not shift
  // the reported line number away from where the malformed line actually sits.
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue; // skip blank lines (e.g. the trailing newline)
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch (error) {
      parseErrors.push(`Line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {entries, parseErrors};
}

export interface RestoreConversationResult {
  messages: ModelMessage[];
  parseErrors: string[];
}

export async function restoreConversation(session: HazeSession): Promise<RestoreConversationResult> {
  const {entries, parseErrors} = await readSessionEntries(session);
  const snapshots = entries.filter((entry): entry is Extract<SessionEntry, {type: 'conversation_snapshot'}> => entry.type === 'conversation_snapshot');
  return {messages: snapshots.at(-1)?.messages ?? [], parseErrors};
}

export interface RestoreWorkStateResult {
  state: WorkState | undefined;
  parseErrors: string[];
}

export async function restoreWorkState(session: HazeSession): Promise<RestoreWorkStateResult> {
  const {entries, parseErrors} = await readSessionEntries(session);
  const snapshots = entries.filter((entry): entry is Extract<SessionEntry, {type: 'work_state_snapshot'}> => entry.type === 'work_state_snapshot');
  return {state: snapshots.at(-1)?.state, parseErrors};
}

export function formatSession(session: HazeSession) {
  return `${session.id} · ${session.file}`;
}
