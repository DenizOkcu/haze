import {describe, expect, it, vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {ChatScreenDeps} from '../../../src/cli/chat/screenDeps.js';
import {NO_USER_COMMAND_MESSAGE, routeQueuedLine, runUserCommandLine} from '../../../src/cli/chat/userCommandFlow.js';
import {formatUserCommandRecord, USER_COMMAND_RESPONSE_REQUEST} from '../../../src/core/agent/userCommands.js';
import {createSession, restoreSessionState} from '../../../src/core/session/sessionStore.js';
import {createSessionRecorder} from '../../../src/cli/chat/sessionRecorder.js';

// Mock readSettings so tests never depend on the user's real ~/.haze/settings.json.
vi.mock('../../../src/config/settings.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/config/settings.js')>();
  return {...actual, readSettings: async () => ({})};
});

function makeDeps(overrides: {queue?: string[]; session?: Awaited<ReturnType<typeof createSession>>} = {}) {
  const messages: Array<{role: string; text: string}> = [];
  const queue = [...overrides.queue ?? []];
  const deps = {
    stoppingRef: {current: false},
    sealedRef: {current: false},
    abortControllerRef: {current: null as AbortController | null},
    conversationRef: {current: [] as never[]},
    settings: {},
    setMessages: vi.fn(),
    setBusy: vi.fn(),
    setBusyLabel: vi.fn(),
    finalizeMessage: (message: {role: string; text: string}) => { messages.push(message); },
    showPersistenceWarning: vi.fn(),
    prepareUserInput: vi.fn(async (value: string) => ({value, options: {}})),
    doAgentTurn: vi.fn(async () => undefined),
    followUps: {takeNext: () => queue.shift()},
    sessionRecorderRef: {current: overrides.session ? createSessionRecorder(() => overrides.session) : undefined},
  } as unknown as ChatScreenDeps;
  return {deps, messages, busyCalls: () => vi.mocked(deps.setBusy).mock.calls.map(call => call[0])};
}

describe('runUserCommandLine', () => {
  it('runs the command, records the row and the conversation record, and starts one model turn over the output', async () => {
    const {deps, messages, busyCalls} = makeDeps();
    await runUserCommandLine(deps, 'echo hello');
    expect(deps.doAgentTurn).toHaveBeenCalledTimes(1);
    expect(deps.doAgentTurn.mock.calls[0]).toEqual([USER_COMMAND_RESPONSE_REQUEST, '! echo hello']);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('tool');
    expect(messages[0]!.text).toMatch(/^\$ echo hello\nhello\nexit 0 · \d+ms$/);
    expect(busyCalls()).toEqual([true, false]);
    expect(deps.abortControllerRef.current).toBeNull();
    expect(deps.conversationRef.current).toHaveLength(1);
    expect((deps.conversationRef.current[0] as {content: string}).content).toContain(formatUserCommandRecord({command: 'echo hello', status: 'completed', exitCode: 0, durationMs: 0, stdout: {text: 'hello', truncated: false, filtered: false, omittedChars: 0}, stderr: {text: '', truncated: false, filtered: false, omittedChars: 0}}).slice(0, 60));
  });

  it('drains lines queued during the run: a `!` line runs, anything else goes to the agent', async () => {
    const {deps, messages} = makeDeps({queue: ['! echo second', 'and this?']});
    await runUserCommandLine(deps, 'echo first');
    expect(messages.map(message => message.text.split('\n')[0])).toEqual(['$ echo first', '$ echo second']);
    // One reaction turn per command, then the queued prompt.
    expect(deps.doAgentTurn.mock.calls.map(call => call[1])).toEqual(['! echo first', '! echo second', undefined]);
    expect(deps.doAgentTurn).toHaveBeenLastCalledWith('and this?', undefined, {});
  });


  it('reports a cancelled command and clears busy', async () => {
    const {deps, messages, busyCalls} = makeDeps();
    const pending = runUserCommandLine(deps, 'sleep 30');
    await vi.waitFor(() => expect(deps.abortControllerRef.current).toBeInstanceOf(AbortController));
    deps.abortControllerRef.current!.abort();
    await pending;
    expect(messages[0]!.text).toContain('cancelled · partial output shown');
    expect(deps.doAgentTurn).not.toHaveBeenCalled();
    expect(busyCalls().at(-1)).toBe(false);
  }, 10_000);

  it('makes the session resumable with only a record in it, and the record survives restore', async () => {
    const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-user-command-session-'));
    try {
      const session = await createSession({sessionsDir});
      const {deps} = makeDeps({session});
      await runUserCommandLine(deps, 'echo kept');
      await expect(fs.stat(session.file)).resolves.toBeDefined();
      const restored = await restoreSessionState(session);
      expect(restored.messages).toHaveLength(1);
      expect(String(restored.messages[0]!.content)).toContain('command: echo kept');
    } finally {
      await fs.rm(sessionsDir, {recursive: true, force: true});
    }
  });
});

describe('routeQueuedLine', () => {
  it('runs a queued `!` line, reports an empty one, and passes everything else through', async () => {
    const {deps, messages} = makeDeps();
    expect(await routeQueuedLine(deps, '! echo queued')).toEqual({handled: true});
    expect(messages.map(message => message.text.split('\n')[0])).toEqual(['$ echo queued']);
    expect(await routeQueuedLine(deps, '!')).toEqual({handled: true});
    expect(deps.setMessages).toHaveBeenCalled();
    expect(NO_USER_COMMAND_MESSAGE).toBe('No command given after "!".');
    expect(await routeQueuedLine(deps, '\\! literal')).toEqual({handled: false, value: '! literal'});
    // Only the run command starts a reaction turn; empty, escaped and plain lines do not.
    expect(deps.doAgentTurn.mock.calls).toEqual([[USER_COMMAND_RESPONSE_REQUEST, '! echo queued']]);
  });
});
