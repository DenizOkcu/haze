import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import type {ModelMessage} from 'ai';
import {createWorkState} from '../../src/core/agent/workState.js';
import {appendSessionEntry, createSession, latestSession, readSessionEntries, restoreConversation, restoreSessionState, restoreWorkState} from '../../src/core/session/sessionStore.js';
import {JSONL_LINE_BYTES} from '../../src/core/limits/byteBudgets.js';

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

  it('creates distinct sessions even within the same millisecond (regression CR-025)', async () => {
    const [first, second] = await Promise.all([createSession({cwd, sessionsDir}), createSession({cwd, sessionsDir})]);
    expect(first.id).not.toBe(second.id);
    expect(first.file).not.toBe(second.file);
    expect(await fs.pathExists(first.file)).toBe(true);
    expect(await fs.pathExists(second.file)).toBe(true);
    // Timestamp prefix still drives latestSession() ordering.
    const latest = await latestSession(cwd, sessionsDir);
    expect([first.id, second.id]).toContain(latest?.id);
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
    await fs.appendFile(session.file, `${'x'.repeat(JSONL_LINE_BYTES + 1)}\n`, 'utf8');
    await appendSessionEntry(session, {type: 'ui_message', at: '2', role: 'user', text: 'after'});
    const {entries, parseErrors} = await readSessionEntries(session);
    expect(entries.at(-1)).toMatchObject({type: 'ui_message', text: 'after'});
    expect(parseErrors).toContain(`Line 2: exceeds ${JSONL_LINE_BYTES} byte limit`);
  });

  it('returns no parse errors for a clean session file', async () => {
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'ui_message', at: 'now', role: 'user', text: 'hello'});
    const {parseErrors} = await readSessionEntries(session);
    expect(parseErrors).toEqual([]);
  });

  it('does not persist streaming message_update events', async () => {
    const session = await createSession({cwd, sessionsDir});
    await appendSessionEntry(session, {type: 'event', at: '1', name: 'message_update', text: JSON.stringify({type: 'message_update', id: 'a', text: 'partial', at: '1'})});
    await appendSessionEntry(session, {type: 'event', at: '2', name: 'message_end', text: JSON.stringify({type: 'message_end', id: 'a', text: 'done', at: '2'})});

    const {entries} = await readSessionEntries(session);
    expect(entries.map(entry => entry.type === 'event' ? entry.name : entry.type)).toEqual(['header', 'message_end']);
  });

  it('slims large tool_end event outputs before writing', async () => {
    const session = await createSession({cwd, sessionsDir});
    const largeOutput = {content: 'x'.repeat(40_000)};
    await appendSessionEntry(session, {type: 'event', at: '1', name: 'tool_end', text: JSON.stringify({type: 'tool_end', id: 'call', name: 'readFile', success: true, output: largeOutput, durationMs: 1, at: '1'})});

    const {entries} = await readSessionEntries(session);
    const eventEntry = entries[1];
    expect(eventEntry).toMatchObject({type: 'event', name: 'tool_end'});
    const event = JSON.parse(eventEntry.type === 'event' ? eventEntry.text ?? '{}' : '{}') as {output: {omitted?: boolean; originalBytes?: number; preview?: string}};
    expect(event.output.omitted).toBe(true);
    expect(event.output.originalBytes).toBeGreaterThan(32_000);
    expect(event.output.preview?.length).toBeLessThan(10_000);
  });

  it('slims tool_start inputs to byte counts so written file content never reaches the session file (regression CR-031)', async () => {
    const session = await createSession({cwd, sessionsDir});
    const writtenContent = 'SECRET_FILE_CONTENT '.repeat(4_000);
    await appendSessionEntry(session, {type: 'event', at: '1', name: 'tool_start', text: JSON.stringify({type: 'tool_start', id: 'call', name: 'writeFile', input: {path: 'src/app.ts', content: writtenContent}, at: '1'})});

    const raw = await fs.readFile(session.file, 'utf-8');
    expect(raw).not.toContain('SECRET_FILE_CONTENT');
    const {entries} = await readSessionEntries(session);
    const event = JSON.parse(entries[1]?.type === 'event' ? entries[1].text ?? '{}' : '{}') as {id: string; name: string; input: {inputBytes?: number; path?: string; content?: string}};
    expect(event.id).toBe('call');
    expect(event.name).toBe('writeFile');
    expect(event.input.content).toBeUndefined();
    expect(event.input.path).toBe('src/app.ts');
    expect(event.input.inputBytes).toBeGreaterThan(50_000);
  });

  it('persists only subagent capsule and bounded scheduler metadata in tool events', async () => {
    const session = await createSession({cwd, sessionsDir});
    const output = {capsule: {id: 'w', termination: 'completed', usable: true, deliverable: 'done'}, telemetry: {modelSelector: 'p:m', profile: 'local-safe', durationMs: 10, queueMs: 2, toolCallCount: 1, toolCalls: [{name: 'readFile', summary: 'private detail'}], usage: {inputTokens: 99}}};
    await appendSessionEntry(session, {type: 'event', at: '1', name: 'tool_end', text: JSON.stringify({type: 'tool_end', id: 'call', name: 'subagent', success: true, output, durationMs: 1, at: '1'})});
    const {entries} = await readSessionEntries(session);
    const event = JSON.parse(entries[1]?.type === 'event' ? entries[1].text ?? '{}' : '{}');
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
});
