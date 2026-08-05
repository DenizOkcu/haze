import crypto from 'node:crypto';
import path from 'node:path';
import type {Stats} from 'node:fs';
import fs from 'fs-extra';
import type {ModelMessage} from 'ai';
import {HAZE_DIR} from '../../config/paths.js';
import type {WorkState} from '../agent/workState.js';
import {prepareSessionEntryForWrite} from './sessionSlimming.js';
import {appendPrivateFile, ensurePrivateDir, tightenPrivateFile} from '../../config/privateStorage.js';
import {JSONL_LINE_BYTES} from '../limits/byteBudgets.js';
import {iterateBoundedUtf8Lines} from '../io/boundedRead.js';

export type SessionEntry =
  | {type: 'header'; id: string; cwd: string; createdAt: string; hazeVersion?: string; forkedFrom?: string}
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
  // Timestamp prefix keeps latestSession() lexicographic ordering; the random
  // suffix prevents same-millisecond collisions (CR-025).
  return `${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
}

export async function createSession(options: {cwd?: string; hazeVersion?: string; sessionsDir?: string; forkedFrom?: string} = {}): Promise<HazeSession> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const id = newSessionId();
  const file = sessionFile(id, cwd, options.sessionsDir);
  await ensurePrivateDir(path.dirname(file));
  await appendSessionEntry({id, file, cwd}, {type: 'header', id, cwd, createdAt: new Date().toISOString(), hazeVersion: options.hazeVersion, forkedFrom: options.forkedFrom});
  return {id, file, cwd};
}

export async function findSession(id: string, cwd = process.cwd(), sessionsDir = DEFAULT_SESSIONS_DIR): Promise<HazeSession | undefined> {
  const normalizedId = id.trim();
  if (!normalizedId || path.basename(normalizedId) !== normalizedId || normalizedId.endsWith('.jsonl')) return undefined;
  const file = sessionFile(normalizedId, cwd, sessionsDir);
  if (!await fs.pathExists(file)) return undefined;
  return {id: normalizedId, file, cwd: path.resolve(cwd)};
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
const MODEL_MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function parseSessionEntry(value: unknown): SessionEntry {
  const invalid = (detail: string): never => {
    throw new Error(`unexpected entry shape: ${detail}`);
  };
  if (!isRecord(value)) return invalid('expected an object with a string type');
  const type = value.type;
  if (typeof type !== 'string') return invalid('expected an object with a string type');

  switch (type) {
    case 'header':
      if (typeof value.id !== 'string' || typeof value.cwd !== 'string' || typeof value.createdAt !== 'string'
        || !optionalString(value.hazeVersion) || !optionalString(value.forkedFrom)) return invalid('invalid header');
      return value as SessionEntry;
    case 'ui_message':
      if (typeof value.at !== 'string' || typeof value.text !== 'string'
        || !MODEL_MESSAGE_ROLES.has(typeof value.role === 'string' ? value.role : '')) return invalid('invalid ui_message');
      return value as SessionEntry;
    case 'conversation_snapshot':
      if (typeof value.at !== 'string' || !Array.isArray(value.messages)) return invalid('conversation_snapshot messages must be an array');
      if (!value.messages.every((message: unknown) => isRecord(message)
        && typeof message.role === 'string'
        && MODEL_MESSAGE_ROLES.has(message.role))) return invalid('conversation_snapshot contains an invalid message role');
      return value as SessionEntry;
    case 'work_state_snapshot':
      if (typeof value.at !== 'string' || !isRecord(value.state)) return invalid('work_state_snapshot state must be an object');
      return value as SessionEntry;
    case 'event':
      if (typeof value.at !== 'string' || typeof value.name !== 'string' || !optionalString(value.text)) return invalid('invalid event');
      return value as SessionEntry;
    default:
      return invalid(`unknown entry type '${type}'`);
  }
}

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
      onEntry(parseSessionEntry(JSON.parse(line) as unknown));
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

export interface RestoreSessionStateResult {
  messages: ModelMessage[];
  workState: WorkState | undefined;
  parseErrors: string[];
}

/**
 * Restore conversation and work state in one file scan (CR-013). Session
 * files grow to megabytes in long workspaces; resuming should not parse the
 * JSONL twice.
 */
export async function restoreSessionState(session: HazeSession): Promise<RestoreSessionStateResult> {
  let messages: ModelMessage[] = [];
  let workState: WorkState | undefined;
  const parseErrors = await scanSessionEntries(session, entry => {
    if (entry.type === 'conversation_snapshot') messages = entry.messages;
    if (entry.type === 'work_state_snapshot') workState = entry.state;
  });
  return {messages, workState, parseErrors};
}

export async function restoreConversation(session: HazeSession): Promise<RestoreConversationResult> {
  const {messages, parseErrors} = await restoreSessionState(session);
  return {messages, parseErrors};
}

export interface RestoreWorkStateResult {
  state: WorkState | undefined;
  parseErrors: string[];
}

export async function restoreWorkState(session: HazeSession): Promise<RestoreWorkStateResult> {
  const {workState, parseErrors} = await restoreSessionState(session);
  return {state: workState, parseErrors};
}

const SESSION_PREVIEW_CHARS = 120;
/** Acceptance budget for listing 50 ordinary workspace sessions. */
export const SESSION_LIST_LATENCY_BUDGET_MS = 2_000;

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  firstUserPreview: string;
  sizeBytes: number;
  lastStatus?: string;
  parseErrors: string[];
}

type CachedSessionSummary = {mtimeMs: number; size: number; summary: SessionSummary};
const SESSION_SUMMARY_CACHE_MAX = 500;
const sessionSummaryCache = new Map<string, CachedSessionSummary>();

function cachedSessionSummary(file: string, stat: Stats): SessionSummary | undefined {
  const cached = sessionSummaryCache.get(file);
  if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) return undefined;
  sessionSummaryCache.delete(file);
  sessionSummaryCache.set(file, cached);
  return cached.summary;
}

function cacheSessionSummary(file: string, stat: Stats, summary: SessionSummary): void {
  sessionSummaryCache.delete(file);
  sessionSummaryCache.set(file, {mtimeMs: stat.mtimeMs, size: stat.size, summary});
  while (sessionSummaryCache.size > SESSION_SUMMARY_CACHE_MAX) {
    const oldest = sessionSummaryCache.keys().next().value;
    if (oldest === undefined) break;
    sessionSummaryCache.delete(oldest);
  }
}

/** Test-only reset for the process-scoped session-summary cache. */
export function clearSessionSummaryCacheForTests(): void {
  sessionSummaryCache.clear();
}

function previewText(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > SESSION_PREVIEW_CHARS ? `${compact.slice(0, SESSION_PREVIEW_CHARS - 1)}…` : compact;
}

async function summarizeSession(session: HazeSession, stat: Stats): Promise<SessionSummary> {
  let createdAt = stat.birthtime.toISOString();
  let lastActivityAt = stat.mtime.toISOString();
  let messageCount = 0;
  let firstUserPreview = '';
  let lastStatus: string | undefined;
  const parseErrors = await scanSessionEntries(session, entry => {
    if (entry.type === 'header') createdAt = entry.createdAt || createdAt;
    if ('at' in entry && entry.at) lastActivityAt = entry.at;
    if (entry.type === 'ui_message') {
      messageCount++;
      if (!firstUserPreview && entry.role === 'user') firstUserPreview = previewText(entry.text);
    }
    if (entry.type === 'conversation_snapshot') {
      if (messageCount === 0) messageCount = entry.messages.length;
      if (!firstUserPreview) {
        const firstUser = entry.messages.find(message => message.role === 'user');
        if (firstUser) firstUserPreview = previewText(typeof firstUser.content === 'string' ? firstUser.content : JSON.stringify(firstUser.content));
      }
    }
    if (entry.type === 'event' && entry.name === 'turn_end' && entry.text) {
      try {
        const event = JSON.parse(entry.text) as {status?: unknown};
        if (typeof event.status === 'string') lastStatus = event.status;
      } catch {
        // The outer entry remains valid; malformed optional event metadata is ignored.
      }
    }
  });
  return {id: session.id, createdAt, lastActivityAt, messageCount, firstUserPreview, sizeBytes: stat.size, lastStatus, parseErrors};
}

/** List this workspace's sessions newest-first while retaining only summary state per file. */
export async function listSessions(cwd = process.cwd(), sessionsDir = DEFAULT_SESSIONS_DIR): Promise<SessionSummary[]> {
  const dir = sessionDir(cwd, sessionsDir);
  await ensurePrivateDir(dir);
  const files = (await fs.readdir(dir).catch(() => [])).filter(file => file.endsWith('.jsonl'));
  const present = new Set(files.map(file => path.join(dir, file)));
  for (const cachedFile of sessionSummaryCache.keys()) {
    if (path.dirname(cachedFile) === dir && !present.has(cachedFile)) sessionSummaryCache.delete(cachedFile);
  }
  const summaries = await Promise.all(files.map(async fileName => {
    const id = path.basename(fileName, '.jsonl');
    const session: HazeSession = {id, file: path.join(dir, fileName), cwd: path.resolve(cwd)};
    await tightenPrivateFile(session.file);
    const stat = await fs.stat(session.file);
    const cached = cachedSessionSummary(session.file, stat);
    if (cached) return cached;
    const summary = await summarizeSession(session, stat);
    cacheSessionSummary(session.file, stat, summary);
    return summary;
  }));
  return summaries.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id));
}

export interface ForkSessionResult {
  session: HazeSession;
  parseErrors: string[];
}

/** Create a new session from the source's latest durable snapshots without mutating it. */
export async function forkSession(source: HazeSession, options: {hazeVersion?: string; sessionsDir?: string} = {}): Promise<ForkSessionResult> {
  const restored = await restoreSessionState(source);
  if (restored.messages.length === 0) throw new Error(`Session ${source.id} has no conversation snapshot to fork.`);
  const session = await createSession({cwd: source.cwd, sessionsDir: options.sessionsDir, hazeVersion: options.hazeVersion, forkedFrom: source.id});
  const at = new Date().toISOString();
  await appendSessionEntry(session, {type: 'conversation_snapshot', at, messages: restored.messages});
  if (restored.workState) await appendSessionEntry(session, {type: 'work_state_snapshot', at, state: restored.workState});
  return {session, parseErrors: restored.parseErrors};
}

export function formatSession(session: HazeSession) {
  return `${session.id} · ${session.file}`;
}
