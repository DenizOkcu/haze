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
import * as markdownText from '../../../src/ui/components/MarkdownText.js';
import {FixtureInput, FixtureOutput} from '../../inkHarness.js';

// Per-render work regression (FE-03): a re-render that leaves every message
// untouched must not re-run Markdown root chunking over the whole transcript.
const fixture = vi.hoisted(() => ({
  home: '',
  settings: {} as HazeSettings,
  goal: vi.fn<(options: Parameters<typeof runAgentGoal>[0]) => ReturnType<typeof runAgentGoal>>(),
}));
fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-render-work-'));
let streams: {stdin: FixtureInput; stdout: FixtureOutput; stderr: FixtureOutput};
let app: Instance | undefined;
let running: Promise<void> | undefined;
vi.mock('../../../src/config/paths.js', () => ({HAZE_DIR: fixture.home, GLOBAL_SKILLS_DIR: path.join(fixture.home, 'skills'), GLOBAL_PLUGINS_DIR: path.join(fixture.home, 'plugins')}));
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

it('does not re-run Markdown root chunking on re-renders that leave messages untouched (FE-03)', async () => {
  fixture.settings = {provider: 'fixture', model: 'm', providers: [{name: 'fixture', url: 'http://localhost:1234/v1', models: ['m']}]};
  streams = {stdin: new FixtureInput(), stdout: new FixtureOutput(), stderr: new FixtureOutput()};
  fixture.goal.mockImplementation(async options => {
    options.callbacks.addMessage({id: 'a1', role: 'assistant', text: '# Plan\n\nFirst **paragraph**.\n\nSecond paragraph.', streaming: false});
    return {status: 'complete', stopReason: 'completed', cycles: 1, escalations: 0};
  });
  const chunks = vi.spyOn(markdownText, 'markdownRootChunks');
  try {
    running = chatCommand({});
    await expect.poll(() => streams.stdout.writes.length).toBeGreaterThan(0);
    streams.stdin.write('summarize');
    await app!.waitUntilRenderFlush();
    streams.stdin.write('\r');
    await expect.poll(() => stripAnsi(streams.stdout.writes.join(''))).toContain('Second paragraph');
    await app!.waitUntilRenderFlush();
    expect(fixture.goal.mock.calls.length).toBe(1);
    const settled = chunks.mock.calls.length;
    expect(settled).toBeGreaterThan(0);
    // Ctrl+O toggles the task bar: twenty re-renders that change no message.
    for (let index = 0; index < 20; index++) {
      streams.stdin.write('\x0f');
      await app!.waitUntilRenderFlush();
    }
    expect(stripAnsi(streams.stdout.writes.join(''))).toContain('Second paragraph');
    expect(chunks.mock.calls.length).toBe(settled);
  } finally {
    chunks.mockRestore();
  }
});
