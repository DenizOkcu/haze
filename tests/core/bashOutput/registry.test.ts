import {describe, expect, it} from 'vitest';
import {filterBashOutput} from '../../../src/core/bashOutput/registry.js';

function compact(text: string, maxChars = 12000) {
  if (text.length <= maxChars) return {text, truncated: false};
  return {text: text.slice(0, maxChars), truncated: true, omittedChars: text.length - maxChars, handle: 'compact-handle'};
}

function base(input: Partial<Parameters<typeof filterBashOutput>[0]> = {}) {
  return filterBashOutput({
    command: 'echo ok',
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    fallbackCompact: compact,
    compactMaxChars: 12000,
    storeRawOutput: () => 'raw-handle',
    ...input,
  });
}

describe('bash output filter registry', () => {
  it('applies language-neutral line filters and keeps raw handle for lossy output', () => {
    const rows = Array.from({length: 70}, (_, index) => `container-${index} image-${index} running`).join('\n');
    const result = base({command: 'docker ps', stdout: `CONTAINER ID IMAGE STATUS\n${rows}\n`});
    expect(result.stdout.filtered).toBe(true);
    expect(result.stdout.filterName).toBe('docker-list');
    expect(result.stdout.text).toContain('CONTAINER ID IMAGE STATUS');
    expect(result.stdout.text).toContain('lines omitted');
    expect(result.stdout.rawHandle).toBe('raw-handle');
  });

  it('renders failed validation summaries instead of full logs', () => {
    const stdout = 'long validation log line\n'.repeat(50);
    const validationSummary = {
      kind: 'test' as const,
      status: 'failed' as const,
      failedFiles: ['tests/api_test.go'],
      failedTests: ['TestCreateUser'],
      diagnostics: [],
      summaryText: 'test failed: 1 failed test in tests/api_test.go',
      suggestedNextStep: 'Inspect tests/api_test.go and fix the first relevant failure.',
      rawOutputTruncated: false,
    };
    const result = base({command: 'go test ./...', code: 1, stdout, validationSummary});
    expect(result.stdout.filterName).toBe('validation-test');
    expect(result.stdout.text).toContain('test failed');
    expect(result.stdout.text).toContain('TestCreateUser');
    expect(result.stdout.text).toContain('raw output: use readToolOutput with handle raw-handle');
  });

  it('summarizes git status output', () => {
    const stdout = 'On branch main\nChanges not staged for commit:\n\tmodified:   src/a.ts\nUntracked files:\n\tdocs/new.md\n';
    const result = base({command: 'env GIT_OPTIONAL_LOCKS=0 git -C repo status', stdout});
    expect(result.stdout.filterName).toBe('git');
    expect(result.stdout.text).toContain('git status: branch main');
    expect(result.stdout.text).toContain('modified: src/a.ts');
    expect(result.stdout.text).toContain('?? docs/new.md');
  });

  it('summarizes rg-style search output by file and keeps a raw handle', () => {
    const stdout = Array.from({length: 35}, (_, index) => {
      const file = index < 20 ? 'src/a.ts' : `src/file-${index}.ts`;
      const line = index + 1;
      const content = index === 18 ? 'throw new Error("boom")' : `const value${index} = ${index};`;
      return `${file}:${line}:${content}`;
    }).join('\n');
    const result = base({command: 'rg value src', stdout});
    expect(result.stdout.filtered).toBe(true);
    expect(result.stdout.filterName).toBe('search');
    expect(result.stdout.text).toContain('Search results: 35 matches');
    expect(result.stdout.text).toContain('src/a.ts (20 matches');
    expect(result.stdout.text).toContain('throw new Error');
    expect(result.stdout.text).toContain('omitted');
    expect(result.stdout.rawHandle).toBe('raw-handle');
    expect(result.stdout.rawChars).toBe(stdout.length);
    expect(result.stdout.returnedChars).toBe(result.stdout.text.length);
  });

  it('leaves small search output unchanged', () => {
    const stdout = 'src/a.ts:1:const a = 1;\nsrc/b.ts:2:const b = 2;';
    const result = base({command: 'rg const src', stdout});
    expect(result.stdout.filtered).toBe(false);
    expect(result.stdout.text).toBe(stdout);
  });

  it('summarizes git diff with files, hunks, and capped body lines', () => {
    const stdout = [
      'diff --git a/src/a.txt b/src/a.txt',
      'index 111..222 100644',
      '--- a/src/a.txt',
      '+++ b/src/a.txt',
      '@@ -1,3 +1,4 @@',
      ' context',
      '-old',
      '+new',
      '+another',
      'diff --git a/src/b.txt b/src/b.txt',
      '@@ -10,2 +10,2 @@',
      '-x',
      '+y',
    ].join('\n');
    const result = base({command: 'git diff', stdout});
    expect(result.stdout.text).toContain('git diff: 2 files changed, +3/-2');
    expect(result.stdout.text).toContain('src/a.txt +2/-1');
    expect(result.stdout.text).toContain('@@ -1,3 +1,4 @@');
    expect(result.stdout.rawHandle).toBe('raw-handle');
  });

  it('summarizes default git log output as one-line commits', () => {
    const stdout = [
      'commit abcdef1234567890',
      'Author: Example <e@example.com>',
      'Date: Thu Jan 1 00:00:00 2026 +0000',
      '',
      '    Add feature',
      'commit 1111111222222222',
      '',
      '    Fix bug',
    ].join('\n');
    const result = base({command: 'git log', stdout});
    expect(result.stdout.text).toContain('git log: 2 commits shown');
    expect(result.stdout.text).toContain('abcdef123456 Add feature');
    expect(result.stdout.text).toContain('111111122222 Fix bug');
  });

  it('summarizes large JSON arrays by shape and sample records', () => {
    const stdout = JSON.stringify(Array.from({length: 20}, (_, index) => ({id: index, status: index === 7 ? 'error' : 'ok', repeated: 'same'})));
    const result = base({command: 'some-cli --json', stdout});
    expect(result.stdout.filterName).toBe('json');
    expect(result.stdout.contentKind).toBe('json');
    expect(result.stdout.text).toContain('"items": 20');
    expect(result.stdout.text).toContain('"commonKeys"');
    expect(result.stdout.text).toContain('raw-handle');
  });

  it('summarizes large generic logs by signal lines', () => {
    const stdout = [
      ...Array.from({length: 80}, (_, index) => `info noise ${index}`),
      'ERROR failed to connect',
      '  at connect (src/client.ts:10:2)',
      ...Array.from({length: 80}, (_, index) => `info tail ${index}`),
      '1 failed, 120 passed',
    ].join('\n');
    const result = base({command: 'custom-build', stdout});
    expect(result.stdout.filterName).toBe('log');
    expect(result.stdout.contentKind).toBe('log');
    expect(result.stdout.text).toContain('log summary:');
    expect(result.stdout.text).toContain('ERROR failed to connect');
    expect(result.stdout.text).toContain('1 failed, 120 passed');
  });
});
