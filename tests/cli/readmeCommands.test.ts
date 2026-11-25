import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {COMMAND_HELP_ENTRIES} from '../../src/cli/commands/commandHelp.js';

const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

/** The ```txt block under "## Commands": one slash-command form per line. */
function documentedCommands(): string[] {
  const section = readme.split('## Commands')[1] ?? '';
  const block = /```txt\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
  return block.split('\n').map(line => line.trim()).filter(line => line.startsWith('/'));
}

/** Command name plus any literal subcommand words; placeholders and alternations are dropped. */
function literalWords(usage: string): string {
  return usage.split(/\s+/).filter(word => /^\/[a-z-]+$/.test(word) || /^[a-z]+$/.test(word)).join(' ');
}

describe('README command reference (UX-07)', () => {
  it('lists every slash command and literal subcommand that /help documents', () => {
    const documented = new Set(documentedCommands().map(literalWords));
    // Non-slash shortcuts (`! <command>`) have no slash form to list.
    const expected = new Set(COMMAND_HELP_ENTRIES.filter(entry => entry.usage.startsWith('/')).map(entry => literalWords(entry.usage)));
    expect(expected.size).toBeGreaterThan(10);
    for (const form of expected) expect(documented.has(form), form).toBe(true);
  });

  it('lists the /kit alias', () => {
    expect(documentedCommands().map(line => line.split(/\s+/)[0])).toContain('/kit');
  });

  it('mentions the --reasoning and --verbose flags and the doctor command', () => {
    const flags = /CLI flags:\n\n```bash\n([\s\S]*?)```/.exec(readme)?.[1] ?? '';
    expect(flags).toContain('--reasoning');
    expect(flags).toContain('--verbose');
    expect(flags).toMatch(/^\s*haze doctor/m);
  });
});
