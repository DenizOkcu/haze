import crypto from 'node:crypto';
import path from 'node:path';
import type {Stats} from 'node:fs';
import fs from 'fs-extra';
import type {ModelMessage} from 'ai';
import {HAZE_DIR} from '../../config/paths.js';
import type {WorkState} from '../agent/workState.js';
import {prepareSessionEntryForWrite} from './sessionSlimming.js';
import {appendPrivateFile, ensurePrivateDir, tightenPrivateFile, writePrivateFileAtomic} from '../../config/privateStorage.js';
import {JSONL_LINE_BYTES} from '../limits/byteBudgets.js';
import {iterateBoundedUtf8Lines} from '../io/boundedRead.js';

export type SessionEntry =
  | {type: 'header'; id: string; cwd: string; createdAt: string; hazeVersion?: string; forkedFrom?: string; build?: {commit?: string; builtAt?: string}}
  | {type: 'ui_message'; at: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string}
  | {type: 'conversation_snapshot'; at: string; messages: ModelMessage[]}
  | {type: 'work_state_snapshot'; at: string; state: WorkState}
  | {type: 'event'; at: string; name: string; text?: string};

type SessionHeader = Extract<SessionEntry, {type: 'header'}>;
type DeferredSessionWrite = {header: SessionHeader; entries: SessionEntry[]};

