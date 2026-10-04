import {describe, expect, it} from 'vitest';
import {createWorkState, deriveValidationOutcome, intentExpectsValidation, observeWorkToolEvent, redPairStatus, seedCarriedGoalEvidence, taskProgressFromOutput, unresolvedFailedCheckIds, validationCommandKey, validationSummaryFromOutput, workStatePrompt, type WorkTaskProgress} from '../../src/core/agent/workState.js';

function passedSummary(text = 'tests passed') {
  return {kind: 'test', status: 'passed', summaryText: text, failedFiles: [], failedTests: [], diagnostics: [], rawOutputTruncated: false};
}
function failedSummary(text = 'tests failed') {
  return {kind: 'test', status: 'failed', summaryText: text, failedFiles: [], failedTests: ['suite'], diagnostics: [], rawOutputTruncated: false};
}
function genericPassedSummary(text = 'custom check passed') {
  return {kind: 'generic', status: 'passed', summaryText: text, failedFiles: [], failedTests: [], diagnostics: [], rawOutputTruncated: false};
}

describe('work state', () => {
  it.each([
    ['editFile', {ok: true, path: 'a.ts'}, 1],
    ['replaceLines', {ok: true, path: 'a.ts'}, 1],
    ['writeFile', {ok: true, path: 'a.ts'}, 1],
    ['replaceInFiles', {ok: true, files: [{path: 'a.ts'}, {path: 'b.ts'}]}, 2],
    ['lspRenameSymbol', {ok: true, files: [{path: 'a.ts'}]}, 1],
    ['lspSafeDeleteSymbol', {ok: true, files: [{path: 'a.ts'}]}, 1],
    ['replaceInFiles', {ok: false, changedPaths: ['a.ts']}, 1],
    ['subagent', {capsule: {termination: 'provider_error', changedPaths: ['a.ts']}}, 1],
    ['subagent', {changedPaths: ['a.ts', 'a.ts']}, 1],
    ['replaceInFiles', {ok: true, dryRun: true, files: [{path: 'a.ts'}]}, 0],
    ['replaceInFiles', {ok: true, files: []}, 0],
    ['editFile', {ok: true, noChange: true, path: 'a.ts'}, 0],
    ['lspRenameSymbol', {ok: false}, 0],
  ] as const)('accounts for actual %s effects: %j', (toolName, output, count) => {
    const state = createWorkState('implement', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, validationSummary: passedSummary()}});
    observeWorkToolEvent(state, {toolName, input: {path: '.'}, success: true, output});
    expect(state.mutationCount).toBe(count);
    expect(deriveValidationOutcome(state)).toBe(count ? 'stale' : 'passed');
    observeWorkToolEvent(state, {toolName, input: {path: '.'}, success: true, output, duplicateSkipped: true});
    expect(state.mutationCount).toBe(count);
  });

  it.each([
    ['node app.js', true], ['node app.js "a;b&c"', true],
    ['node app.js\ntrue', false], ['node app.js & true', false],
    ['node app.js && true', false], ['node app.js # comment', false],
    ['node app.js $(true)', false], ['node app.js `true`', false],
    ['sh -c "node app.js; true"', false],
  ])('credits only trustworthy direct artifact execution: %s', (command, credited) => {
    const state = createWorkState('implement', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeFile', input: {path: 'app.js'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command}, success: true, output: {ok: true, code: 0}});
    expect(deriveValidationOutcome(state)).toBe(credited ? 'passed' : 'absent');
  });

  it('records files and validation without raw tool output', () => {
    const state = createWorkState('add feature', 'implement', ['change code', 'test']);
    observeWorkToolEvent(state, {toolName: 'readFile', input: {path: 'src/a.ts'}, success: true});
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'src/a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary('10 tests passed')}});
    expect(state.files).toEqual([{path: 'src/a.ts', action: 'modified'}]);
    expect(state.validations).toEqual([{command: 'npm test', status: 'passed', summary: '10 tests passed', revision: 3, kind: 'test'}]);
    expect(workStatePrompt(state)).toContain('<work_state>');
  });

  it('keeps the compaction work capsule bounded', () => {
    const state = createWorkState('build a service', 'implement', Array.from({length: 30}, () => 'criterion'.repeat(100)));
    state.files = Array.from({length: 100}, (_, index) => ({path: `src/${index}-${'long'.repeat(100)}`, action: 'modified'}));
    state.blockers = Array.from({length: 20}, () => 'error'.repeat(100));
    const prompt = workStatePrompt(state);
    expect(prompt.length).toBeLessThan(6_000);
    expect(prompt).toContain('src/99-');
  });

  it('preserves an actionable edit blocker', () => {
    const state = createWorkState('fix', 'fix', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'src/a.ts'}, success: false, output: {ok: false, error: 'stale text'}});
    expect(state.blockers[0]).toContain('src/a.ts');
    expect(state.nextAction).toContain('Read src/a.ts');
  });

  it('does NOT treat an arbitrary shell call as validation', () => {
    const state = createWorkState('set up env', 'implement', []);
    // An inspection command (no validationSummary because the classifier did not
    // mark it as a validation command) must not be recorded as validation.
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'ls -la'}, success: true, output: {ok: true, code: 0}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'echo hi'}, success: true, output: {ok: true, code: 0}});
    expect(state.validations).toEqual([]);
    expect(state.validationSeq).toBe(0);
  });

  it('credits direct execution of an artifact changed during this goal', () => {
    const state = createWorkState('implement the CLI', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeFile', input: {path: 'csv-query.js'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'node csv-query.js --help'}, success: true, output: {ok: true, code: 0}});
    expect(state.validations).toEqual([expect.objectContaining({command: 'node csv-query.js --help', status: 'passed', kind: 'generic'})]);
    expect(deriveValidationOutcome(state)).toBe('passed');
  });

  it('records a failed direct artifact execution and rejects masked or unrelated commands', () => {
    const state = createWorkState('implement the CLI', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeFile', input: {path: 'cli.py'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'python other.py'}, success: true, output: {ok: true, code: 0}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'python cli.py | tail -1'}, success: true, output: {ok: true, code: 0}});
    expect(state.validations).toEqual([]);

    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'python cli.py'}, success: false, output: {ok: false, code: 1}});
    expect(state.validations).toEqual([expect.objectContaining({command: 'python cli.py', status: 'failed'})]);
    expect(deriveValidationOutcome(state)).toBe('failed');
  });

  it('counts mutations and sequences validation', () => {
    const state = createWorkState('edit', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'writeFile', input: {path: 'b.ts'}, success: true, output: {ok: true}});
    expect(state.mutationCount).toBe(2);
    expect(state.mutationSeq).toBeGreaterThan(0);
  });
});

