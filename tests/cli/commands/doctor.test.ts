import {describe, expect, it} from 'vitest';
import {formatDoctorReport, runDoctorChecks} from '../../../src/cli/commands/doctorCommand.js';

describe('formatDoctorReport', () => {
  it('groups results by severity and counts them', () => {
    const report = formatDoctorReport([
      {name: 'a', severity: 'ok', message: 'ok-msg'},
      {name: 'b', severity: 'critical', message: 'crit-msg'},
      {name: 'c', severity: 'warning', message: 'warn-msg', hint: 'do this'},
    ]);
    expect(report).toContain('1 critical, 1 warning, 3 total');
    expect(report.indexOf('❌')).toBeLessThan(report.indexOf('⚠️'));
    expect(report.indexOf('⚠️')).toBeLessThan(report.indexOf('✅'));
    expect(report).toContain('💡 do this');
  });
});

describe('runDoctorChecks', () => {
  it('runs all read-only checks by default', async () => {
    const results = await runDoctorChecks({});
    expect(results.length).toBeGreaterThanOrEqual(9);
    const names = results.map(r => r.name);
    expect(names).toContain('provider configured');
    expect(names).toContain('activeModel resolves');
  });

  it('includes reachability only with --full', async () => {
    const withoutFull = await runDoctorChecks({});
    expect(withoutFull.map(r => r.name)).not.toContain('provider reachable');
    const withFull = await runDoctorChecks({}, {full: true});
    expect(withFull.map(r => r.name)).toContain('provider reachable');
  });
});