export interface HazeSession {
  id: string;
  file: string;
  cwd: string;
  sessionsDir: string;
  /** New sessions stay memory-only until they contain a resumable message. */
  deferredWrite?: DeferredSessionWrite;
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

function validatedSessionFile(session: HazeSession): string {
  const id = session.id.trim();
  if (!id || id !== session.id || id === '.' || id === '..' || id.includes('/') || id.includes('\\') || path.isAbsolute(id)) {
    throw new Error(`Invalid session id: ${session.id}`);
  }
  const sessionsDir = path.resolve(session.sessionsDir);
  const expected = path.resolve(sessionFile(id, session.cwd, sessionsDir));
  const resolved = path.resolve(session.file);
  const relative = path.relative(sessionsDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || resolved !== expected) {
    throw new Error(`Session file is outside its configured session directory: ${session.file}`);
  }
  return expected;
}

function newSessionId(now = new Date()) {
  // Timestamp prefix keeps latestSession() lexicographic ordering; the random
  // suffix prevents same-millisecond collisions (CR-025).
  return `${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
}

export async function createSession(options: {cwd?: string; hazeVersion?: string; sessionsDir?: string; forkedFrom?: string; build?: {commit?: string; builtAt?: string}} = {}): Promise<HazeSession> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const id = newSessionId();
  const sessionsDir = path.resolve(options.sessionsDir ?? DEFAULT_SESSIONS_DIR);
  const file = sessionFile(id, cwd, sessionsDir);
  await ensurePrivateDir(path.dirname(file));
  return {
    id,
    file,
    cwd,
    sessionsDir,
    deferredWrite: {
      header: {type: 'header', id, cwd, createdAt: new Date().toISOString(), hazeVersion: options.hazeVersion, forkedFrom: options.forkedFrom, ...(options.build ? {build: options.build} : {})},
      entries: [],
    },
  };
}

export async function findSession(id: string, cwd = process.cwd(), sessionsDir = DEFAULT_SESSIONS_DIR): Promise<HazeSession | undefined> {
  const normalizedId = id.trim();
  // Reject both platform-native and foreign separators so session IDs remain
  // single filenames if a session is moved between operating systems.
  if (!normalizedId || normalizedId !== id || normalizedId === '.' || normalizedId === '..' || normalizedId.includes('/') || normalizedId.includes('\\') || path.isAbsolute(normalizedId)) return undefined;
  const file = sessionFile(normalizedId, cwd, sessionsDir);
  if (!await fs.pathExists(file)) return undefined;
  return {id: normalizedId, file, cwd: path.resolve(cwd), sessionsDir: path.resolve(sessionsDir)};
}

export async function latestSession(cwd = process.cwd(), sessionsDir = DEFAULT_SESSIONS_DIR): Promise<HazeSession | undefined> {
  const latest = (await listSessions(cwd, sessionsDir))[0];
  if (!latest) return undefined;
  return {id: latest.id, file: sessionFile(latest.id, cwd, sessionsDir), cwd: path.resolve(cwd), sessionsDir: path.resolve(sessionsDir)};
}

function entryMakesSessionResumable(entry: SessionEntry): boolean {
  if (entry.type === 'ui_message') return entry.text.trim().length > 0;
  return entry.type === 'conversation_snapshot' && entry.messages.length > 0;
}

export async function appendSessionEntry(session: HazeSession, entry: SessionEntry): Promise<void> {
  const file = validatedSessionFile(session);
  const prepared = prepareSessionEntryForWrite(entry);
  if (!prepared) return;
  const deferred = session.deferredWrite;
  if (deferred) {
    if (!entryMakesSessionResumable(prepared)) {
      deferred.entries.push(prepared);
      return;
    }
    const entries = [deferred.header, ...deferred.entries, prepared];
    await appendPrivateFile(file, entries.map(item => JSON.stringify(item)).join('\n') + '\n');
    session.deferredWrite = undefined;
    return;
  }
  await appendPrivateFile(file, `${JSON.stringify(prepared)}\n`);
  // Snapshot deduplication runs inside the same serialized writer as the
  // append, so ordering with subsequent entries is preserved (F-03).
  await vacuumSessionFileIfLarge(session).catch(() => undefined);
}

/**
 * Session files rewrite their full conversation history per turn, so a long
 * session grows quadratically: N tokens of final history cost O(turns ×
 * history) bytes on disk (F-03). Once superseded snapshots dominate the file,
 * rewrite it keeping only the newest conversation/work-state snapshot plus
 * every non-snapshot entry (restore reads only the newest snapshot of each
 * type, so dropping superseded ones is lossless for restore; summaries keep
 * their ui_message/event history). Atomic replace, never partial.
 */
export const SESSION_VACUUM_THRESHOLD_BYTES = 16 * 1024 * 1024;

let effectiveVacuumThresholdBytes = SESSION_VACUUM_THRESHOLD_BYTES;

/** Test-only override for the vacuum trigger; tests restore the original. */
export function setSessionVacuumThresholdForTests(bytes: number): void {
  effectiveVacuumThresholdBytes = bytes;
}

export async function vacuumSessionFileIfLarge(session: HazeSession, thresholdBytes: number = effectiveVacuumThresholdBytes): Promise<boolean> {
  const file = validatedSessionFile(session);
  if (session.deferredWrite) return false;
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat || stat.size < thresholdBytes) return false;
  const {entries} = await readSessionEntries(session);
  let lastConversation = -1;
  let lastWorkState = -1;
  entries.forEach((entry, index) => {
    if (entry.type === 'conversation_snapshot') lastConversation = index;
    if (entry.type === 'work_state_snapshot') lastWorkState = index;
  });
  // Malformed lines are dropped by the rewrite: they were already unusable
  // (and reported as parse errors on read) and keeping them would defeat the
  // size bound the vacuum exists to enforce.
  const kept = entries.filter((entry, index) =>
    (entry.type !== 'conversation_snapshot' && entry.type !== 'work_state_snapshot')
    || index === lastConversation
    || index === lastWorkState);
  const serialized = kept.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  // Only rewrite when it meaningfully shrinks the file; otherwise a single
  // dominant snapshot would trigger a full rewrite on every append.
  if (serialized.length > stat.size / 2) return false;
  await writePrivateFileAtomic(file, serialized);
  return true;
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

function optionalBuildProvenance(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return optionalString(value.commit) && optionalString(value.builtAt);
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
        || !optionalString(value.hazeVersion) || !optionalString(value.forkedFrom)
        || !optionalBuildProvenance(value.build)) return invalid('invalid header');
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
  const file = validatedSessionFile(session);
  if (session.deferredWrite && !await fs.pathExists(file)) return [];
  await tightenPrivateFile(file);
  const parseErrors: string[] = [];
  let omittedErrors = 0;
  const report = (message: string) => {
    if (parseErrors.length < MAX_PARSE_ERRORS) parseErrors.push(message);
    else omittedErrors++;
  };
  for await (const {line, lineNumber, oversized} of iterateBoundedUtf8Lines(file, JSONL_LINE_BYTES)) {
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
    if (entry.type === 'ui_message' && entry.text.trim().length > 0) {
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
    const session: HazeSession = {id, file: path.join(dir, fileName), cwd: path.resolve(cwd), sessionsDir: path.resolve(sessionsDir)};
    const file = validatedSessionFile(session);
    await tightenPrivateFile(file);
    const stat = await fs.stat(file);
    const cached = cachedSessionSummary(file, stat);
    if (cached) return cached;
    const summary = await summarizeSession(session, stat);
    cacheSessionSummary(file, stat, summary);
    return summary;
  }));
  return summaries
    .filter(summary => summary.messageCount > 0)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id));
}

export interface ForkSessionResult {
  session: HazeSession;
  parseErrors: string[];
}

/** Create a new session from the source's latest durable snapshots without mutating it. */
export async function forkSession(source: HazeSession, options: {hazeVersion?: string; sessionsDir?: string; build?: {commit?: string; builtAt?: string}} = {}): Promise<ForkSessionResult> {
  const restored = await restoreSessionState(source);
  if (restored.messages.length === 0) throw new Error(`Session ${source.id} has no conversation snapshot to fork.`);
  const session = await createSession({cwd: source.cwd, sessionsDir: options.sessionsDir, hazeVersion: options.hazeVersion, forkedFrom: source.id, ...(options.build ? {build: options.build} : {})});
  const at = new Date().toISOString();
  await appendSessionEntry(session, {type: 'conversation_snapshot', at, messages: restored.messages});
  if (restored.workState) await appendSessionEntry(session, {type: 'work_state_snapshot', at, state: restored.workState});
  return {session, parseErrors: restored.parseErrors};
}

export function formatSession(session: HazeSession) {
  return `${session.id} · ${session.file}`;
}