describe('deriveValidationOutcome', () => {
  it('matches equivalent npm package checks and clears the failed build', () => {
    const state = createWorkState('build a frontend', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeFile', input: {path: 'frontend/src/main.tsx'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'cd frontend && npm run build'}, success: false, output: {ok: false, validationSummary: failedSummary()}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm --prefix frontend run build'}, success: true, output: {ok: true, validationSummary: passedSummary()}});
    expect(state.validations.map(entry => entry.command)).toEqual(['npm --prefix frontend run build']);
    expect(deriveValidationOutcome(state)).toBe('passed');
  });

  it.each(['&& npm run lint', '| cat', '; npm run lint', '> result.txt'])('does not normalize npm compounds or redirects: %s', suffix => {
    const firstCommand = `cd web && npm test ${suffix}`;
    const secondCommand = `npm --prefix web test ${suffix}`;
    expect(validationCommandKey(firstCommand)).not.toBe(validationCommandKey(secondCommand));
    const state = createWorkState('implement a feature', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: firstCommand}, success: false, output: {ok: false, validationSummary: failedSummary()}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: secondCommand}, success: true, output: {ok: true, validationSummary: passedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('failed');
  });

  it('requires validation after a mutation with unknown intent', () => {
    const state = createWorkState('make it work', 'unknown', []);
    observeWorkToolEvent(state, {toolName: 'writeFile', input: {path: 'app.ts'}, success: true, output: {ok: true}});
    expect(deriveValidationOutcome(state)).toBe('absent');
  });

  it('carries a failed check by identity across turns', () => {
    const first = createWorkState('fix tests', 'fix', []);
    observeWorkToolEvent(first, {toolName: 'shell', input: {command: 'cd api && npm test'}, success: false, output: {ok: false, validationSummary: failedSummary()}});
    const next = createWorkState('fix tests', 'fix', []);
    seedCarriedGoalEvidence(next, {mutationCount: 1, validationOutcome: 'failed', validationKind: 'test', failedCheckIds: unresolvedFailedCheckIds(first)});
    observeWorkToolEvent(next, {toolName: 'shell', input: {command: 'npm run lint'}, success: true, output: {ok: true, validationSummary: passedSummary()}});
    expect(deriveValidationOutcome(next)).toBe('failed');
    observeWorkToolEvent(next, {toolName: 'shell', input: {command: 'npm --prefix api test'}, success: true, output: {ok: true, validationSummary: passedSummary()}});
    expect(unresolvedFailedCheckIds(next)).toEqual([]);
    expect(deriveValidationOutcome(next)).toBe('passed');
  });

  it('clears a carried failed check when an equivalent same-scope check passes, even with different arguments', () => {
    // The observed failure (2026-10-04 goal `on373gg0l1e`): a red
    // `npm test -- tests/core/subagent | tail -25` rode a checkpoint as a bare
    // command hash; a green bare `npm test` could never pair with it, so the
    // goal stayed `failed` forever and the no-progress guard paused it. Check
    // identity is scope-based: same package manager + package root.
    const first = createWorkState('double subagent limits', 'implement', []);
    observeWorkToolEvent(first, {toolName: 'editFile', input: {path: 'src/core/agent/budgets.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(first, {toolName: 'shell', input: {command: 'npm test -- tests/core/subagent tests/core/agent.test.ts 2>&1 | tail -25'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    const ids = unresolvedFailedCheckIds(first);
    expect(ids).toHaveLength(1);
    const next = createWorkState('double subagent limits', 'implement', []);
    seedCarriedGoalEvidence(next, {mutationCount: 1, validationOutcome: 'failed', validationKind: 'test', failedCheckIds: ids});
    observeWorkToolEvent(next, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(unresolvedFailedCheckIds(next)).toEqual([]);
    expect(deriveValidationOutcome(next)).toBe('passed');
  });

  it('keeps a carried failed check open when a different package scope passes', () => {
    const first = createWorkState('fix tests', 'fix', []);
    observeWorkToolEvent(first, {toolName: 'shell', input: {command: 'cd api && npm test'}, success: false, output: {ok: false, validationSummary: failedSummary()}});
    const next = createWorkState('fix tests', 'fix', []);
    seedCarriedGoalEvidence(next, {mutationCount: 1, validationOutcome: 'failed', validationKind: 'test', failedCheckIds: unresolvedFailedCheckIds(first)});
    observeWorkToolEvent(next, {toolName: 'shell', input: {command: 'npm --prefix web test'}, success: true, output: {ok: true, validationSummary: passedSummary()}});
    expect(unresolvedFailedCheckIds(next)).toHaveLength(1);
    expect(deriveValidationOutcome(next)).toBe('failed');
  });

  it('does not let a generic custom check clear a carried failed check in the same scope', () => {
    // Self-certification guard, scope variant: `npm run greenwash` shares the
    // package scope but is a generic custom check, so it must not clear a
    // confirmed test failure.
    const first = createWorkState('fix tests', 'fix', []);
    observeWorkToolEvent(first, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, validationSummary: failedSummary()}});
    const next = createWorkState('fix tests', 'fix', []);
    seedCarriedGoalEvidence(next, {mutationCount: 1, validationOutcome: 'failed', validationKind: 'test', failedCheckIds: unresolvedFailedCheckIds(first)});
    observeWorkToolEvent(next, {toolName: 'shell', input: {command: 'npm run greenwash'}, success: true, output: {ok: true, validationSummary: genericPassedSummary()}});
    expect(unresolvedFailedCheckIds(next)).toHaveLength(1);
    expect(deriveValidationOutcome(next)).toBe('failed');
  });

  it('clears a same-turn failed check when an equivalent same-scope check passes with different arguments', () => {
    // The 2026-10-04 20:17 incident replay: a red targeted run
    // (`npx vitest run tests/x | tail`) stayed open forever because only the
    // exact command text paired; three green `npm test` runs could not clear
    // it and the completion gate correctly kept rejecting the final.
    const state = createWorkState('do 1 + 2', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'src/core/agent/workState.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npx vitest run tests/core/workState.test.ts 2>&1 | tail -15'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('failed');
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(unresolvedFailedCheckIds(state)).toEqual([]);
    expect(deriveValidationOutcome(state)).toBe('passed');
  });

  it('does not clear a failed test check with a passing build check in the same scope', () => {
    // Kind is part of check identity: a green build cannot close a red test.
    const state = createWorkState('fix tests', 'fix', []);
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, validationSummary: failedSummary()}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm run build'}, success: true, output: {ok: true, validationSummary: {kind: 'build', status: 'passed', summaryText: 'built', failedFiles: [], failedTests: [], diagnostics: [], rawOutputTruncated: false}}});
    expect(unresolvedFailedCheckIds(state)).toHaveLength(1);
    expect(deriveValidationOutcome(state)).toBe('failed');
  });

  it('does not clear a failed compound check with a passing single-stage check', () => {
    // `npm test && npm run lint` is its own compound check; a green bare
    // `npm test` did not run the lint stage, so the compound stays open.
    const state = createWorkState('fix checks', 'fix', []);
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test && npm run lint'}, success: false, output: {ok: false, validationSummary: failedSummary()}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, validationSummary: passedSummary()}});
    expect(unresolvedFailedCheckIds(state)).toHaveLength(1);
    expect(deriveValidationOutcome(state)).toBe('failed');
  });

  it('carries every failed check while keeping the model preview bounded', () => {
    const first = createWorkState('implement services', 'implement', []);
    const commands = Array.from({length: 12}, (_, index) => `npm --prefix package-${index} test`);
    for (const command of commands) {
      observeWorkToolEvent(first, {toolName: 'shell', input: {command}, success: false, output: {ok: false, validationSummary: failedSummary()}});
    }
    expect(unresolvedFailedCheckIds(first)).toHaveLength(12);
    const capsule = JSON.parse(workStatePrompt(first).split('\n')[1]!);
    expect(capsule.openCheckIds).toHaveLength(8);
    expect(capsule.openCheckCount).toBe(12);
    const next = createWorkState('implement services', 'implement', []);
    seedCarriedGoalEvidence(next, {mutationCount: 1, validationOutcome: 'failed', validationKind: 'test', failedCheckIds: unresolvedFailedCheckIds(first)});
    for (const [index, command] of commands.entries()) {
      observeWorkToolEvent(next, {toolName: 'shell', input: {command}, success: true, output: {ok: true, validationSummary: passedSummary()}});
      expect(unresolvedFailedCheckIds(next)).toHaveLength(commands.length - index - 1);
      expect(deriveValidationOutcome(next)).toBe(index === commands.length - 1 ? 'passed' : 'failed');
    }
  });

  it.each(['passed', 'failed'] as const)('uses execution order when an earlier check reruns %s', status => {
    const state = createWorkState('implement', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    // Kinds mirror real inference (`npm test` → test, `npm run lint` → lint);
    // kind is part of check identity, so a green suite can never clear a red
    // check of a different kind.
    const check = (command: string, passed: boolean) => observeWorkToolEvent(state, {
      toolName: 'shell', input: {command}, success: passed,
      output: {ok: passed, validationSummary: passed
        ? {kind: command.includes('lint') ? 'lint' : 'test', status: 'passed', summaryText: 'ok', failedFiles: [], failedTests: [], diagnostics: [], rawOutputTruncated: false}
        : {kind: command.includes('lint') ? 'lint' : 'test', status: 'failed', summaryText: 'failed', failedFiles: [], failedTests: ['suite'], diagnostics: [], rawOutputTruncated: false}},
    });
    check('npm test', status !== 'passed');
    check('npm run lint', status !== 'passed');
    check('npm test', status === 'passed');
    observeWorkToolEvent(state, {toolName: 'readFile', input: {path: 'a.ts'}, success: true});
    // A passed rerun of one suite must not conceal a different failed suite.
    expect(deriveValidationOutcome(state)).toBe('failed');
    expect(state.validations.map(item => item.command)).toEqual(['npm run lint', 'npm test']);
    expect(state.validationCommands.at(-1)).toEqual({command: 'npm test', status});
    expect(state.validations.at(-1)?.revision).toBe(state.validationSeq);
    expect(state.validationSeq).toBeGreaterThan(state.mutationSeq);
    check('npm run lint', true);
    expect(deriveValidationOutcome(state)).toBe(status);
  });

  it('marks a fresh passing validation as passed', () => {
    const state = createWorkState('add feature', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('passed');
  });

  it('marks the latest failed validation as failed', () => {
    const state = createWorkState('add feature', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('failed');
  });

  it('does not let a passing custom check clear a failed confirmed validation (self-certification guard)', () => {
    // Found by the honest-impossibility eval: the model ran `npm test` (red),
    // then a self-written `purpose=validation` script (green), and the gate
    // saw the latest validation as passed. Known test/build commands are the
    // authoritative completion evidence; generic custom checks supplement
    // them and cannot clear a confirmed failure.
    const state = createWorkState('make the tests pass', 'fix', []);
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'node -e "console.log(1)"'}, success: true, output: {ok: true, code: 0, validationSummary: genericPassedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('failed');
    // The confirmed suite turning green is what clears it.
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('passed');
  });

  it('still honors a passing custom check when no confirmed validation has failed', () => {
    const state = createWorkState('verify the behavior', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'node custom-check.js'}, success: true, output: {ok: true, code: 0, validationSummary: genericPassedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('passed');
  });

  it('does not let a passing custom check clear a failed validation carried from a goal checkpoint', () => {
    // Cross-physical-turn variant of the self-certification guard: the
    // confirmed failure rides the checkpoint as carried evidence and must
    // keep demanding a confirmed green, not a custom check.
    const state = createWorkState('make the tests pass', 'fix', []);
    seedCarriedGoalEvidence(state, {mutationCount: 1, validationOutcome: 'failed'});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'node -e "console.log(1)"'}, success: true, output: {ok: true, code: 0, validationSummary: genericPassedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('failed');
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('passed');
  });

  it('marks a validation stale when a mutation happens afterwards', () => {
    const state = createWorkState('add feature', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    // A later edit invalidates the prior validation.
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    expect(deriveValidationOutcome(state)).toBe('stale');
    // Fresh again after a post-mutation validation.
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('passed');
  });

  it('reports absent when an implementation request never validated', () => {
    const state = createWorkState('add feature', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    expect(deriveValidationOutcome(state)).toBe('absent');
    expect(intentExpectsValidation('implement')).toBe(true);
  });

  it('reports not_applicable when the request does not call for validation', () => {
    const answerState = createWorkState('explain x', 'answer', []);
    expect(deriveValidationOutcome(answerState)).toBe('not_applicable');
    const reviewState = createWorkState('review the code', 'review', []);
    expect(deriveValidationOutcome(reviewState)).toBe('not_applicable');
    expect(intentExpectsValidation('answer')).toBe(false);
  });

  it('treats a pure test/run request validation on its own (no mutation -> not stale)', () => {
    const state = createWorkState('run the tests', 'test', []);
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('failed');
  });
});

describe('validationSummaryFromOutput', () => {
  it('extracts a well-formed validation summary and rejects malformed shapes', () => {
    expect(validationSummaryFromOutput({validationSummary: passedSummary()})).toBeDefined();
    expect(validationSummaryFromOutput({validationSummary: {summaryText: 'no diagnostics'}})).toBeUndefined();
    expect(validationSummaryFromOutput({code: 1})).toBeUndefined();
    expect(validationSummaryFromOutput(undefined)).toBeUndefined();
  });
});

describe('taskProgressFromOutput', () => {
  it('parses bounded numeric counts from a successful writeTasks result', () => {
    expect(taskProgressFromOutput({ok: true, taskCount: 5, counts: {pending: 3, in_progress: 1, completed: 1}, summary: 'x'}, 7)).toEqual({total: 5, pending: 3, inProgress: 1, completed: 1, revision: 7});
  });

  it('treats a cleared list as all-zero progress', () => {
    expect(taskProgressFromOutput({ok: true, taskCount: 0, summary: 'Task list cleared.'}, 9)).toEqual({total: 0, pending: 0, inProgress: 0, completed: 0, revision: 9});
  });

  it('ignores failed, malformed, or partial outputs safely', () => {
    expect(taskProgressFromOutput({ok: false, error: 'nope'}, 1)).toBeUndefined();
    expect(taskProgressFromOutput(undefined, 1)).toBeUndefined();
    expect(taskProgressFromOutput('tasks: 3', 1)).toBeUndefined();
    expect(taskProgressFromOutput({ok: true}, 1)).toBeUndefined();
    expect(taskProgressFromOutput({ok: true, taskCount: 3}, 1)).toBeUndefined();
    expect(taskProgressFromOutput({ok: true, taskCount: 3, counts: {pending: 1}}, 1)).toBeUndefined();
    expect(taskProgressFromOutput({ok: true, taskCount: 'all', counts: {}}, 1)).toBeUndefined();
    expect(taskProgressFromOutput({ok: true, taskCount: 99_999, counts: {pending: 1, in_progress: 0, completed: 0}}, 1)).toBeUndefined();
  });

  it('never carries task titles or raw output', () => {
    const progress = taskProgressFromOutput({ok: true, taskCount: 1, counts: {pending: 1, in_progress: 0, completed: 0}, summary: 'Tasks: 1 pending.'}, 2);
    expect(JSON.stringify(progress)).not.toContain('summary');
    expect(JSON.stringify(progress)).not.toContain('title');
  });
});

describe('seedCarriedGoalEvidence (cross-physical-turn hydration)', () => {
  it('keeps demanding validation when edits from earlier turns lack it', () => {
    const state = createWorkState('fix it', 'fix', []);
    seedCarriedGoalEvidence(state, {mutationCount: 14, validationOutcome: 'stale'});
    expect(state.mutationCount).toBe(14);
    expect(deriveValidationOutcome(state)).toBe('absent');
    // A fresh validation this turn (no new edits) clears the carried debt.
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('passed');
    // New edits invalidate it again.
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    expect(deriveValidationOutcome(state)).toBe('stale');
    expect(state.mutationCount).toBe(15);
  });

  it('carries a passed outcome so an already-validated goal may finish with a summary-only turn', () => {
    const state = createWorkState('fix it', 'fix', []);
    seedCarriedGoalEvidence(state, {mutationCount: 3, validationOutcome: 'passed'});
    expect(deriveValidationOutcome(state)).toBe('passed');
    expect(state.carriedValidation).toEqual({status: 'passed'});
    // A fresh failing validation this turn supersedes the carried one.
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    expect(deriveValidationOutcome(state)).toBe('failed');
  });

  it('carries the validation kind so cross-turn generic clears keep parity with the in-turn rule (R2-03)', () => {
    // A carried GENERIC failure can be cleared by a generic green on the
    // continuation turn — same as in-turn semantics — while a carried
    // confirmed (non-generic) failure still demands a confirmed green.
    const genericRed = createWorkState('fix it', 'fix', []);
    seedCarriedGoalEvidence(genericRed, {mutationCount: 2, validationOutcome: 'failed', validationKind: 'generic'});
    observeWorkToolEvent(genericRed, {toolName: 'shell', input: {command: 'node check.js'}, success: true, output: {ok: true, code: 0, validationSummary: genericPassedSummary()}});
    expect(genericRed.carriedValidation).toEqual({status: 'failed', kind: 'generic'});
    expect(deriveValidationOutcome(genericRed)).toBe('passed');

    const confirmedRed = createWorkState('fix it', 'fix', []);
    seedCarriedGoalEvidence(confirmedRed, {mutationCount: 2, validationOutcome: 'failed', validationKind: 'test'});
    observeWorkToolEvent(confirmedRed, {toolName: 'shell', input: {command: 'node check.js'}, success: true, output: {ok: true, code: 0, validationSummary: genericPassedSummary()}});
    expect(deriveValidationOutcome(confirmedRed)).toBe('failed');
  });

  it('seeds carried task counts so an undeclared list still gates completion', () => {
    const state = createWorkState('do it', 'implement', []);
    seedCarriedGoalEvidence(state, {mutationCount: 0, validationOutcome: 'not_applicable', taskProgress: {total: 7, pending: 6, inProgress: 1, completed: 0, revision: 4}});
    expect(state.taskProgress).toMatchObject({total: 7, pending: 6, inProgress: 1});
    // Re-declaring all completed clears the gate.
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: []}, success: true, output: {ok: true, taskCount: 7, counts: {pending: 0, in_progress: 0, completed: 7}, summary: 'x'}});
    expect(state.taskProgress).toMatchObject({pending: 0, completed: 7});
  });

  it('is a no-op for a fresh goal (no carried evidence)', () => {
    const state = createWorkState('fresh', 'implement', []);
    seedCarriedGoalEvidence(state, {mutationCount: 0, validationOutcome: 'not_applicable'});
    expect(state.mutationSeq).toBe(0);
    expect(state.validationSeq).toBe(0);
    expect(state.carriedValidation).toBeUndefined();
    expect(state.taskProgress).toBeUndefined();
    expect(deriveValidationOutcome(state)).toBe('absent');
  });
});

describe('work state task progress (writeTasks observation)', () => {
  it('records pending/in-progress counts from a successful writeTasks event and keeps them across later reads', () => {
    const state = createWorkState('do the roadmap', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: [{title: 'a'}, {title: 'b'}, {title: 'c'}, {title: 'd'}, {title: 'e'}]}, success: true, output: {ok: true, taskCount: 5, counts: {pending: 5, in_progress: 0, completed: 0}, summary: 'Tasks: 5 pending.'}});
    expect(state.taskProgress).toEqual({total: 5, pending: 5, inProgress: 0, completed: 0, revision: state.revision});
    const revision = state.revision;
    // A later read does not disturb the task evidence.
    observeWorkToolEvent(state, {toolName: 'readFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    expect(state.taskProgress).toMatchObject({total: 5, pending: 5, revision});
  });

  it('updates counts when the model re-declares the list and accepts an all-completed list', () => {
    const state = createWorkState('do the roadmap', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: []}, success: true, output: {ok: true, taskCount: 2, counts: {pending: 1, in_progress: 1, completed: 0}, summary: 'x'}});
    expect(state.taskProgress).toMatchObject({pending: 1, inProgress: 1});
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: []}, success: true, output: {ok: true, taskCount: 2, counts: {pending: 0, in_progress: 0, completed: 2}, summary: 'x'}});
    expect(state.taskProgress).toMatchObject({pending: 0, inProgress: 0, completed: 2});
  });

  it('ignores failed and malformed writeTasks results without touching prior evidence', () => {
    const state = createWorkState('do the roadmap', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: []}, success: true, output: {ok: true, taskCount: 1, counts: {pending: 1, in_progress: 0, completed: 0}, summary: 'x'}});
    const first: WorkTaskProgress = state.taskProgress!;
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: []}, success: false, output: {ok: false, error: 'Task 1: title cannot be empty.'}});
    observeWorkToolEvent(state, {toolName: 'writeTasks', input: {tasks: []}, success: true, output: {ok: true, summary: 'no counts'}});
    expect(state.taskProgress).toBe(first);
  });

  it('skips duplicate-skipped writeTasks events like any other duplicate', () => {
    const state = createWorkState('do the roadmap', 'implement', []);
    observeWorkToolEvent(state, {toolName: 'writeTasks', success: true, output: {ok: true, taskCount: 1, counts: {pending: 1, in_progress: 0, completed: 0}}, duplicateSkipped: true});
    expect(state.taskProgress).toBeUndefined();
  });
});

