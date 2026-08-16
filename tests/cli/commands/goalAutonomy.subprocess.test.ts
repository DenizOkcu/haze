import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import fs from 'fs-extra';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gitHeadCommit} from '../../../src/utils/buildInfo.js';

// The exact regression guard for the stale-runtime failure: this test invokes
// the SAME bin/haze.js users execute — the built CLI as a real subprocess,
// never imported source modules — against a scripted OpenAI-compatible mock
// provider. It replays the interrupted-goal scenario end to end: declared
// pending tasks, a real workspace mutation, a FAILED validation, a physical
// turn ending at the step budget with finish reason `tool-calls`, an automatic
// supervisor continuation (cycle 2), a fix, a PASSING validation, and terminal
// completion. If the running build lacks the goal supervisor (the 0.10.0
// failure mode), the intermediate failed turn becomes the final result and
// this test fails.

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const binPath = path.join(repoRoot, 'bin', 'haze.js');

function repoBuild(): {version: string; commit?: string} | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, 'dist', 'buildInfo.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

const build = repoBuild();
const headCommit = gitHeadCommit(repoRoot);
// Requires a current build: the launcher refuses stale/incomplete dist, and a
// skipped test must never stand in for a passing one silently.
const buildCurrent = Boolean(
  build?.version === JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
  && fs.existsSync(path.join(repoRoot, 'dist', 'cli', 'index.js'))
  && (!build?.commit || !headCommit || build.commit === headCommit),
);

type RequestMessage = {role: string; content?: unknown};

const BROKEN_GREET = "module.exports = {greet: (name) => 'goodbye ' + name};\n";

interface ChunkDelta {
  content?: string;
  tool_calls?: Array<{index: number; id: string; type: 'function'; function: {name: string; arguments: string}}>;
}

function chunk(delta: ChunkDelta, finishReason: string | null) {
  return {id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'mock-1', choices: [{index: 0, delta, finish_reason: finishReason}]};
}

const USAGE_CHUNK = {id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'mock-1', choices: [], usage: {prompt_tokens: 25, completion_tokens: 5}};

function toolCallResponse(callId: string, name: string, input: unknown, text?: string) {
  return [
    ...(text ? [chunk({content: text}, null)] : []),
    chunk({tool_calls: [{index: 0, id: callId, type: 'function', function: {name, arguments: JSON.stringify(input)}}]}, null),
    chunk({}, 'tool_calls'),
    USAGE_CHUNK,
  ];
}

function textResponse(text: string) {
  return [chunk({content: text}, null), chunk({}, 'stop'), USAGE_CHUNK];
}

/**
 * Deterministic scenario controller. Cycle 1 declares pending tasks, writes a
 * broken greet.js (real mutation), runs `npm test` (real failing validation),
 * then keeps issuing read-only inspection calls until the turn's step budget
 * forces a `tool-calls` finish. Cycle 2 (after the supervisor's synthetic
 * continuation control) fixes the module, reruns the test, completes the task
 * list, and answers.
 */
