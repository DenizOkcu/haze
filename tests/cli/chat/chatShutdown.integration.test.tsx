import {afterEach, expect, it, vi} from 'vitest';
import type {ReactNode} from 'react';
import type {RenderOptions, Instance} from 'ink';
import type {runAgentGoal} from '../../../src/cli/commands/streaming/goalSupervisor.js';
import type {runStartupSequence} from '../../../src/cli/chat/startupSequence.js';
import {FixtureInput, FixtureOutput} from '../../inkHarness.js';

const owners = vi.hoisted(() => ({
  flush: vi.fn(async () => {}), record: vi.fn(), cleanup: vi.fn(async () => {}), clear: vi.fn(async () => {}),
  goal: vi.fn<(options: Parameters<typeof runAgentGoal>[0]) => ReturnType<typeof runAgentGoal>>(),
}));
let streams: {stdin: FixtureInput; stdout: FixtureOutput; stderr: FixtureOutput};
let app: Instance | undefined;
vi.mock('ink', async importOriginal => {
  const ink = await importOriginal<typeof import('ink')>();
  return {...ink, render: (node: ReactNode, options: RenderOptions) => {
    app = ink.render(node, {...options, ...streams, interactive: true, patchConsole: false, kittyKeyboard: {mode: 'disabled'}});
    return app;
  }};
});
vi.mock('../../../src/config/settings.js', () => ({readSettings: async () => ({})}));
vi.mock('../../../src/config/inputHistory.js', () => ({readInputHistory: async () => [], addInputHistoryItem: async () => []}));
vi.mock('../../../src/core/tasks/taskStorage.js', () => ({loadTasks: async () => [], clearTasks: owners.clear}));
vi.mock('../../../src/core/process/backgroundRegistry.js', () => ({backgroundProcessCount: () => 0, subscribeBackgroundProcesses: () => () => {}, teardownBackgroundProcesses: owners.cleanup}));
vi.mock('../../../src/cli/chat/startupSequence.js', () => ({
  currentBranchName: async () => undefined,
  runStartupSequence: async (options: Parameters<typeof runStartupSequence>[0]) => {
    options.onLoaded({settings: {}, contextFiles: [], branchName: undefined, settingsError: undefined});
  },
}));
vi.mock('../../../src/cli/chat/sessionRecorder.js', () => ({createSessionRecorder: () => ({
  recordUiMessage: owners.record, recordConversation: owners.record, recordEvent: owners.record,
  recordWorkState: owners.record, recordGoalEntry: owners.record, flush: owners.flush,
})}));
vi.mock('../../../src/cli/commands/streaming/goalSupervisor.js', () => ({runAgentGoal: owners.goal}));
import {chatCommand} from '../../../src/cli/commands/chat.js';

afterEach(async () => {
  app?.unmount();
  await app?.waitUntilExit();
  app?.cleanup();
  streams.stdin.destroy(); streams.stdout.destroy(); streams.stderr.destroy(); vi.clearAllMocks();
});
it.each(['slash', 'legacy interrupt', 'Kitty interrupt'])('uses the shared cleanup path for %s', async kind => {
  streams = {stdin: new FixtureInput(), stdout: new FixtureOutput(), stderr: new FixtureOutput()};
  owners.goal.mockImplementation(options => new Promise(resolve => {
    const controller = new AbortController();
    options.callbacks.setAbortController?.(controller);
    options.callbacks.setBusy(true);
    controller.signal.addEventListener('abort', () => {
      options.callbacks.setConversation([{role: 'user', content: 'fixture prompt'}]);
      resolve({status: 'aborted', stopReason: 'user-cancelled', cycles: 1, escalations: 0});
    }, {once: true});
  }));
  const running = chatCommand({noSession: true});
  await expect.poll(() => streams.stdout.writes.join('')).toContain('Ask haze to help build your app');
  if (kind !== 'slash') {
    streams.stdin.write('fixture prompt');
    await expect.poll(() => streams.stdout.writes.join('')).toContain('fixture prompt');
    streams.stdin.write('\r');
    await expect.poll(() => owners.goal.mock.calls.length).toBe(1);
    streams.stdin.write(kind === 'Kitty interrupt' ? '\x1b[99;5u' : '\x03');
    streams.stdin.write('\x1b[99;5u'); // Repeated request still flushes once.
  } else {
    streams.stdin.write('/exit');
    await expect.poll(() => streams.stdout.writes.join('')).toContain('/exit');
    streams.stdin.write('\r');
  }
  await running;
  expect(owners.flush).toHaveBeenCalledTimes(1);
  expect(owners.cleanup).toHaveBeenCalledTimes(1);
  expect(owners.clear).toHaveBeenCalledTimes(2); // startup plus shutdown
  expect(streams.stdin.isRaw).toBe(false);
  const recorded = owners.record.mock.calls.length;
  const callbacks = owners.goal.mock.calls[0]?.[0].callbacks;
  callbacks?.setConversation([{role: 'user', content: 'late fixture'}]);
  callbacks?.addMessage({role: 'system', text: 'late fixture'});
  expect(owners.record).toHaveBeenCalledTimes(recorded);
});
