import {afterEach, describe, expect, it} from 'vitest';
import {formatSandboxDenials, listSandboxDenials, recordSandboxDenial, resetSandboxDenialLog} from '../../../src/core/sandbox/denialLog.js';

afterEach(() => {
  resetSandboxDenialLog();
});

describe('sandbox denial log', () => {
  it('records denials newest-first with timestamps', () => {
    recordSandboxDenial({command: 'cat ~/notes.txt', kind: 'read', pathHint: '/Users/u/notes.txt'});
    recordSandboxDenial({command: 'touch /etc/x', kind: 'write', pathHint: '/etc/x'});
    const entries = listSandboxDenials();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({command: 'touch /etc/x', kind: 'write', pathHint: '/etc/x'});
    expect(entries[1]).toMatchObject({command: 'cat ~/notes.txt', kind: 'read'});
    expect(entries[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('caps the ring so a denial loop cannot grow memory', () => {
    for (let index = 0; index < 80; index++) recordSandboxDenial({command: `cmd-${index}`, kind: 'read'});
    expect(listSandboxDenials()).toHaveLength(50);
    expect(listSandboxDenials()[0]).toMatchObject({command: 'cmd-79'});
    expect(formatSandboxDenials(listSandboxDenials())).toContain('10 of 50 shown');
  });

  it('formats an empty log without implying denials happened', () => {
    expect(formatSandboxDenials([])).toBe('No sandbox denials recorded this session.');
  });
});
