#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {Command} from 'commander';
import {chatCommand} from './commands/chat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));

const program = new Command();
program
  .name('haze')
  .description('A pragmatic, intentionally limited agentic CLI.')
  .version(pkg.version)
  .option('--debug', 'show simple model/tool debug logs in the chat UI')
  .option('-c, --continue', 'resume the latest saved session for this workspace')
  .option('--no-session', 'run without saving or resuming a durable session');

program.action(async () => {
  const opts = program.opts<{debug?: boolean; continue?: boolean; session?: boolean}>();
  await chatCommand({debug: Boolean(opts.debug), continueSession: Boolean(opts.continue), noSession: opts.session === false, version: pkg.version});
});

program.parseAsync().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
