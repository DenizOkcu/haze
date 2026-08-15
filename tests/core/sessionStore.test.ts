import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import type {ModelMessage} from 'ai';
import {createWorkState} from '../../src/core/agent/workState.js';
import {appendSessionEntry, clearSessionSummaryCacheForTests, createSession, findSession, forkSession, latestSession, listSessions, readSessionEntries, restoreConversation, restoreSessionState, restoreWorkState, SESSION_LIST_LATENCY_BUDGET_MS, SESSION_VACUUM_THRESHOLD_BYTES, setSessionVacuumThresholdForTests, vacuumSessionFileIfLarge} from '../../src/core/session/sessionStore.js';
import {JSONL_LINE_BYTES} from '../../src/core/limits/byteBudgets.js';

describe('sessionStore', () => {
  let tmp: string;
  let sessionsDir: string;
  let cwd: string;

  beforeEach(async () => {
    clearSessionSummaryCacheForTests();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-session-test-'));
    sessionsDir = path.join(tmp, 'sessions');
    cwd = path.join(tmp, 'workspace');
    await fs.ensureDir(cwd);
  });

  afterEach(async () => {
    clearSessionSummaryCacheForTests();
    setSessionVacuumThresholdForTests(SESSION_VACUUM_THRESHOLD_BYTES);
    await fs.remove(tmp);
  });

  it('keeps a new session memory-only until it contains a resumable message', async () => {
    const session = await createSession({cwd, sessionsDir, hazeVersion: 'test'});
    expect(session.cwd).toBe(cwd);
    expect(session.file.startsWith(sessionsDir)).toBe(true);
    expect(await fs.pathExists(session.file)).toBe(false);
    await expect(readSessionEntries(session)).resolves.toEqual({entries: [], parseErrors: []});

    await appendSessionEntry(session, {type: 'event', at: '1', name: 'clear'});
    await appendSessionEntry(session, {type: 'conversation_snapshot', at: '2', messages: []});
    expect(await fs.pathExists(session.file)).toBe(false);

    await appendSessionEntry(session, {type: 'ui_message', at: '3', role: 'user', text: 'hello'});
    expect(await fs.pathExists(session.file)).toBe(true);
    const {entries} = await readSessionEntries(session);
    expect(entries[0]).toMatchObject({type: 'header', cwd, hazeVersion: 'test'});
    expect(entries.map(entry => entry.type === 'event' ? entry.name : entry.type)).toEqual(['header', 'clear', 'conversation_snapshot', 'ui_message']);
  });

  it('records safe build provenance in the session header so failures tie to the executing build', async () => {
    const session = await createSession({cwd, sessionsDir, hazeVersion: '0.10.1', build: {commit: 'abc1230000000000000000000000000000000000', builtAt: '2026-08-13T10:00:00.000Z'}});
    await appendSessionEntry(session, {type: 'ui_message', at: '1', role: 'user', text: 'hello'});
    const {entries, parseErrors} = await readSessionEntries(session);
    expect(parseErrors).toEqual([]);
    expect(entries[0]).toMatchObject({type: 'header', hazeVersion: '0.10.1', build: {commit: 'abc1230000000000000000000000000000000000', builtAt: '2026-08-13T10:00:00.000Z'}});
    // Provenance is strictly bounded metadata: no environment or content fields sneak in.
    const header = entries[0] as Extract<typeof entries[0], {type: 'header'}>;
    expect(Object.keys(header.build ?? {})).toEqual(['commit', 'builtAt']);
    // Headers without provenance (legacy or tsx runs) still parse.
    const bare = await createSession({cwd, sessionsDir});
    await appendSessionEntry(bare, {type: 'ui_message', at: '2', role: 'user', text: 'hi'});
    const bareEntries = await readSessionEntries(bare);
    expect(bareEntries.parseErrors).toEqual([]);
    expect((bareEntries.entries[0] as {build?: unknown}).build).toBeUndefined();
  });

  it('creates distinct sessions even within the same millisecond (regression CR-025)', async () => {
    const [first, second] = await Promise.all([createSession({cwd, sessionsDir}), createSession({cwd, sessionsDir})]);
    expect(first.id).not.toBe(second.id);
    expect(first.file).not.toBe(second.file);
    expect(await fs.pathExists(first.file)).toBe(false);
    expect(await fs.pathExists(second.file)).toBe(false);
    await appendSessionEntry(first, {type: 'ui_message', at: '2026-08-01T10:00:00.000Z', role: 'user', text: 'first'});
    await appendSessionEntry(second, {type: 'ui_message', at: '2026-08-01T10:01:00.000Z', role: 'user', text: 'second'});
    const latest = await latestSession(cwd, sessionsDir);
    expect(latest?.id).toBe(second.id);
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
    await appendSessionEntry(session, {type: 'ui_message', at: '0', role: 'user', text: 'start work'});
    const first = createWorkState('old goal', 'implementation', ['old']);
    const latest = createWorkState('current goal', 'implementation', ['tests pass']);
    latest.nextAction = 'Run npm test.';
    await appendSessionEntry(session, {type: 'work_state_snapshot', at: '1', state: first});
    await appendSessionEntry(session, {type: 'work_state_snapshot', at: '2', state: latest});
    await expect(restoreWorkState(session)).resolves.toEqual({state: latest, parseErrors: []});
  });

  it('returns the latest non-empty session for a cwd', async () => {
    const first = await createSession({cwd, sessionsDir});
    await appendSessionEntry(first, {type: 'ui_message', at: '2026-08-01T10:00:00.000Z', role: 'user', text: 'first'});
    const empty = await createSession({cwd, sessionsDir});
    const second = await createSession({cwd, sessionsDir});
    await appendSessionEntry(second, {type: 'ui_message', at: '2026-08-01T10:01:00.000Z', role: 'user', text: 'second'});
    const latest = await latestSession(cwd, sessionsDir);
    expect(latest?.id).toBe(second.id);
    expect(latest?.id).not.toBe(first.id);
    expect(await fs.pathExists(empty.file)).toBe(false);
  });

  it('lists workspace sessions newest-first with bounded summaries and malformed-line warnings (F02)', async () => {
    const older = await createSession({cwd, sessionsDir});
    await appendSessionEntry(older, {type: 'ui_message', at: '2026-08-01T10:00:00.000Z', role: 'user', text: '  investigate   the flaky test  '});
    await appendSessionEntry(older, {type: 'ui_message', at: '2026-08-01T10:01:00.000Z', role: 'assistant', text: 'working'});
    await fs.appendFile(older.file, '{bad json\n');

    const newer = await createSession({cwd, sessionsDir});
    await appendSessionEntry(newer, {type: 'ui_message', at: '2026-08-02T10:00:00.000Z', role: 'user', text: 'ship the fix'});
    await appendSessionEntry(newer, {type: 'event', at: '2026-08-02T10:02:00.000Z', name: 'turn_end', text: JSON.stringify({status: 'complete'})});

    const summaries = await listSessions(cwd, sessionsDir);
    expect(summaries.map(summary => summary.id)).toEqual([newer.id, older.id]);
    expect(summaries[0]).toMatchObject({messageCount: 1, firstUserPreview: 'ship the fix', lastStatus: 'complete'});
    expect(summaries[0]?.sizeBytes).toBeGreaterThan(0);
    expect(summaries[1]).toMatchObject({messageCount: 2, firstUserPreview: 'investigate the flaky test'});
    expect(summaries[1]?.parseErrors[0]).toContain('Line 4');
  });

  it('hides legacy persisted sessions that contain no messages', async () => {
    const empty = await createSession({cwd, sessionsDir});
    const header = empty.deferredWrite?.header;
    expect(header).toBeDefined();
    await fs.writeFile(empty.file, `${JSON.stringify(header)}\n${JSON.stringify({type: 'event', at: '1', name: 'clear'})}\n`);

    const visible = await createSession({cwd, sessionsDir});
    await appendSessionEntry(visible, {type: 'ui_message', at: '2', role: 'user', text: 'real conversation'});

    await expect(listSessions(cwd, sessionsDir)).resolves.toMatchObject([{id: visible.id}]);
  });

  it('invalidates a cached summary when a session file changes', async () => {
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: '2026-08-01T10:00:00.000Z', role: 'user', text: 'first'});
    await expect(listSessions(cwd, sessionsDir)).resolves.toMatchObject([{messageCount: 1, firstUserPreview: 'first'}]);

    await appendSessionEntry(session, {type: 'ui_message', at: '2026-08-01T10:01:00.000Z', role: 'assistant', text: 'second'});
    await expect(listSessions(cwd, sessionsDir)).resolves.toMatchObject([{messageCount: 2, firstUserPreview: 'first'}]);
  });

  it('lists 50 ordinary sessions within the explicit picker latency budget (F02 AC4)', async () => {
    await Promise.all(Array.from({length: 50}, async (_, index) => {
      const session = await createSession({cwd, sessionsDir});
      await appendSessionEntry(session, {type: 'ui_message', at: new Date(2026, 7, 3, 10, index).toISOString(), role: 'user', text: `request ${index}`});
    }));
    const startedAt = performance.now();
    const summaries = await listSessions(cwd, sessionsDir);
    expect(summaries).toHaveLength(50);
    expect(performance.now() - startedAt).toBeLessThan(SESSION_LIST_LATENCY_BUDGET_MS);
  });

  it('finds only exact, path-safe persisted session ids in the current workspace (F02)', async () => {
    const session = await createSession({cwd, sessionsDir});
    await expect(findSession(session.id, cwd, sessionsDir)).resolves.toBeUndefined();
    await appendSessionEntry(session, {type: 'ui_message', at: '1', role: 'user', text: 'persist me'});
    await expect(findSession(session.id, cwd, sessionsDir)).resolves.toEqual({id: session.id, file: session.file, cwd: session.cwd});
    await expect(findSession(`${session.id}.jsonl`, cwd, sessionsDir)).resolves.toBeUndefined();
    await expect(findSession('../other', cwd, sessionsDir)).resolves.toBeUndefined();
    await expect(findSession('missing', cwd, sessionsDir)).resolves.toBeUndefined();
  });

  it('forks the latest conversation and work-state snapshots without changing the source (F02)', async () => {
    const source = await createSession({cwd, sessionsDir});
    const oldMessages: ModelMessage[] = [{role: 'user', content: 'old'}];
    const latestMessages: ModelMessage[] = [{role: 'user', content: 'branch here'}, {role: 'assistant', content: 'ready'}];
    const state = createWorkState('fork goal', 'implementation', ['test']);
    await appendSessionEntry(source, {type: 'conversation_snapshot', at: '1', messages: oldMessages});
    await appendSessionEntry(source, {type: 'conversation_snapshot', at: '2', messages: latestMessages});
    await appendSessionEntry(source, {type: 'work_state_snapshot', at: '3', state});
    const before = await fs.readFile(source.file);

    const result = await forkSession(source, {sessionsDir, hazeVersion: 'test'});

    expect(await fs.readFile(source.file)).toEqual(before);
    expect(result.session.id).not.toBe(source.id);
    const {entries} = await readSessionEntries(result.session);
    expect(entries[0]).toMatchObject({type: 'header', forkedFrom: source.id});
    await expect(restoreSessionState(result.session)).resolves.toMatchObject({messages: latestMessages, workState: state, parseErrors: []});
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

  it('reports parse errors with true file line numbers even when blank lines precede them', async () => {
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: '1', role: 'user', text: 'first'});
    // Inject a stray blank line (a form of corruption), then a malformed line on what is now line 4.
    await fs.appendFile(session.file, '\n{not valid json\n', 'utf8');
    await appendSessionEntry(session, {type: 'ui_message', at: '2', role: 'user', text: 'after'});

    const {entries, parseErrors} = await readSessionEntries(session);
    expect(entries).toHaveLength(3);
    // The malformed line is on file line 4 (header=1, first=2, blank=3, corrupt=4), not line 3.
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]).toContain('Line 4');
  });

  it('rejects an oversized JSONL line and continues with later entries', async () => {
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: '1', role: 'user', text: 'before'});
    await fs.appendFile(session.file, `${'x'.repeat(JSONL_LINE_BYTES + 1)}\n`, 'utf8');
    await appendSessionEntry(session, {type: 'ui_message', at: '2', role: 'user', text: 'after'});
    const {entries, parseErrors} = await readSessionEntries(session);
    expect(entries.at(-1)).toMatchObject({type: 'ui_message', text: 'after'});
    expect(parseErrors).toContain(`Line 3: exceeds ${JSONL_LINE_BYTES} byte limit`);
  });

  it('rejects tampered snapshot shapes and reports their line numbers', async () => {
    const session = await createSession({cwd, sessionsDir});
    const valid: ModelMessage[] = [{role: 'user', content: 'safe'}];
    await appendSessionEntry(session, {type: 'conversation_snapshot', at: '1', messages: valid});
    await fs.appendFile(session.file, [
      JSON.stringify({type: 'conversation_snapshot', at: '2', messages: 'injected'}),
      JSON.stringify({type: 'conversation_snapshot', at: '3', messages: [{role: 'operator', content: 'injected'}]}),
      JSON.stringify({type: 'work_state_snapshot', at: '4', state: 42}),
      '',
    ].join('\n'), 'utf8');

    const restored = await restoreSessionState(session);
    expect(restored.messages).toEqual(valid);
    expect(restored.workState).toBeUndefined();
    expect(restored.parseErrors).toHaveLength(3);
    expect(restored.parseErrors[0]).toContain('Line 3: unexpected entry shape');
    expect(restored.parseErrors[1]).toContain('Line 4: unexpected entry shape');
    expect(restored.parseErrors[2]).toContain('Line 5: unexpected entry shape');
  });

  it('returns no parse errors for a clean session file', async () => {
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: 'now', role: 'user', text: 'hello'});
    const {parseErrors} = await readSessionEntries(session);
    expect(parseErrors).toEqual([]);
  });

  it('does not persist streaming message_update events', async () => {
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: '0', role: 'user', text: 'hello'});
    await appendSessionEntry(session, {type: 'event', at: '1', name: 'message_update', text: JSON.stringify({type: 'message_update', id: 'a', text: 'partial', at: '1'})});
    await appendSessionEntry(session, {type: 'event', at: '2', name: 'message_end', text: JSON.stringify({type: 'message_end', id: 'a', text: 'done', at: '2'})});

    const {entries} = await readSessionEntries(session);
    expect(entries.map(entry => entry.type === 'event' ? entry.name : entry.type)).toEqual(['header', 'ui_message', 'message_end']);
  });

  it('slims large tool_end event outputs before writing', async () => {
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: '0', role: 'user', text: 'run tool'});
    const largeOutput = {content: 'x'.repeat(40_000)};
    await appendSessionEntry(session, {type: 'event', at: '1', name: 'tool_end', text: JSON.stringify({type: 'tool_end', id: 'call', name: 'readFile', success: true, output: largeOutput, durationMs: 1, at: '1'})});

    const {entries} = await readSessionEntries(session);
    const eventEntry = entries.find(entry => entry.type === 'event' && entry.name === 'tool_end');
    expect(eventEntry).toMatchObject({type: 'event', name: 'tool_end'});
    const event = JSON.parse(eventEntry.type === 'event' ? eventEntry.text ?? '{}' : '{}') as {output: {omitted?: boolean; originalBytes?: number; preview?: string}};
    expect(event.output.omitted).toBe(true);
    expect(event.output.originalBytes).toBeGreaterThan(32_000);
    expect(event.output.preview?.length).toBeLessThan(10_000);
  });

  it('slims tool_start inputs to byte counts so written file content never reaches the session file (regression CR-031)', async () => {
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: '0', role: 'user', text: 'write file'});
    const writtenContent = 'SECRET_FILE_CONTENT '.repeat(4_000);
    await appendSessionEntry(session, {type: 'event', at: '1', name: 'tool_start', text: JSON.stringify({type: 'tool_start', id: 'call', name: 'writeFile', input: {path: 'src/app.ts', content: writtenContent}, at: '1'})});

    const raw = await fs.readFile(session.file, 'utf-8');
    expect(raw).not.toContain('SECRET_FILE_CONTENT');
    const {entries} = await readSessionEntries(session);
    const eventEntry = entries.find(entry => entry.type === 'event' && entry.name === 'tool_start');
    const event = JSON.parse(eventEntry?.type === 'event' ? eventEntry.text ?? '{}' : '{}') as {id: string; name: string; input: {inputBytes?: number; path?: string; content?: string}};
    expect(event.id).toBe('call');
    expect(event.name).toBe('writeFile');
    expect(event.input.content).toBeUndefined();
    expect(event.input.path).toBe('src/app.ts');
    expect(event.input.inputBytes).toBeGreaterThan(50_000);
  });

  it('persists only subagent capsule and bounded scheduler metadata in tool events', async () => {
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: '0', role: 'user', text: 'delegate'});
    const output = {capsule: {id: 'w', termination: 'completed', usable: true, deliverable: 'done'}, telemetry: {modelSelector: 'p:m', profile: 'local-safe', durationMs: 10, queueMs: 2, toolCallCount: 1, toolCalls: [{name: 'readFile', summary: 'private detail'}], usage: {inputTokens: 99}}};
    await appendSessionEntry(session, {type: 'event', at: '1', name: 'tool_end', text: JSON.stringify({type: 'tool_end', id: 'call', name: 'subagent', success: true, output, durationMs: 1, at: '1'})});
    const {entries} = await readSessionEntries(session);
    const eventEntry = entries.find(entry => entry.type === 'event' && entry.name === 'tool_end');
    const event = JSON.parse(eventEntry?.type === 'event' ? eventEntry.text ?? '{}' : '{}');
    expect(event.output.capsule.deliverable).toBe('done');
    expect(event.output.coordinator).toMatchObject({modelSelector: 'p:m', profile: 'local-safe', toolCallCount: 1});
    expect(JSON.stringify(event)).not.toContain('private detail');
    expect(JSON.stringify(event)).not.toContain('inputTokens');
  });

  it('restores retry JSONL without ephemeral fleet control or private worker telemetry', async () => {
    const session = await createSession({cwd, sessionsDir});
    const durable: ModelMessage[] = [{role: 'user', content: '/fleet audit'}];
    await appendSessionEntry(session, {type: 'conversation_snapshot', at: '1', messages: durable});
    await appendSessionEntry(session, {type: 'event', at: '2', name: 'retry', text: JSON.stringify({type: 'retry', attempt: 1, maxAttempts: 2, delayMs: 0, error: 'overloaded', at: '2'})});
    const output = {capsule: {id: 'w', termination: 'completed', usable: true, deliverable: 'compact result'}, telemetry: {modelSelector: 'p:m', profile: 'local-safe', toolCalls: [{name: 'readFile', summary: 'PRIVATE WORKER DETAIL'}], usage: {inputTokens: 999}}};
    await appendSessionEntry(session, {type: 'event', at: '3', name: 'tool_end', text: JSON.stringify({type: 'tool_end', id: 'sub', name: 'subagent', success: true, output, durationMs: 1, at: '3'})});
    await appendSessionEntry(session, {type: 'conversation_snapshot', at: '4', messages: [...durable, {role: 'assistant', content: 'compact result'}]});

    const restored = await restoreConversation(session);
    const {entries} = await readSessionEntries(session);
    const disk = JSON.stringify(entries);
    expect(restored.messages).toEqual([...durable, {role: 'assistant', content: 'compact result'}]);
    expect(disk).toContain('/fleet audit');
    expect(disk).toContain('compact result');
    expect(disk).not.toContain('PRIVATE FLEET CONTROL');
    expect(disk).not.toContain('PRIVATE WORKER DETAIL');
    expect(disk).not.toContain('inputTokens');
  });

  it('slims large tool results in conversation snapshots', async () => {
    const session = await createSession({cwd, sessionsDir});
    const messages: ModelMessage[] = [{
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call',
        toolName: 'readFile',
        output: {type: 'json', value: {content: 'x'.repeat(40_000)}},
      }],
    }];
    await appendSessionEntry(session, {type: 'conversation_snapshot', at: '1', messages});

    const restored = await restoreConversation(session);
    const content = restored.messages[0]?.content;
    const toolResult = Array.isArray(content) ? content[0] as {output?: {omitted?: boolean; originalBytes?: number}} : undefined;
    expect(toolResult?.output?.omitted).toBe(true);
    expect(toolResult?.output?.originalBytes).toBeGreaterThan(32_000);
  });

  it('slims image file parts to placeholders so sessions never store image bytes (F03, AC4)', async () => {
    const session = await createSession({cwd, sessionsDir});
    const imageData = 'A'.repeat(40_000); // base64-shaped payload
    const messages: ModelMessage[] = [{
      role: 'user',
      content: [
        {type: 'text', text: 'fix this layout'},
        {type: 'file', mediaType: 'image/png', data: imageData, filename: 'shot.png'},
      ],
    }];
    await appendSessionEntry(session, {type: 'conversation_snapshot', at: '1', messages});

    const disk = await fs.readFile(session.file, 'utf8');
    expect(disk).not.toContain(imageData.slice(0, 1000));

    const restored = await restoreConversation(session);
    const parts = restored.messages[0]?.content;
    expect(Array.isArray(parts)).toBe(true);
    const list = parts as Array<{type?: string; text?: string}>;
    expect(list[0]).toEqual({type: 'text', text: 'fix this layout'});
    // The placeholder is a text part: resumed conversations stay protocol-safe.
    expect(list[1]?.type).toBe('text');
    expect(list[1]?.text).toContain('shot.png');
    expect(list[1]?.text).toContain('image/png');
    expect(list[1]?.text).toContain('omitted from session');
  });

  it('keeps snapshot lines bounded even for megabyte image parts (F03)', async () => {
    const session = await createSession({cwd, sessionsDir});
    const messages: ModelMessage[] = [{
      role: 'user',
      content: [
        {type: 'text', text: 'see screenshot'},
        {type: 'file', mediaType: 'image/png', data: new Uint8Array(1_200_000), filename: 'big.png'},
      ],
    }];
    await appendSessionEntry(session, {type: 'conversation_snapshot', at: '1', messages});

    expect((await fs.stat(session.file)).size).toBeLessThan(64 * 1024);
    const restored = await restoreConversation(session);
    expect(restored.parseErrors).toEqual([]);
    expect(restored.messages).toHaveLength(1);
  });

  it('restores conversation and work state in one pass with parse errors reported once (regression CR-013)', async () => {
    const session = await createSession({cwd, sessionsDir});
    const messages: ModelMessage[] = [{role: 'user', content: 'hello'}];
    const state = createWorkState('goal', 'implementation', ['done']);
    await appendSessionEntry(session, {type: 'conversation_snapshot', at: '1', messages});
    await appendSessionEntry(session, {type: 'work_state_snapshot', at: '2', state});
    await fs.appendFile(session.file, '{not valid json\n');

    const restored = await restoreSessionState(session);
    expect(restored.messages).toEqual(messages);
    expect(restored.workState).toEqual(state);
    // One scan: each malformed line surfaces exactly once.
    expect(restored.parseErrors).toHaveLength(1);
    expect(restored.parseErrors[0]).toContain('Line 4');
  });

  it('vacuums superseded snapshots once they dominate the file, preserving restore and browsing (F-03)', async () => {
    setSessionVacuumThresholdForTests(4_096);
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: '0', role: 'user', text: 'begin'});
    const filler = 'x'.repeat(1_500);
    for (let turn = 1; turn <= 6; turn++) {
      await appendSessionEntry(session, {type: 'conversation_snapshot', at: String(turn), messages: [{role: 'user', content: `${filler} #${turn}`}] as ModelMessage[]});
      await appendSessionEntry(session, {type: 'work_state_snapshot', at: String(turn), state: createWorkState(`goal-${turn}`, 'implementation', ['done'])});
      await appendSessionEntry(session, {type: 'ui_message', at: String(turn), role: 'assistant', text: `answer ${turn}`});
    }

    const {entries} = await readSessionEntries(session);
    // Superseded snapshots are dropped at each threshold crossing; at most one
    // pre-vacuum survivor of each type can remain alongside the newest (the
    // vacuum runs inside the append that crossed the threshold, not after).
    const snapshots = entries.filter(entry => entry.type === 'conversation_snapshot');
    const workStates = entries.filter(entry => entry.type === 'work_state_snapshot');
    expect(snapshots.length).toBeLessThanOrEqual(2);
    expect(workStates.length).toBeLessThanOrEqual(2);
    expect(snapshots.length).toBeLessThan(6);
    expect(snapshots.at(-1)).toMatchObject({messages: [{role: 'user', content: `${filler} #6`}] as never});
    expect(workStates.at(-1)).toMatchObject({state: {goal: 'goal-6'}});
    const uiMessages = entries.filter(entry => entry.type === 'ui_message');
    expect(uiMessages.map(entry => (entry as {text: string}).text)).toEqual(['begin', 'answer 1', 'answer 2', 'answer 3', 'answer 4', 'answer 5', 'answer 6']);

    // Restore semantics are unchanged: the newest snapshot wins.
    const restored = await restoreSessionState(session);
    expect(restored.messages).toEqual([{role: 'user', content: `${filler} #6`}]);
    expect(restored.workState).toMatchObject({goal: 'goal-6'});
    expect(restored.parseErrors).toEqual([]);

    // And the vacuum actually shrank the file versus the quadratic shape.
    const size = (await fs.stat(session.file)).size;
    expect(size).toBeLessThan(4_096 * 2);
  });
  it('does not vacuum below the threshold or when a rewrite would not halve the file (F-03)', async () => {
    setSessionVacuumThresholdForTests(4_096);
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: '0', role: 'user', text: 'begin'});
    await appendSessionEntry(session, {type: 'conversation_snapshot', at: '1', messages: [{role: 'user', content: 'small'}] as ModelMessage[]});
    // Below threshold: a direct vacuum call is a no-op.
    await expect(vacuumSessionFileIfLarge(session)).resolves.toBe(false);
    const {entries} = await readSessionEntries(session);
    expect(entries.filter(entry => entry.type === 'conversation_snapshot')).toHaveLength(1);

    // A file that is over threshold but dominated by one giant snapshot (plus
    // one small superseded one) would not halve, so it is left alone.
    const big = 'y'.repeat(6_000);
    await appendSessionEntry(session, {type: 'conversation_snapshot', at: '2', messages: [{role: 'user', content: big}] as ModelMessage[]});
    const before = await fs.stat(session.file);
    await expect(vacuumSessionFileIfLarge(session)).resolves.toBe(false);
    expect((await fs.stat(session.file)).size).toBe(before.size);
  });
});
