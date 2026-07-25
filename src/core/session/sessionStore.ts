import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import type {ModelMessage} from 'ai';
import {HAZE_DIR} from '../../config/paths.js';
import type {WorkState} from '../agent/workState.js';
import {prepareSessionEntryForWrite} from './sessionSlimming.js';
import {appendPrivateFile, ensurePrivateDir, tightenPrivateFile} from '../../config/privateStorage.js';
import {JSONL_LINE_BYTES} from '../limits/byteBudgets.js';
import {iterateBoundedUtf8Lines} from '../io/boundedRead.js';

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
  await ensurePrivateDir(path.dirname(file));
  await appendSessionEntry({id, file, cwd}, {type: 'header', id, cwd, createdAt: new Date().toISOString(), hazeVersion: options.hazeVersion});
  return {id, file, cwd};
}

export async function latestSession(cwd = process.cwd(), sessionsDir = DEFAULT_SESSIONS_DIR): Promise<HazeSession | undefined> {
  const dir = sessionDir(cwd, sessionsDir);
  await ensurePrivateDir(dir);
  const files = (await fs.readdir(dir).catch(() => []))
    .filter(file => file.endsWith('.jsonl'))
    .sort();
  const latest = files.at(-1);
  if (!latest) return undefined;
  const id = path.basename(latest, '.jsonl');
  return {id, file: path.join(dir, latest), cwd: path.resolve(cwd)};
}

export async function appendSessionEntry(session: HazeSession, entry: SessionEntry): Promise<void> {
  const prepared = prepareSessionEntryForWrite(entry);
  if (!prepared) return;
  await appendPrivateFile(session.file, `${JSON.stringify(prepared)}\n`);
}

export interface ReadSessionEntriesResult {
  entries: SessionEntry[];
  /** Per-line parse failures, e.g. `Line 3: Unexpected token...`. Empty when every line parsed. */
  parseErrors: string[];
}

const MAX_PARSE_ERRORS = 100;

async function scanSessionEntries(session: HazeSession, onEntry: (entry: SessionEntry) => void): Promise<string[]> {
  await tightenPrivateFile(session.file);
  const parseErrors: string[] = [];
  let omittedErrors = 0;
  const report = (message: string) => {
    if (parseErrors.length < MAX_PARSE_ERRORS) parseErrors.push(message);
    else omittedErrors++;
  };
  for await (const {line, lineNumber, oversized} of iterateBoundedUtf8Lines(session.file, JSONL_LINE_BYTES)) {
    if (!line && !oversized) continue;
    if (oversized) {
      report(`Line ${lineNumber}: exceeds ${JSONL_LINE_BYTES} byte limit`);
      continue;
    }
    try {
      onEntry(JSON.parse(line) as SessionEntry);
    } catch (error) {
      report(`Line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (omittedErrors > 0) parseErrors.push(`${omittedErrors} additional parse errors omitted.`);
  return parseErrors;
}

/**
 * Read a session file and parse each non-empty line as a JSONL entry.
 *
 * Malformed lines are not silently discarded: they are reported in
 * `parseErrors` (with their 1-based line number) so callers can surface the
 * loss in debug mode instead of silently dropping messages.
 */
export async function readSessionEntries(session: HazeSession): Promise<ReadSessionEntriesResult> {
  const entries: SessionEntry[] = [];
  const parseErrors = await scanSessionEntries(session, entry => entries.push(entry));
  return {entries, parseErrors};
}

export interface RestoreConversationResult {
  messages: ModelMessage[];
  parseErrors: string[];
}

export async function restoreConversation(session: HazeSession): Promise<RestoreConversationResult> {
  let messages: ModelMessage[] = [];
  const parseErrors = await scanSessionEntries(session, entry => {
    if (entry.type === 'conversation_snapshot') messages = entry.messages;
  });
  return {messages, parseErrors};
}

export interface RestoreWorkStateResult {
  state: WorkState | undefined;
  parseErrors: string[];
}

export async function restoreWorkState(session: HazeSession): Promise<RestoreWorkStateResult> {
  let state: WorkState | undefined;
  const parseErrors = await scanSessionEntries(session, entry => {
    if (entry.type === 'work_state_snapshot') state = entry.state;
  });
  return {state, parseErrors};
}

export function formatSession(session: HazeSession) {
  return `${session.id} · ${session.file}`;
}
