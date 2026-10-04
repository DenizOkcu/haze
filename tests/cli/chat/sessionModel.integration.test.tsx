import {afterAll, afterEach, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import stripAnsi from 'strip-ansi';
import type {ReactNode} from 'react';
import type {RenderOptions, Instance} from 'ink';
import type {HazeSettings} from '../../../src/config/settings.js';
import type {runAgentGoal} from '../../../src/cli/commands/streaming/goalSupervisor.js';
import type {runStartupSequence} from '../../../src/cli/chat/startupSequence.js';
import {FixtureInput, FixtureOutput} from '../../inkHarness.js';

const fixture = vi.hoisted(() => ({
  home: '',
  settings: {} as HazeSettings,
  goal: vi.fn<(options: Parameters<typeof runAgentGoal>[0]) => ReturnType<typeof runAgentGoal>>(),
}));
fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-session-model-'));
let streams: {stdin: FixtureInput; stdout: FixtureOutput; stderr: FixtureOutput};
let app: Instance | undefined;
let running: Promise<void> | undefined;
vi.mock('../../../src/config/paths.js', () => ({HAZE_DIR: fixture.home, GLOBAL_SKILLS_DIR: path.join(fixture.home, 'skills')}));
vi.mock('ink', async importOriginal => {
  const ink = await importOriginal<typeof import('ink')>();
  return {...ink, render: (node: ReactNode, options: RenderOptions) => {
    app = ink.render(node, {...options, ...streams, interactive: true, patchConsole: false, incrementalRendering: false, kittyKeyboard: {mode: 'disabled'}});
    return app;
  }};
});
vi.mock('../../../src/config/settings.js', () => ({
  readSettings: async () => fixture.settings,
  updateSettings: async (patch: HazeSettings) => (fixture.settings = {...fixture.settings, ...patch}),
}));
vi.mock('../../../src/config/inputHistory.js', () => ({readInputHistory: async () => [], addInputHistoryItem: async () => []}));
vi.mock('../../../src/core/tasks/taskStorage.js', () => ({loadTasks: async () => [], clearTasks: async () => {}}));
vi.mock('../../../src/core/process/backgroundRegistry.js', () => ({backgroundProcessCount: () => 0, subscribeBackgroundProcesses: () => () => {}, teardownBackgroundProcesses: async () => {}}));
vi.mock('../../../src/cli/chat/startupSequence.js', () => ({
  currentBranchName: async () => undefined,
  runStartupSequence: async (options: Parameters<typeof runStartupSequence>[0]) => {
    options.onLoaded({settings: fixture.settings, contextFiles: [], branchName: undefined, settingsError: undefined});
    await options.initializeSession();
  },
}));
vi.mock('../../../src/cli/commands/streaming/goalSupervisor.js', () => ({runAgentGoal: fixture.goal}));
const {chatCommand} = await import('../../../src/cli/commands/chat.js');
const {createSession, appendSessionEntry, restoreSessionState, listSessions, findSession} = await import('../../../src/core/session/sessionStore.js');

afterEach(async () => {
  app?.unmount();
  await running;
  app?.cleanup();
  streams.stdin.destroy(); streams.stdout.destroy(); streams.stderr.destroy();
  vi.clearAllMocks();
});
afterAll(async () => { await fs.remove(fixture.home); });

function frame() {
  return streams.stdout.writes.map(text => stripAnsi(text)).filter(text => text.trim()).at(-1) ?? '';
}
async function submit(text: string) {
  streams.stdin.write(text);
  await app!.waitUntilRenderFlush();
  streams.stdin.write('\r');
  await app!.waitUntilRenderFlush();
}

it.each(['startup', 'resume', 'latest', 'fork', 'picker'])('keeps the session model through %s, settings changes, and explicit reselection', async kind => {
  fixture.settings = {
    provider: 'fixture', model: 'new-model',
    providers: [{name: 'fixture', url: 'http://localhost:1234/v1', models: ['old-model', 'new-model']}],
  };
  const source = await createSession();
  await appendSessionEntry(source, {type: 'model_selection', at: 'now', selection: {provider: 'fixture', model: 'old-model'}});
  await appendSessionEntry(source, {type: 'conversation_snapshot', at: 'now', messages: [{role: 'user', content: 'synthetic source'}]});
  const existingIds = new Set((await listSessions()).map(session => session.id));
  streams = {stdin: new FixtureInput(), stdout: new FixtureOutput(), stderr: new FixtureOutput()};
  fixture.goal.mockImplementation(async options => {
    options.callbacks.setConversation([{role: 'user', content: options.request}]);
    return {status: 'complete', stopReason: 'completed', cycles: 1, escalations: 0};
  });
  running = chatCommand(kind === 'startup' ? {resumeSessionId: source.id} : kind === 'latest' ? {continueSession: true} : {});
  if (kind === 'resume' || kind === 'fork' || kind === 'picker') {
    await expect.poll(frame).toContain('fixture:new-model');
    if (kind !== 'fork') await submit(`/resume ${source.id}`);
    else {
      await submit('/resume');
      await expect.poll(frame).toContain(source.id);
      await submit(source.id);
      await expect.poll(frame).toContain('fork');
      await submit('fork');
    }
  }
  await expect.poll(frame).toContain('fixture:old-model');
  expect(fixture.settings.model).toBe('new-model'); // resume never rewrites the global default
  await submit('/tips'); // unrelated settings writes return the global model
  await expect.poll(frame).toContain('fixture:old-model');
  await submit('synthetic follow-up');
  await expect.poll(() => fixture.goal.mock.calls.length).toBe(1);
  expect(fixture.goal.mock.calls[0]?.[0].modelOverride).toBe('fixture:old-model');
  if (kind === 'picker') {
    await submit('/model');
    await submit('fixture:new-model');
  } else await submit('/model fixture:new-model');
  await expect.poll(frame).toContain('fixture:new-model');
  await submit('another follow-up');
  await expect.poll(() => fixture.goal.mock.calls.length).toBe(2);
  expect(fixture.goal.mock.calls[1]?.[0].modelOverride).toBe('fixture:new-model');
  streams.stdin.write('\x03');
  await running;
  const forkId = (await listSessions()).find(session => !existingIds.has(session.id))?.id;
  const active = kind === 'fork' ? await findSession(forkId!) : source;
  expect((await restoreSessionState(active!)).modelSelection).toEqual({provider: 'fixture', model: 'new-model'});
});

it('pins a new session even when another session changes the global default', async () => {
  fixture.settings = {
    provider: 'fixture', model: 'old-model',
    providers: [{name: 'fixture', url: 'http://localhost:1234/v1', models: ['old-model', 'new-model']}],
  };
  const existingIds = new Set((await listSessions()).map(session => session.id));
  streams = {stdin: new FixtureInput(), stdout: new FixtureOutput(), stderr: new FixtureOutput()};
  fixture.goal.mockImplementation(async options => {
    options.callbacks.setConversation([{role: 'user', content: options.request}]);
    return {status: 'complete', stopReason: 'completed', cycles: 1, escalations: 0};
  });
  running = chatCommand();
  await expect.poll(frame).toContain('fixture:old-model');
  await expect.poll(() => streams.stdout.writes.join('')).toContain('Session:');
  fixture.settings = {...fixture.settings, model: 'new-model'};
  await submit('/tips');
  await expect.poll(frame).toContain('fixture:old-model');
  await submit('first session follow-up');
  await expect.poll(() => fixture.goal.mock.calls.length).toBe(1);
  expect(fixture.goal.mock.calls[0]?.[0].modelOverride).toBe('fixture:old-model');
  await submit('/new');
  await expect.poll(() => streams.stdout.writes.join('').match(/Session:/g)?.length).toBe(2);
  await expect.poll(frame).toContain('fixture:new-model');
  await submit('new session follow-up');
  await expect.poll(() => fixture.goal.mock.calls.length).toBe(2);
  expect(fixture.goal.mock.calls[1]?.[0].modelOverride).toBe('fixture:new-model');
  streams.stdin.write('\x03');
  await running;
  const created = (await listSessions()).filter(session => !existingIds.has(session.id));
  expect(created).toHaveLength(2);
  const models = await Promise.all(created.map(async summary => (await restoreSessionState((await findSession(summary.id))!)).modelSelection?.model));
  expect(models.sort()).toEqual(['new-model', 'old-model']);
});
