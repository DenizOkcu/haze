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
  .option('--debug', 'show simple model/tool debug logs in the chat UI')
  .option('-c, --continue', 'resume the latest saved session for this workspace')
  .option('--no-session', 'run without saving or resuming a durable session')
  .option('-p, --prompt <text>', 'run a single non-interactive turn and print the result')
  .option('-m, --model <selector>', 'override the model for this run (name or provider:name)')
  .addOption(new Option('--output <format>', 'output format for -p').choices(['text', 'json']).default('text'));

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
      output: opts.output === 'json' ? 'json' : 'text',
      debug: Boolean(opts.debug),
    });
    process.exit(code);
  }
  await chatCommand({debug: Boolean(opts.debug), continueSession: Boolean(opts.continue), noSession: opts.session === false, version: pkg.version});
});

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});