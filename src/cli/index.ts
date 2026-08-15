#!/usr/bin/env node
import {Command, Option} from 'commander';
import {chatCommand} from './commands/chat.js';
import {runHeadless} from './commands/runCommand.js';
import {installTerminalTitle, terminalTitleLabel} from './terminalTitle.js';
import {findSession} from '../core/session/sessionStore.js';
import {installBackgroundProcessSignalHandlers, teardownBackgroundProcesses} from '../core/process/backgroundRegistry.js';
import {STDIN_PROMPT_BYTES} from '../core/limits.js';
import {readPackageVersion} from '../utils/version.js';
import {formatVersionVerbose, readBuildInfo} from '../utils/buildInfo.js';
import {runDoctor} from './commands/doctor.js';

installBackgroundProcessSignalHandlers();
const version = readPackageVersion() ?? '0.0.0';
const program = new Command();
program
  .name('haze')
  .description('A pragmatic, intentionally limited agentic CLI.')
  .option('-V, --version', 'print the haze version (add --verbose for build provenance: commit, runtime paths, capabilities)')
  .option('--verbose', 'with --version: also print commit, runtime/executable paths, and the capability registry')
  .option('--debug', 'show model/tool debug logs and write a detailed JSONL log to ~/.haze/logs/')
  .option('-c, --continue', 'resume the latest saved session for this workspace')
  .addOption(new Option('--resume <id>', 'resume an exact saved session id for this workspace').conflicts(['continue', 'session']))
  .option('--no-session', 'run without saving or resuming a durable session')
  .option('-p, --prompt <text>', 'print mode: run a single non-interactive turn and print the result (falls back to piped stdin)')
  .option('-m, --model <selector>', 'override the model for this run only — a registered model name or provider:name')
  .addOption(new Option('--output <format>', 'print-mode output: plain text, a single JSON result envelope, or a stream-json NDJSON event stream').choices(['text', 'json', 'stream-json']).default('text'))
  .option('--timeout <duration>', 'print-mode absolute turn deadline (e.g. 30s, 10m, 2h); bounds total elapsed time so a busy tool cannot run indefinitely');

program.addHelpText('after', `
Examples:
  $ haze                                           start the interactive chat
  $ haze -p "explain src/cli/index.ts"             print mode: run one turn and print the reply
  $ echo "what does this repo do?" | haze          read the prompt from piped stdin
  $ haze -p "list the top 3 bugs" --output json    emit a JSON envelope { type, status, result, usage }
  $ haze -p "audit src/" --output stream-json       stream NDJSON events live, then the final result envelope
  $ haze -p "summarize" --model openai:gpt-4o-mini override the model for this run only
  $ haze --resume <id> -p "continue the review"   load a saved context for one print-mode turn
  $ haze -p "audit auth.ts" --debug                also write a detailed JSONL log to ~/.haze/logs/

Print mode (-p):
  Runs a single agentic turn with the full toolset and guardrails, prints the final assistant
  text, then exits (0 = complete; non-zero = aborted/failed, so CI can gate on the exit code).
  The prompt comes from -p, otherwise from piped stdin. Piped prompts over 256 KiB are rejected;
  pass a file path and ask haze to read it instead. With --output json the reply is wrapped in a
  single-line { type, status, result, usage } envelope. With --output stream-json haze streams
  one NDJSON agent event per line (turn_start, step_*, message_*, tool_*, retry, turn_end) as the
  run progresses, then prints that same { type:'result', ... } envelope as the final line — giving
  harnesses live progress, per-step usage, bounded tool-failure diagnostics, and stagnation
  detection without raw tool inputs or outputs. --model overrides the model for this
  run only (no settings change) and must already be registered under a provider (add it once via
  the /provider picker). Print-mode runs are non-durable: --continue is ignored and no session is
  saved. --resume <id> loads saved context for the turn without changing that session. On a
  provider context overflow, haze compacts the conversation and retries the request once; when
  compaction is unavailable, the error says so explicitly.
`);

async function readStdinPrompt(): Promise<string | undefined> {
  // Only read stdin when it is piped (non-TTY); never hang waiting on an interactive terminal.
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = '';
      let bytes = 0;
      const cleanup = () => {
        process.stdin.removeListener('data', onData);
        process.stdin.removeListener('end', onEnd);
        process.stdin.removeListener('error', onError);
      };
      const onData = (chunk: string) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > STDIN_PROMPT_BYTES) {
          cleanup();
          process.stdin.pause();
          reject(new Error(`stdin prompt exceeds ${STDIN_PROMPT_BYTES} bytes; pass a file path and ask haze to read it instead.`));
          return;
        }
        data += chunk;
      };
      const onEnd = () => {
        cleanup();
        resolve(data.trim() ? data : undefined);
      };
      const onError = () => {
        cleanup();
        resolve(undefined);
      };
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', onData);
      process.stdin.on('end', onEnd);
      process.stdin.on('error', onError);
    });
  }
  return undefined;
}

program.command('doctor')
  .description('print runtime provenance (version, commit, executable/runtime paths), verify build integrity, and show the capability registry')
  .action(async () => {
    process.exitCode = await runDoctor();
  });

program.action(async () => {
  const opts = program.opts<{debug?: boolean; continue?: boolean; resume?: string; session?: boolean; prompt?: string; model?: string; output?: string; timeout?: string; version?: boolean; verbose?: boolean}>();
  if (opts.version) {
    // Handled here (not via commander's built-in .version()) so --verbose can
    // enrich it and the bin launcher can answer without loading dist.
    process.stdout.write(opts.verbose ? `${formatVersionVerbose()}\n` : `${version}\n`);
    return;
  }
  // Name the terminal tab for the run; no-op unless stdout is a real TTY.
  installTerminalTitle(terminalTitleLabel(process.cwd()));
  // -p takes precedence; otherwise fall back to piped stdin. An empty stdin yields no prompt.
  const prompt = opts.prompt?.trim() ? opts.prompt : await readStdinPrompt();
  if (opts.resume && !await findSession(opts.resume)) {
    throw new Error(`No session named ${opts.resume} exists for this workspace.`);
  }
  if (prompt) {
    // One-shot runs are always fresh and non-durable; --continue is ignored in this mode.
    const code = await runHeadless({
      prompt,
      modelOverride: opts.model,
      resumeSessionId: opts.resume,
      // commander validates --output against the choices above, so opts.output is one of
      // 'text' | 'json' | 'stream-json'; default to text for piped/stdin runs without the flag.
      output: opts.output === 'json' || opts.output === 'stream-json' ? opts.output : 'text',
      debug: Boolean(opts.debug),
      timeout: opts.timeout,
    });
    // Set the exit code and return instead of process.exit(code): the latter does not wait
    // for stdout to drain and can truncate piped/redirected output (e.g. `haze -p ... | jq`).
    process.exitCode = code;
    return;
  }
  await chatCommand({debug: Boolean(opts.debug), continueSession: Boolean(opts.continue), resumeSessionId: opts.resume, noSession: opts.session === false, version, build: sessionBuildProvenance()});
});

/** Safe build provenance recorded into session headers (commit + build time only). */
function sessionBuildProvenance(): {commit?: string; builtAt?: string} | undefined {
  const info = readBuildInfo();
  if (!info?.commit && !info?.builtAt) return undefined;
  return {...(info?.commit ? {commit: info.commit} : {}), ...(info?.builtAt ? {builtAt: info.builtAt} : {})};
}

program.parseAsync().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await teardownBackgroundProcesses().catch(() => undefined);
  process.exit(1);
});