describe('red→green pair (P4)', () => {
  it('captures the first failing repro before the first mutation of a fix goal', () => {
    const state = createWorkState('fix the crash', 'fix', []);
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary('crash repro')}});
    expect(state.redEvidence).toMatchObject({command: 'npm test', summary: 'crash repro'});
    // A second failure does not overwrite the first red.
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm run other'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary('second')}});
    expect(state.redEvidence!.command).toBe('npm test');
  });

  it('does not capture red after a mutation or for non-fix intents', () => {
    const fix = createWorkState('fix it', 'fix', []);
    observeWorkToolEvent(fix, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(fix, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    expect(fix.redEvidence).toBeUndefined();
    const implement = createWorkState('add it', 'implement', []);
    observeWorkToolEvent(implement, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    expect(implement.redEvidence).toBeUndefined();
  });

  it('normalizes commands so formatting noise cannot break pair matching', () => {
    expect(validationCommandKey('  npm   test ')).toBe('npm test');
    expect(validationCommandKey('time npm test')).toBe('npm test');
    expect(validationCommandKey('npm test --')).toBe('npm test');
    expect(validationCommandKey('npm test')).not.toBe('npm run build');
    // `env` with assignments is the same check as the bare command (R2-06).
    expect(validationCommandKey('env NODE_ENV=test npm test')).toBe('npm test');
    expect(validationCommandKey('env -i FOO=bar npm test')).toBe('npm test');
    expect(validationCommandKey('env npm test')).toBe('npm test');
    // An env-prefixed red binds to a bare-command green and vice versa.
    expect(validationCommandKey('env CI=1 npm test')).toBe(validationCommandKey('npm test'));
    // A token like `env-file` (flag of another command) is not stripped.
    expect(validationCommandKey('npm run env-file')).toBe('npm run env-file');
  });

  it('requires same-check green only when a red was actually captured', () => {
    const state = createWorkState('fix it', 'fix', []);
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    expect(redPairStatus(state)).toBe('missing');
    // An unrelated green does not satisfy the captured red.
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm run build'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(redPairStatus(state)).toBe('missing');
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'time npm   test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(redPairStatus(state)).toBe('satisfied');
  });

  it('does not accept a same-command green that predates the mutation', () => {
    const state = createWorkState('fix it', 'fix', []);
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: false, output: {ok: false, code: 1, validationSummary: failedSummary()}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    observeWorkToolEvent(state, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(state, {toolName: 'shell', input: {command: 'npm run build'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(redPairStatus(state)).toBe('missing');
  });

  it('is not required without mutations or without a captured red', () => {
    expect(redPairStatus(createWorkState('fix it', 'fix', []))).toBe('not-required');
    const greenOnly = createWorkState('fix it', 'fix', []);
    observeWorkToolEvent(greenOnly, {toolName: 'editFile', input: {path: 'a.ts'}, success: true, output: {ok: true}});
    observeWorkToolEvent(greenOnly, {toolName: 'shell', input: {command: 'npm test'}, success: true, output: {ok: true, code: 0, validationSummary: passedSummary()}});
    expect(redPairStatus(greenOnly)).toBe('not-required');
  });
});

describe('seedCarriedGoalEvidence (goal-scoped red state)', () => {
  it('carries unresolved red evidence across the boundary', () => {
    const state = createWorkState('fix it', 'fix', []);
    seedCarriedGoalEvidence(state, {
      mutationCount: 2,
      validationOutcome: 'stale',
      redEvidence: {command: 'npm test', commandKey: 'npm test', summary: 'red'},
    });
    expect(state.redEvidence!.command).toBe('npm test');
    expect(state.mutationCount).toBe(2);
  });
});

describe('&& compound validation recording (R2-08)', () => {
  const shell = (command: string, kind: string, status: 'passed' | 'failed') => ({
    toolName: 'shell',
    ok: status === 'passed',
    input: {command},
    output: {ok: status === 'passed', code: status === 'passed' ? 0 : 1, command, validationSummary: {kind, status, summaryText: `${kind} ${status}`, failedFiles: [], failedTests: [], diagnostics: []}},
  });

  it('a green && chain clears red stages of the kinds it ran (observed goal 78jmtd8ht4r)', () => {
    const state = createWorkState('goal', 'implement', []);
    // Red bare lint + red compound, exactly as the session recorded them.
    observeWorkToolEvent(state, shell('npm run lint 2>&1 | tail -5', 'lint', 'failed'));
    observeWorkToolEvent(state, shell('npm run typecheck 2>&1 | tail -2 && npx vitest run tests/cli 2>&1 | tail -4', 'typecheck', 'failed'));
    expect(deriveValidationOutcome(state)).toBe('failed');
    // The full green chain the session produced at 20:09:29.
    observeWorkToolEvent(state, shell('npm run typecheck 2>&1 | tail -2 && npm run lint 2>&1 | tail -2 && npm test 2>&1 | grep -E "Test Files|Tests " | head -2', 'typecheck', 'passed'));
    expect(deriveValidationOutcome(state)).toBe('passed');
    expect(unresolvedFailedCheckIds(state)).toEqual([]);
  });

  it('a green bare check clears only its own kind from a red && chain', () => {
    const state = createWorkState('goal', 'implement', []);
    observeWorkToolEvent(state, shell('npm test && npm run lint', 'test', 'failed'));
    expect(unresolvedFailedCheckIds(state).length).toBe(2);
    observeWorkToolEvent(state, shell('npm test', 'test', 'passed'));
    const open = unresolvedFailedCheckIds(state);
    expect(open.length).toBe(1);
    expect(open[0]).toContain(':lint:');
  });

  it('; and || compounds keep the opaque compound scope', () => {
    const state = createWorkState('goal', 'implement', []);
    observeWorkToolEvent(state, shell('npm test; npm run lint', 'test', 'failed'));
    observeWorkToolEvent(state, shell('npm test', 'test', 'passed'));
    // The ; compound is its own check identity; the green bare run cannot clear it.
    expect(unresolvedFailedCheckIds(state).length).toBe(1);
    expect(unresolvedFailedCheckIds(state)[0]).toContain('compound@');
  });
});
