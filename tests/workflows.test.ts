import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const workflowsDir = path.join(process.cwd(), '.github', 'workflows');

type Workflow = {
  concurrency?: {group?: string; 'cancel-in-progress'?: string | boolean};
  jobs?: Record<string, {'timeout-minutes'?: number}>;
};

function loadWorkflow(name: string): Workflow {
  return YAML.parse(fs.readFileSync(path.join(workflowsDir, name), 'utf8')) as Workflow;
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