function nextResponse(messages: RequestMessage[]): {kind: 'chunks'; chunks: unknown[]; label: string} {
  // Only the goal supervisor's cross-turn continuation control counts; other
  // synthetic controls (repeated-tool nudges) must not switch the script.
  const controlIndex = messages.map(message => typeof message.content === 'string' && message.content.includes('Continue the active goal')).lastIndexOf(true);
  const isContinuation = controlIndex >= 0;
  const toolMessages = messages.filter(message => message.role === 'tool');
  const toolCount = isContinuation ? messages.slice(controlIndex + 1).filter(message => message.role === 'tool').length : toolMessages.length;

  if (!isContinuation) {
    if (toolCount === 0) {
      return {kind: 'chunks', chunks: toolCallResponse('call-tasks-1', 'writeTasks', {tasks: [
        {title: 'Write the greet module', status: 'in_progress'},
        {title: 'Make npm test pass', status: 'pending'},
        {title: 'Run the test suite and report', status: 'pending'},
      ]}), label: 'declare tasks'};
    }
    if (toolCount === 1) {
      return {kind: 'chunks', chunks: toolCallResponse('call-write-1', 'writeFile', {path: 'greet.js', content: BROKEN_GREET}), label: 'write broken greet.js'};
    }
    if (toolCount === 2) {
      return {kind: 'chunks', chunks: toolCallResponse('call-test-1', 'bash', {command: 'npm test'}), label: 'run failing npm test'};
    }
    // Read-only inspection with unique inputs until the step budget ends the
    // physical turn (finish reason `tool-calls`). Substantive text keeps these
    // from counting as tool-only steps.
    return {kind: 'chunks', chunks: toolCallResponse(`call-grep-${toolCount}`, 'grep', {pattern: `presence-check-${toolCount}`, path: '.'}, `Inspection pass ${toolCount - 2}: confirming workspace state before the budget boundary.`), label: `inspection ${toolCount}`};
  }

  if (toolCount === 0) {
    return {kind: 'chunks', chunks: toolCallResponse('call-fix-1', 'editFile', {path: 'greet.js', edits: [{oldText: "'goodbye '", newText: "'hello '"}]}), label: 'fix greet.js'};
  }
  if (toolCount === 1) {
    return {kind: 'chunks', chunks: toolCallResponse('call-test-2', 'bash', {command: 'npm test'}), label: 'run passing npm test'};
  }
  if (toolCount === 2) {
    return {kind: 'chunks', chunks: toolCallResponse('call-tasks-2', 'writeTasks', {tasks: [
      {title: 'Write the greet module', status: 'completed'},
      {title: 'Make npm test pass', status: 'completed'},
      {title: 'Run the test suite and report', status: 'completed'},
    ]}), label: 'complete tasks'};
  }
  return {kind: 'chunks', chunks: textResponse('The greet module is implemented: greet(name) now returns "hello <name>", npm test passes, and all declared tasks are complete.'), label: 'final answer'};
}

interface MockCall {label: string; toolMessages: number; continuation: boolean}

