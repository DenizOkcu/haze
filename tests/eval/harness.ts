import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {it} from 'vitest';
import type {ModelMessage} from 'ai';
import {readContextFiles} from '../../src/config/contextFiles.js';
import {activeModel, resolveModelSelector} from '../../src/config/providers.js';
import {readSettings} from '../../src/config/settings.js';
import {runAgentGoal, type GoalLedgerAppend, type GoalRunResult} from '../../src/cli/commands/streaming/goalSupervisor.js';
import type {Message, StreamCallbacks} from '../../src/cli/commands/streaming.js';
import {EMPTY_TOKEN_USAGE, accumulateTokenUsage, type TokenUsage} from '../../src/cli/chat/turnState.js';
import {compactModelMessages} from '../../src/core/agent/compaction.js';
import {FALLBACK_CONTEXT_WINDOW_TOKENS} from '../../src/core/agent/contextBudget.js';
import type {AgentEvent} from '../../src/core/agent/events.js';
import {teardownBackgroundProcesses} from '../../src/core/process/backgroundRegistry.js';
import type {PromptSession} from '../../src/llm/systemPrompt.js';

/**
 * Model-backed behavioral eval harness (Pillar 4.1 of the Pi learning
 * roadmap). Unlike the unit suite (fake providers, pure policy modules),
 * these evals run the *real* turn stack — `runAgentGoal`, tools, budgets,
 * compaction, the goal supervisor — against a configured provider inside an
 * isolated throwaway workspace, and assert on the structured goal envelope
 * plus deterministic ground truth (running the fixture's own test command,
 * hashing files) rather than on response text.
 *
 * Gating: evals are skipped by the plain `vitest run` and enabled via
 * `npm run eval` (sets `HAZE_EVAL=1`). A missing provider configuration fails
 * loudly with a remediation hint.
 */

const evalEnabled = process.env.HAZE_EVAL === '1';

/** `it` when evals are enabled, `it.skip` otherwise (same vitest signature, including per-test options). */
export const evalIt = evalEnabled ? it : it.skip;

/** Optional model selector for every eval run (e.g. `openai:gpt-5.2`); unset uses the active model. */
function evalModelOverride(): string | undefined {
  return process.env.HAZE_EVAL_MODEL?.trim() || undefined;
}

