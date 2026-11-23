import {afterAll, afterEach, expect, it, vi} from 'vitest';
import fs from '../../fsExtra.js';
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
fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-wizard-back-'));
let streams: {stdin: FixtureInput; stdout: FixtureOutput; stderr: FixtureOutput};
let app: Instance | undefined;
let running: Promise<void> | undefined;
vi.mock('../../../src/core/paths.js', () => ({HAZE_DIR: fixture.home, GLOBAL_SKILLS_DIR: path.join(fixture.home, 'skills'), GLOBAL_PLUGINS_DIR: path.join(fixture.home, 'plugins')}));
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

async function escape() {
  streams.stdin.write('\x1b');
  await app!.waitUntilRenderFlush();
}
async function text() {
  return stripAnsi(streams.stdout.writes.join('')).replace(/\s+/g, ' ');
}

it('goes back one wizard step on Esc with the selection retained, and exits from the root (UX-03)', async () => {
  fixture.settings = {
    provider: 'fixture', model: 'm',
    providers: [{name: 'fixture', url: 'http://localhost:1234/v1', models: ['old-model', 'new-model']}],
  };
  streams = {stdin: new FixtureInput(), stdout: new FixtureOutput(), stderr: new FixtureOutput()};
  fixture.goal.mockResolvedValue({status: 'complete', stopReason: 'completed', cycles: 1, escalations: 0});
  running = chatCommand({});
  await expect.poll(() => text()).toContain('Ask haze to help build your app');

  await submit('/provider');
  await expect.poll(() => frame()).toContain('Choose provider');
  await submit('fixture');
  await expect.poll(() => frame()).toContain('Choose provider action');

  // Esc pops one step: back on the provider list, nothing written.
  await escape();
  await expect.poll(frame).not.toContain('Choose provider action');
  expect(frame()).toContain('Choose provider');
  expect(fixture.settings.model).toBe('m');
  // The root step exits to chat.
  await escape();
  await expect.poll(frame).toContain('Ask haze to help build your app');
});