async function startMockProvider(): Promise<{server: http.Server; url: string; calls: MockCall[]}> {
  const calls: MockCall[] = [];
  const server = http.createServer((request, response) => {
    const bodyChunks: Buffer[] = [];
    request.on('data', (data: Buffer) => bodyChunks.push(data));
    request.on('end', () => {
      let messages: RequestMessage[] = [];
      try {
        messages = (JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) as {messages?: RequestMessage[]}).messages ?? [];
      } catch {
        messages = [];
      }
      const decision = nextResponse(messages);
      const continuation = messages.some(message => typeof message.content === 'string' && message.content.includes('Continue the active goal'));
      calls.push({label: decision.label, toolMessages: messages.filter(message => message.role === 'tool').length, continuation});
      response.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
      for (const item of decision.chunks) response.write(`data: ${JSON.stringify(item)}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as {port: number};
  return {server, url: `http://127.0.0.1:${address.port}/v1`, calls};
}

function runHaze(args: string[], options: {cwd: string; home: string}): Promise<{code: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {cwd: options.cwd, env: {...process.env, HOME: options.home, NO_COLOR: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

describe.skipIf(!buildCurrent)('autonomous goal continuation (subprocess, real built CLI)', () => {
  let tmp: string;
  let home: string;
  let workspace: string;
  let mock: {server: http.Server; url: string; calls: MockCall[]};

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-goal-e2e-'));
    home = path.join(tmp, 'home');
    workspace = path.join(tmp, 'workspace');
    await fs.ensureDir(home);
    await fs.ensureDir(workspace);
    // Repo-shaped workspace: ignore evaluation is in-process, no git binary needed.
    await fs.ensureDir(path.join(workspace, '.git'));
    await fs.outputJson(path.join(workspace, 'package.json'), {name: 'greet', private: true, scripts: {test: 'node greet.test.js'}});
    await fs.writeFile(path.join(workspace, 'greet.test.js'), [
      "const assert = require('node:assert');",
      "const {greet} = require('./greet.js');",
      "assert.strictEqual(greet('world'), 'hello world');",
      "console.log('greet ok');",
      '',
    ].join('\n'));
    mock = await startMockProvider();
    // The mock model declares a large context window: the default localhost
    // fallback (32K) would trigger mid-turn history compaction, whose message
    // pruning desynchronizes the scripted scenario (tool-result counts shift).
    await fs.outputJson(path.join(home, '.haze', 'settings.json'), {
      provider: 'mock',
      model: 'mock-1',
      providers: [{name: 'mock', url: mock.url, key: 'test-key', models: ['mock-1'], modelLimits: {'mock-1': {contextWindowTokens: 512_000}}}],
    });
  });

  afterEach(async () => {
    mock.server.close();
    await fs.remove(tmp).catch(() => undefined);
  });

  it('continues across a tool-calls budget boundary and completes the goal', async () => {
    const result = await runHaze(['-p', 'Implement the greet module in greet.js so that npm test passes, and run the test suite to verify.', '--output', 'stream-json', '--debug'], {cwd: workspace, home});

    const lines = result.stdout.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    type StreamEvent = {type: string; status?: string; cycle?: number; cycles?: number; stopReason?: string; goal?: {cycles?: number; stopReason?: string; validationOutcome?: string; taskProgress?: {pending?: number; inProgress?: number; completed?: number}}};
    const events = lines.map(line => JSON.parse(line) as StreamEvent);

    // The logical goal opens the stream and the CLI result is the terminal completion.
    expect(events[0]).toMatchObject({type: 'goal_start'});
    const goalEnd = events.filter(event => event.type === 'goal_end');
    expect(goalEnd).toHaveLength(1);
    expect(goalEnd[0]).toMatchObject({status: 'complete'});
    expect(goalEnd[0].cycles).toBeGreaterThanOrEqual(2);

    // The budget-boundary turn ended incomplete (status failed at the physical
    // turn level) but the supervisor bridged it instead of exposing it as the
    // final result.
    const turnEnds = events.filter(event => event.type === 'turn_end');
    expect(turnEnds.length).toBeGreaterThanOrEqual(2);
    expect(turnEnds.some(event => event.status === 'failed')).toBe(true);
    const continues = events.filter(event => event.type === 'goal_continue');
    expect(continues.length).toBeGreaterThanOrEqual(1);
    // The event reports the just-finished physical cycle (1 = the boundary turn).
    expect(continues[0].cycle).toBeGreaterThanOrEqual(1);

    // The final result envelope reports structural completion, not the failed turn.
    const finalLine = events[events.length - 1];
    expect(finalLine).toMatchObject({type: 'result', status: 'complete'});
    expect(finalLine.goal).toMatchObject({stopReason: 'completed', validationOutcome: 'passed'});
    expect(finalLine.goal.cycles).toBeGreaterThanOrEqual(2);
    expect(finalLine.goal.taskProgress).toMatchObject({pending: 0, inProgress: 0, completed: 3});
    expect(result.code).toBe(0);

    // The real workspace reflects the fix: mutation happened in the subprocess, not in a mock.
    expect(await fs.readFile(path.join(workspace, 'greet.js'), 'utf8')).toContain("'hello '");

    // Capability provenance: the goal supervisor announced itself, and the
    // subprocess is provably the current build (version + commit).
    expect(result.stderr).toContain('goal supervisor enabled; automatic continuation across physical-turn budgets');
    const provenance = await runHaze(['--version', '--verbose'], {cwd: workspace, home});
    expect(provenance.code).toBe(0);
    expect(provenance.stdout).toContain(`Haze ${build!.version}`);
    if (build!.commit) expect(provenance.stdout).toContain(`commit: ${build!.commit}`);

    // The provider saw both physical cycles: a failed validation in cycle 1,
    // then the continuation-controlled cycle 2.
    expect(mock.calls.some(call => call.label === 'run failing npm test')).toBe(true);
    expect(mock.calls.some(call => call.continuation && call.label === 'run passing npm test')).toBe(true);
  }, 240_000);
});
