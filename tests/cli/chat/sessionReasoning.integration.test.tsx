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
import type {inputSuggestionsForState} from '../../../src/cli/chat/inputSuggestions.js';
import {FixtureInput, FixtureOutput} from '../../inkHarness.js';

const fixture = vi.hoisted(() => ({
  home: '',
  goal: vi.fn<(options: Parameters<typeof runAgentGoal>[0]) => ReturnType<typeof runAgentGoal>>(),
  suggestions: vi.fn<typeof inputSuggestionsForState>(),
}));
fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-session-reasoning-'));
const settings: HazeSettings = {
  provider: 'fixture', model: 'fixture-model',
  providers: [{name: 'fixture', url: 'http://localhost:1234/v1', models: ['fixture-model']}],
};
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
vi.mock('../../../src/config/settings.js', () => ({readSettings: async () => settings}));
vi.mock('../../../src/config/inputHistory.js', () => ({readInputHistory: async () => [], addInputHistoryItem: async () => []}));
vi.mock('../../../src/core/tasks/taskStorage.js', () => ({loadTasks: async () => [], clearTasks: async () => {}}));
vi.mock('../../../src/core/process/backgroundRegistry.js', () => ({backgroundProcessCount: () => 0, subscribeBackgroundProcesses: () => () => {}, teardownBackgroundProcesses: async () => {}}));
vi.mock('../../../src/cli/chat/startupSequence.js', () => ({
  currentBranchName: async () => undefined,
  runStartupSequence: async (options: Parameters<typeof runStartupSequence>[0]) => {
    options.onLoaded({settings, contextFiles: [], branchName: undefined, settingsError: undefined});
    await options.initializeSession();
  },
}));
vi.mock('../../../src/cli/chat/inputSuggestions.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/cli/chat/inputSuggestions.js')>();
  fixture.suggestions.mockImplementation(actual.inputSuggestionsForState);
  return {...actual, inputSuggestionsForState: fixture.suggestions};
});
vi.mock('../../../src/cli/commands/streaming/goalSupervisor.js', () => ({runAgentGoal: fixture.goal}));
const {chatCommand} = await import('../../../src/cli/commands/chat.js');
const {createSession, appendSessionEntry} = await import('../../../src/core/session/sessionStore.js');

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

it.each(['new', 'resume', 'fork'])('synchronizes reasoning status, picker, and next request after %s', async kind => {
  const source = await createSession();
  await appendSessionEntry(source, {type: 'ui_message', at: 'now', role: 'user', text: 'synthetic source session'});
  await appendSessionEntry(source, {type: 'conversation_snapshot', at: 'now', messages: [{role: 'user', content: 'synthetic source session'}]});
  streams = {stdin: new FixtureInput(), stdout: new FixtureOutput(), stderr: new FixtureOutput()};
  fixture.goal.mockResolvedValue({status: 'complete', stopReason: 'completed', cycles: 1, escalations: 0});
  running = chatCommand();
  await expect.poll(frame).toContain('fixture:fixture-model (medium)');
  await submit('/reasoning xhigh');
  await expect.poll(frame).toContain('fixture:fixture-model (xhigh)');
  expect(fixture.suggestions.mock.calls.at(-1)?.[0].sessionReasoning).toEqual({'fixture:fixture-model': 'xhigh'});
  if (kind === 'fork') {
    await submit('/resume');
    await expect.poll(() => fixture.suggestions.mock.calls.at(-1)?.[0].mode).toBe('sessions');
    await submit(source.id);
    await expect.poll(() => fixture.suggestions.mock.calls.at(-1)?.[0].mode).toBe('sessionAction');
    await submit('fork');
  } else {
    await submit(kind === 'new' ? '/new' : `/resume ${source.id}`);
  }
  await expect.poll(frame).toContain('fixture:fixture-model (medium)');
  expect(fixture.suggestions.mock.calls.at(-1)?.[0].sessionReasoning).toBeUndefined();
  await submit('/reasoning');
  await expect.poll(() => fixture.suggestions.mock.calls.at(-1)?.[0].mode).toBe('reasoning');
  expect(fixture.suggestions.mock.results.at(-1)?.value).toContainEqual(expect.objectContaining({value: 'medium', description: 'moderate reasoning · active'}));
  streams.stdin.write('\x1b');
  await expect.poll(() => fixture.suggestions.mock.calls.at(-1)?.[0].mode).toBe('chat');
  await submit('synthetic follow-up');
  await expect.poll(() => fixture.goal.mock.calls.length).toBe(1);
  expect(fixture.goal.mock.calls[0]?.[0].session?.reasoningByModel).toBeUndefined();
  streams.stdin.write('\x03');
  await running;
});
