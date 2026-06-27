import {commandCandidates} from '../command.js';
import {reduceJsonOutput} from './content.js';

const GH_GROUPS = new Set(['pr', 'issue', 'run', 'release', 'repo', 'workflow']);
const READ_ONLY = new Set([
  'pr list', 'pr view', 'pr checks',
  'issue list', 'issue view',
  'run list', 'run view',
  'release list', 'release view',
  'repo view',
]);

function clip(line: string, max = 220) {
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

// Extract "<group> <action>" (e.g. "pr list") from a gh command, skipping flags.
function ghSubcommand(command: string): string | undefined {
  for (const candidate of commandCandidates(command)) {
    const words = candidate.toLowerCase().split(/\s+/).filter(Boolean);
    const ghIndex = words.indexOf('gh');
    if (ghIndex === -1) continue;
    for (let index = ghIndex + 1; index < words.length; index++) {
      const group = words[index] ?? '';
      if (!GH_GROUPS.has(group)) continue;
      for (let next = index + 1; next < words.length; next++) {
        const action = words[next] ?? '';
        if (action.startsWith('-')) continue;
        return `${group} ${action}`;
      }
      return group;
    }
  }
  return undefined;
}

// gh *list / pr checks → tab/space separated rows; summarize count + capped sample.
function reduceGhTable(subcommand: string, text: string): string | undefined {
  const rows = text.split(/\r?\n/).filter(line => line.trim());
  if (rows.length <= 10 && text.length < 2000) return undefined;
  const shown = rows.slice(0, 30);
  const output = [`gh ${subcommand}: ${rows.length} row${rows.length === 1 ? '' : 's'}`, ...shown.map(line => `  ${clip(line)}`)];
  if (rows.length > shown.length) output.push(`  ... ${rows.length - shown.length} more`);
  return output.join('\n');
}

// gh * view (non-JSON) → key:value header lines, then `--`, then markdown body.
function reduceGhView(subcommand: string, text: string): string | undefined {
  if (text.length < 2000) return undefined;
  const lines = text.split(/\r?\n/);
  const sepIndex = lines.findIndex(line => line.trim() === '--');
  const header = (sepIndex === -1 ? lines : lines.slice(0, sepIndex)).filter(Boolean);
  const body = (sepIndex === -1 ? [] : lines.slice(sepIndex + 1)).filter(Boolean);
  const bodyShown = body.slice(0, 12);
  const output = [`gh ${subcommand}:`, ...header.slice(0, 30).map(line => `  ${clip(line)}`)];
  if (bodyShown.length) {
    output.push('  --', ...bodyShown.map(line => `  ${clip(line)}`));
    if (body.length > bodyShown.length) output.push(`  ... ${body.length - bodyShown.length} more body lines`);
  }
  return output.join('\n');
}

export function reduceGhOutput(command: string, stdout: string, stderr: string): string | undefined {
  const subcommand = ghSubcommand(command);
  if (!subcommand || !READ_ONLY.has(subcommand)) return undefined;
  const text = stdout || stderr;
  if (!text.trim()) return undefined;
  if (/^\s*[[{]/.test(text)) return reduceJsonOutput(stdout, stderr); // --json → reuse JSON reducer (undefined for small JSON)
  if (subcommand.endsWith(' view')) return reduceGhView(subcommand, text);
  return reduceGhTable(subcommand, text);
}