function evalGoalDeadlineMs(): number {
  const parsed = Number.parseInt(process.env.HAZE_EVAL_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8 * 60_000;
}

/** Fail-fast provider preflight; returns an error message when evals cannot run. */
async function evalPreflight(): Promise<string | undefined> {
  const settings = await readSettings();
  const override = evalModelOverride();
  if (override) {
    const resolved = resolveModelSelector(settings, override);
    if (resolved.status === 'ambiguous') {
      return `HAZE_EVAL_MODEL "${override}" is ambiguous across providers: ${resolved.providers.map(provider => `${provider.name}:${resolved.model}`).join(', ')}. Use the provider:model form.`;
    }
    if (resolved.status === 'missing') {
      return `HAZE_EVAL_MODEL "${override}" is not a configured model. Run /provider to configure it, or unset HAZE_EVAL_MODEL to use the active model.`;
    }
    return undefined;
  }
  if (!activeModel(settings)) {
    return 'No model provider configured. Run /provider interactively to choose or add a provider, or set HAZE_EVAL_MODEL=provider:model.';
  }
  return undefined;
}

// ── Workspace helpers ────────────────────────────────────────────────────────

export interface WorkspaceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run a shell command inside a workspace (deterministic ground truth for evals). */
export function runWorkspaceCommand(workspace: string, command: string, timeoutMs = 120_000): WorkspaceCommandResult {
  const result = spawnSync(command, {cwd: workspace, shell: true, timeout: timeoutMs, encoding: 'utf8'});
  const tail = (value: string | undefined) => (value ?? '').slice(-4_000);
  return {exitCode: result.status ?? 1, stdout: tail(result.stdout), stderr: tail(result.stderr)};
}

/** Stable content hash of a workspace file (tamper detection). */
export function fileSha(workspace: string, relativePath: string): string {
  const content = fs.readFileSync(path.join(workspace, relativePath), 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

export function writeWorkspaceFile(workspace: string, relativePath: string, content: string): void {
  const target = path.join(workspace, relativePath);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, content);
}

// ── Bounded capture buffers ──────────────────────────────────────────────────

const MAX_CAPTURED_MESSAGES = 500;
const MAX_CAPTURED_EVENTS = 2_000;
const MAX_DEBUG_LINES = 400;

function pushBounded<T>(buffer: T[], value: T, limit: number) {
  if (buffer.length < limit) buffer.push(value);
}

// ── The harness ──────────────────────────────────────────────────────────────

export interface HazeEvalInput {
  /** Scenario name (kebab-case; names the artifact directory and the runs index). */
  name: string;
  /** The exact request sent to the goal supervisor. */
  request: string;
  /** Materialize the fixture workspace before the run; may return a value that rides on the result. */
  setup?: (workspace: string) => Promise<unknown> | unknown;
  /** Whole-goal wall-clock budget; defaults to HAZE_EVAL_TIMEOUT_MS or 8 minutes. */
  goalDeadlineMs?: number;
}

export interface HazeEvalResult<Setup = unknown> {
  /** The structured goal envelope — the primary assertion surface. */
  result: GoalRunResult;
  /** Value returned by the scenario's `setup`. */
  setup: Setup;
  /** Captured UI messages (user/assistant/system), bounded. */
  messages: Message[];
  /** Captured agent events, bounded. */
  events: AgentEvent[];
  /** Captured goal-ledger appends (supervisor boundaries). */
  goalLedger: GoalLedgerAppend[];
  /** Accumulated provider usage across every step. */
  usage: TokenUsage;
  /** The fixture workspace (kept for post-run ground-truth checks). */
  workspace: string;
  /** Final conversation state. */
  conversation: ModelMessage[];
  /** Concatenated non-hidden assistant segments. */
  assistantText: string;
  /** Transcript artifact path under `.eval/runs/…`. */
  transcriptFile: string | undefined;
}

/** Artifact root, resolved once at import time (the repo root when tests run). */
const EVAL_ROOT = path.resolve('.eval');

// Evals share one process: `process.chdir` is global (haze's file tools are
// confined to the cwd), so runs serialize through a single promise chain even
// if a future runner parallelizes test files.
let runChain: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = runChain.then(task, task);
  runChain = next.catch(() => undefined);
  return next;
}

function artifactDirFor(name: string): string {
  const sanitized = name.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'eval';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(EVAL_ROOT, 'runs', `${sanitized}-${stamp}`);
}

async function runEvalInternal<Setup>(input: HazeEvalInput): Promise<HazeEvalResult<Setup>> {
  const preflight = await evalPreflight();
  if (preflight) throw new Error(preflight);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'haze-eval-'));
  const setup = (await input.setup?.(workspace)) as Setup;

  const messages: Message[] = [];
  const events: AgentEvent[] = [];
  const debugLines: string[] = [];
  const goalLedger: GoalLedgerAppend[] = [];
  const segments: {id?: string; text: string; hidden?: boolean}[] = [];
  let conversation: ModelMessage[] = [];
  let lastAssistantText = '';
  let usage: TokenUsage = {...EMPTY_TOKEN_USAGE};

  const debugLog = (line: string) => {
    pushBounded(debugLines, line, MAX_DEBUG_LINES);
    if (process.env.HAZE_EVAL_DEBUG) process.stderr.write(`[eval:${input.name}] ${line}\n`);
  };
  const callbacks: StreamCallbacks = {
    addMessage: msg => {
      pushBounded(messages, msg, MAX_CAPTURED_MESSAGES);
      if (msg.role === 'assistant') segments.push({id: msg.id, text: msg.text, hidden: msg.hidden});
    },
    updateMessage: (id, update) => {
      const segment = segments.find(entry => entry.id === id);
      if (!segment) return;
      if (update.text !== undefined) segment.text = update.text;
      if (update.hidden !== undefined) segment.hidden = update.hidden;
    },
    setConversation: msgs => {
      conversation = msgs;
    },
    setBusy: () => undefined,
    setBusyLabel: () => undefined,
    debugLog,
    getConversation: () => conversation,
    getLastAssistantText: () => lastAssistantText,
    setLastAssistantText: text => {
      lastAssistantText = text;
    },
    recordTokenUsage: captured => {
      usage = accumulateTokenUsage(usage, captured);
    },
    compactConversation: instructions => {
      const compacted = compactModelMessages(conversation, {instructions, tokenBudget: FALLBACK_CONTEXT_WINDOW_TOKENS});
      if (!compacted.compacted) return false;
      conversation = compacted.messages;
      return true;
    },
    onEvent: event => {
      pushBounded(events, event, MAX_CAPTURED_EVENTS);
    },
  };

  const previousCwd = process.cwd();
  const startedAt = new Date();
  let transcriptFile: string | undefined;
  process.chdir(workspace);
  let result: GoalRunResult;
  try {
    const contextFiles = await readContextFiles(workspace);
    const session: PromptSession = {start: startedAt, cwd: workspace};
    result = await runAgentGoal({
      request: input.request,
      displayValue: input.request,
      contextFiles,
      callbacks,
      session,
      ...(evalModelOverride() ? {modelOverride: evalModelOverride()} : {}),
      goalDeadlineMs: input.goalDeadlineMs ?? evalGoalDeadlineMs(),
      goalLedger: {append: entry => pushBounded(goalLedger, entry, 200)},
    });
  } finally {
    process.chdir(previousCwd);
    await teardownBackgroundProcesses().catch(error => debugLog(`background teardown after eval: ${error instanceof Error ? error.message : String(error)}`));
  }

  const assistantText = segments.filter(segment => !segment.hidden && segment.text).map(segment => segment.text).join('\n');
  const artifactDir = artifactDirFor(input.name);
  const transcript = {
    name: input.name,
    request: input.request,
    model: evalModelOverride() ?? 'active-model',
    node: process.version,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    result,
    usage,
    workspace,
    goalLedger,
    messages,
    events,
    debugLines,
  };
  try {
    fs.mkdirSync(artifactDir, {recursive: true});
    transcriptFile = path.join(artifactDir, 'transcript.json');
    fs.writeFileSync(transcriptFile, `${JSON.stringify(transcript, null, 2)}\n`);
    const indexLine = {
      at: transcript.finishedAt,
      name: input.name,
      status: result.status,
      stopReason: result.stopReason,
      cycles: result.cycles,
      mutationCount: result.evidence?.mutationCount ?? 0,
      validationOutcome: result.evidence?.validationOutcome,
      transcript: path.relative(process.cwd(), transcriptFile),
    };
    fs.appendFileSync(path.join(EVAL_ROOT, 'runs.jsonl'), `${JSON.stringify(indexLine)}\n`);
  } catch (error) {
    debugLog(`artifact write failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {result, setup, messages, events, goalLedger, usage, workspace, conversation, assistantText, transcriptFile};
}

/**
 * Run one model-backed eval scenario against the real turn stack. Serialized
 * process-wide (cwd-scoped workspace confinement); the workspace and a full
 * transcript artifact are kept under `.eval/` for inspection.
 */
export function runHazeEval<Setup = unknown>(input: HazeEvalInput): Promise<HazeEvalResult<Setup>> {
  return serialize(() => runEvalInternal<Setup>(input));
}
