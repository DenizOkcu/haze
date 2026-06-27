import {describe, expect, it} from 'vitest';
import {reduceGhOutput} from '../../../../src/core/bashOutput/reducers/gh.js';

describe('reduceGhOutput', () => {
  it('returns undefined for non-gh commands', () => {
    expect(reduceGhOutput('git status', 'x', '')).toBeUndefined();
  });

  it('returns undefined for mutating gh subcommands', () => {
    expect(reduceGhOutput('gh pr create --title x', 'created pr', '')).toBeUndefined();
    expect(reduceGhOutput('gh pr merge 8', 'merged', '')).toBeUndefined();
  });

  it('leaves small gh pr list output unchanged', () => {
    const stdout = '1\tFix\tkoan/fix\tOPEN\n2\tAdd\tkoan/add\tOPEN';
    expect(reduceGhOutput('gh pr list', stdout, '')).toBeUndefined();
  });

  it('summarizes large gh pr list output with a row count and cap', () => {
    const rows = Array.from({length: 40}, (_, i) => `${i}\tTitle ${i}\tkoan/branch-${i}\tOPEN`).join('\n');
    const result = reduceGhOutput('gh pr list --limit 100', rows, '');
    expect(result).toContain('gh pr list: 40 rows');
    expect(result).toContain('... 10 more');
  });

  it('summarizes gh issue view into header fields plus a capped body', () => {
    const header = ['title:\tBig bug', 'state:\tOPEN', 'author:\toctocat', 'labels:\tbug'];
    const body = Array.from({length: 40}, (_, i) => `body line ${i}`);
    const text = [...header, '--', ...body].join('\n') + '\n' + 'x'.repeat(2000);
    const result = reduceGhOutput('gh issue view 7', text, '');
    expect(result).toContain('gh issue view:');
    expect(result).toContain('title:\tBig bug');
    expect(result).toContain('more body lines');
  });

  it('routes --json output through the JSON reducer', () => {
    const stdout = JSON.stringify(Array.from({length: 20}, (_, i) => ({number: i, state: i === 3 ? 'CLOSED' : 'OPEN'})));
    const result = reduceGhOutput('gh run list --json databaseId,status', stdout, '');
    expect(result).toBeDefined();
    expect(JSON.parse(result!).jsonSummary.type).toBe('array');
  });

  it('returns undefined for gh pr diff so the unified-diff reducer takes over', () => {
    const diff = Array.from({length: 40}, (_, i) => `+added line ${i}`).join('\n');
    expect(reduceGhOutput('gh pr diff 8', diff, '')).toBeUndefined();
  });

  it('returns undefined for gh run view --log so the generic log reducer takes over', () => {
    const log = Array.from({length: 200}, (_, i) => `step ${i} ok`).join('\n');
    expect(reduceGhOutput('gh run view 12 --log', log, '')).toBeUndefined();
    expect(reduceGhOutput('gh run view 12 --log-failed', log, '')).toBeUndefined();
  });

  it('falls back to stderr when stdout is empty', () => {
    const rows = Array.from({length: 20}, (_, i) => `${i}\tRun ${i}\tcompleted`).join('\n');
    expect(reduceGhOutput('gh run list', '', rows)).toContain('gh run list: 20 rows');
  });
});
