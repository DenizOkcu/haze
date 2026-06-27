import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import type {ModelMessage} from 'ai';
import {createWorkState} from '../../src/core/agent/workState.js';
import {appendSessionEntry, createSession, latestSession, readSessionEntries, restoreConversation, restoreWorkState} from '../../src/core/session/sessionStore.js';

describe('sessionStore', () => {
  let tmp: string;
  let sessionsDir: string;
  let cwd: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-session-test-'));
    sessionsDir = path.join(tmp, 'sessions');
    cwd = path.join(tmp, 'workspace');
    await fs.ensureDir(cwd);
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('creates a session under the configured sessions directory', async () => {
    const session = await createSession({cwd, sessionsDir, hazeVersion: 'test'});
    expect(session.cwd).toBe(cwd);
    expect(session.file.startsWith(sessionsDir)).toBe(true);
    expect(await fs.pathExists(session.file)).toBe(true);
    const {entries} = await readSessionEntries(session);
    expect(entries[0]).toMatchObject({type: 'header', cwd, hazeVersion: 'test'});
  });

  it('appends and reads JSONL entries', async () => {
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: 'now', role: 'user', text: 'hello'});
    const {entries} = await readSessionEntries(session);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({type: 'ui_message', at: 'now', role: 'user', text: 'hello'});
  });

  it('restores the latest conversation snapshot', async () => {
    const session = await createSession({cwd, sessionsDir});
    const first: ModelMessage[] = [{role: 'user', content: 'old'}];
    const latest: ModelMessage[] = [{role: 'user', content: 'new'}, {role: 'assistant', content: 'done'}];
    await appendSessionEntry(session, {type: 'conversation_snapshot', at: '1', messages: first});
    await appendSessionEntry(session, {type: 'conversation_snapshot', at: '2', messages: latest});
    await expect(restoreConversation(session)).resolves.toEqual({messages: latest, parseErrors: []});
  });

  it('restores the latest structured work-state snapshot', async () => {
    const session = await createSession({cwd, sessionsDir});
    const first = createWorkState('old goal', 'implementation', ['old']);
    const latest = createWorkState('current goal', 'implementation', ['tests pass']);
    latest.nextAction = 'Run npm test.';
    await appendSessionEntry(session, {type: 'work_state_snapshot', at: '1', state: first});
    await appendSessionEntry(session, {type: 'work_state_snapshot', at: '2', state: latest});
    await expect(restoreWorkState(session)).resolves.toEqual({state: latest, parseErrors: []});
  });

  it('returns the latest session for a cwd', async () => {
    const first = await createSession({cwd, sessionsDir});
    await new Promise(resolve => setTimeout(resolve, 2));
    const second = await createSession({cwd, sessionsDir});
    const latest = await latestSession(cwd, sessionsDir);
    expect(latest?.id).toBe(second.id);
    expect(latest?.id).not.toBe(first.id);
  });

  it('reports parse errors for malformed lines instead of silently dropping them', async () => {
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: '1', role: 'user', text: 'before'});
    // Corrupt line (not valid JSON), followed by a valid line.
    await fs.appendFile(session.file, '{not valid json\n', 'utf8');
    await appendSessionEntry(session, {type: 'ui_message', at: '2', role: 'user', text: 'after'});

    const {entries, parseErrors} = await readSessionEntries(session);
    // Header + 'before' + 'after' parse; the malformed line is reported, not dropped silently.
    expect(entries).toHaveLength(3);
    expect(entries[1]).toMatchObject({text: 'before'});
    expect(entries[2]).toMatchObject({text: 'after'});
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]).toContain('Line 3');
  });

  it('returns no parse errors for a clean session file', async () => {
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: 'now', role: 'user', text: 'hello'});
    const {parseErrors} = await readSessionEntries(session);
    expect(parseErrors).toEqual([]);
  });
});
