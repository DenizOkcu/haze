import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const workflowsDir = path.join(process.cwd(), '.github', 'workflows');
const read = (file: string) => fs.readFileSync(file, 'utf8');

type Step = {run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string>};
type Job = {'timeout-minutes'?: number; permissions?: Record<string, string>; steps?: Step[]};
type Workflow = {
  concurrency?: {group?: string; 'cancel-in-progress'?: string | boolean};
  jobs?: Record<string, Job>;
};

function loadWorkflow(name: string): Workflow {
  return YAML.parse(read(path.join(workflowsDir, name))) as Workflow;
}

describe('GitHub workflow guards (OPS-01)', () => {
  it('bounds every workflow run with one concurrency group per ref and a job timeout', () => {
    const names = fs.readdirSync(workflowsDir).filter(name => name.endsWith('.yml'));
    expect(names).toEqual(['ci.yml', 'release.yml']);
    for (const name of names) {
      const workflow = loadWorkflow(name);
      // Superseded runs are replaced instead of stacking a full 3 OS x 2 Node matrix.
      expect(workflow.concurrency?.group, name).toBe('${{ github.workflow }}-${{ github.ref }}');
      const jobs = Object.entries(workflow.jobs ?? {});
      expect(jobs.length, name).toBeGreaterThan(0);
      for (const [job, definition] of jobs) {
        expect(definition['timeout-minutes'], `${name}:${job}`).toBeLessThanOrEqual(30);
        expect(definition['timeout-minutes'], `${name}:${job}`).toBeGreaterThan(0);
      }
    }
  });

  it('cancels superseded CI runs but never a release in progress', () => {
    const ci = String(loadWorkflow('ci.yml').concurrency?.['cancel-in-progress']);
    expect(ci).toContain("github.event_name == 'pull_request'");
    expect(ci).toContain("github.ref == 'refs/heads/main'");
    expect(ci).not.toContain('tags');
    expect(loadWorkflow('release.yml').concurrency?.['cancel-in-progress']).toBe(false);
  });
});

describe('CI supply-chain gates (OPS-04)', () => {
  const steps = loadWorkflow('ci.yml').jobs?.hygiene?.steps ?? [];
  const stepUsing = (prefix: string) => steps.find(step => step.uses?.startsWith(prefix));

  it('runs knip and jscpd in the hygiene job, not only in the bypassable local hook', () => {
    const runs = steps.map(step => step.run ?? '').join('\n');
    expect(runs).toContain('npm run lint:knip');
    expect(runs).toContain('jscpd --min-tokens 100 --threshold 1');
    expect(runs).toContain('src tests');
  });

  it('pins osv-scanner and gitleaks actions to commit SHAs and scans the lockfile and the full history', () => {
    const osv = stepUsing('google/osv-scanner-action@');
    expect(osv?.uses).toMatch(/^google\/osv-scanner-action@[0-9a-f]{40}$/);
    const scanArgs = String(osv?.with?.['scan-args'] ?? '');
    expect(scanArgs).toContain('osv-scanner.toml');
    expect(scanArgs).toContain('package-lock.json');
    const gitleaks = stepUsing('gitleaks/gitleaks-action@');
    expect(gitleaks?.uses).toMatch(/^gitleaks\/gitleaks-action@[0-9a-f]{40}$/);
    // No log-opts range: every commit is scanned, not only the pushed range.
    expect(String(gitleaks?.with?.args ?? '')).toContain('detect');
    expect(String(gitleaks?.with?.args ?? '')).not.toContain('log-opts');
    const checkout = stepUsing('actions/checkout@');
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });

  it('scopes security-events: write to the hygiene job only', () => {
    const jobs = loadWorkflow('ci.yml').jobs ?? {};
    expect(jobs.hygiene?.permissions).toEqual({'contents': 'read', 'security-events': 'write'});
    for (const [name, job] of Object.entries(jobs)) {
      if (name !== 'hygiene') expect(job.permissions?.['security-events'], name).toBeUndefined();
    }
  });

  it('documents CI as the authority, with the hook as a local mirror', () => {
    expect(read('lefthook.yml')).toContain('CI is the authority');
    expect(read('CONTRIBUTING.md')).toContain('npx lefthook install');
  });
});
