#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {Command, Option} from 'commander';
import {chatCommand} from './commands/chat.js';
import {runHeadless} from './commands/runCommand.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));

const program = new Command();
program
  .name('haze')
  .description('A pragmatic, intentionally limited agentic CLI.')
  .version(pkg.version)
  .option('--debug', 'show model/tool debug logs and write a detailed JSONL log to ~/.haze/logs/')
  .option('-c, --continue', 'resume the latest saved session for this workspace')
  .option('--no-session', 'run without saving or resuming a durable session')
  .option('-p, --prompt <text>', 'print mode: run a single non-interactive turn and print the result (falls back to piped stdin)')
  .option('-m, --model <selector>', 'override the model for this run only — a registered model name or provider:name')
  .addOption(new Option('--output <format>', 'print-mode output: plain text, a single JSON result envelope, or a stream-json NDJSON event stream').choices(['text', 'json', 'stream-json']).default('text'));

program.addHelpText('after', `
Examples:
  $ haze                                           start the interactive chat
  $ haze -p "explain src/cli/index.ts"             print mode: run one turn and print the reply
  $ echo "what does this repo do?" | haze          read the prompt from piped stdin
  $ haze -p "list the top 3 bugs" --output json    emit a JSON envelope { type, status, result, usage }
  $ haze -p "audit src/" --output stream-json       stream NDJSON events live, then the final result envelope
  $ haze -p "summarize" --model openai:gpt-4o-mini override the model for this run only
  $ haze -p "audit auth.ts" --debug                also write a detailed JSONL log to ~/.haze/logs/

Print mode (-p):
  Runs a single agentic turn with the full toolset and guardrails, prints the final assistant
  text, then exits (0 = complete; non-zero = aborted/failed, so CI can gate on the exit code).
  The prompt comes from -p, otherwise from piped stdin. With --output json the reply is wrapped
  in a single-line { type, status, result, usage } envelope. With --output stream-json haze streams
  one NDJSON agent event per line (turn_start, message_*, tool_*, retry, turn_end) as the run
  progresses, then prints that same { type:'result', ... } envelope as the final line — giving
  harnesses live progress and stagnation detection. --model overrides the model for this
  run only (no settings change) and must already be registered under a provider (add it once via
  the /provider picker). Print-mode runs are non-durable: --continue is ignored and no session is
  saved, and there is no automatic context-overflow recovery.
`);

async function readStdinPrompt(): Promise<string | undefined> {
  // Only read stdin when it is piped (non-TTY); never hang waiting on an interactive terminal.
  if (process.stdin.isTTY === false) {
    return new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => resolve(data.trim() ? data : undefined));
      process.stdin.on('error', () => resolve(undefined));
    });
  }
  return undefined;
}

program.action(async () => {
  const opts = program.opts<{debug?: boolean; continue?: boolean; session?: boolean; prompt?: string; model?: string; output?: string}>();
  // -p takes precedence; otherwise fall back to piped stdin. An empty stdin yields no prompt.
  const prompt = opts.prompt?.trim() ? opts.prompt : await readStdinPrompt();
  if (prompt) {
    // One-shot runs are always fresh and non-durable; --continue is ignored in this mode.
    const code = await runHeadless({
      prompt,
      modelOverride: opts.model,
      // commander validates --output against the choices above, so opts.output is one of
      // 'text' | 'json' | 'stream-json'; default to text for piped/stdin runs without the flag.
      output: opts.output === 'json' || opts.output === 'stream-json' ? opts.output : 'text',
      debug: Boolean(opts.debug),
    });
    // Set the exit code and return instead of process.exit(code): the latter does not wait
    // for stdout to drain and can truncate piped/redirected output (e.g. `haze -p ... | jq`).
    process.exitCode = code;
    return;
  }
  await chatCommand({debug: Boolean(opts.debug), continueSession: Boolean(opts.continue), noSession: opts.session === false, version: pkg.version});
});

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
