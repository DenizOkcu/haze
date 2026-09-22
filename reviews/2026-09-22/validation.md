# Review validation and reproducible evidence

Baseline: `b53d4e90352a1283c4d05280017760424fd4580b`, package 1.2.1, macOS, Node v26.7.0. Worktree was clean before review. Only review Markdown files were intentionally added.

## Commands actually executed

| Check | Result | Interpretation |
| --- | --- | --- |
| `npm run typecheck && npm run lint` | Exit 0 | Both TypeScript and ESLint passed. |
| `npm test` | Exit 1 | 1 failed, 1,781 passed, 6 skipped; 163 files total (1 failed, 156 passed, 6 skipped). |
| `node bin/haze.js --version --verbose` | Exit 1 | Correctly refuses local dist built from 21e3822 when HEAD is b53d4e9; explains the test failure. |
| `npm run release:verify` | Exit 1 | 32 release-metadata mismatches. |
| `npm run lint:knip` | Exit 1 | 10 unused exports, requiring triage rather than automatic deletion. |
| Focused pure-helper assertions below | Exit 0 | Assertions confirm seven existing defect families, **not** that the desired behavior passes. |

The sole suite failure was `tests/cli/binLauncher.test.ts:141`, “real checkout (requires npm run build) / reports the built version and commit through the real launcher.” Expected exit 0, received 1. The launcher stderr reported a stale commit, not a TypeScript compile failure. See MR-02.

The release verifier reported a lockfile-root version mismatch, README version mismatch, six docs-page stamps, and 24 AGENTS stamps. Reduced tool output initially listed only the first ten; the complete stderr was retrieved to establish the total of 32.

No fixes were attempted and the failing checks were not rerun without a relevant change.

## Safe helper reproductions

The following assertions were executed in a Node/tsx heredoc. They use synthetic events and strings, inspect directory entries under src/utils, and do not write source files, contact providers, or open credentials. They intentionally assert the **current incorrect behavior** so the review evidence is deterministic. Convert them into desired-behavior regression tests when fixing.

```js
import assert from 'node:assert/strict';
import {
  createWorkState, observeWorkToolEvent, deriveValidationOutcome,
  executedMutatedArtifact,
} from './src/core/agent/workState.ts';
import {assessCompletionReadiness} from './src/core/agent/completionController.ts';
import {applyTextEdits, workspaceEditChanges} from './src/llm/lsp/workspaceEdit.ts';
import {walkDir} from './src/utils/fs.ts';
import {createAbsoluteDeadline, withToolDeadline} from './src/core/deadline.ts';
import {getEventListeners} from 'node:events';
import {reduceGitOutput} from './src/core/shellOutput/reducers/git.ts';

const state = createWorkState('implement', 'implement', []);
observeWorkToolEvent(state, {
  toolName: 'writeFile', input: {path: 'app.js'},
  success: true, output: {ok: true},
});
const validate = (command, status) => observeWorkToolEvent(state, {
  toolName: 'shell', input: {command}, success: status === 'passed',
  output: {
    ok: status === 'passed', code: status === 'passed' ? 0 : 1,
    validationSummary: {
      kind: 'test', status, failedFiles: [], failedTests: [],
      diagnostics: [], summaryText: status,
    },
  },
});
validate('npm test', 'passed');
validate('npm run lint', 'passed');
validate('npm test', 'failed');
assert.equal(deriveValidationOutcome(state), 'passed'); // AR-01

assert.equal(executedMutatedArtifact('node app.js\ntrue', state), 'app.js');
assert.equal(executedMutatedArtifact('node app.js & true', state), 'app.js'); // AR-03

const bulk = createWorkState('implement', 'implement', []);
observeWorkToolEvent(bulk, {
  toolName: 'replaceInFiles', input: {path: '.'}, success: true,
  output: {ok: true, dryRun: false, files: [{path: 'app.js'}]},
});
assert.equal(bulk.mutationCount, 0);
assert.equal(assessCompletionReadiness({
  aborted: false, intent: 'implement', mutationCount: bulk.mutationCount,
  validationOutcome: deriveValidationOutcome(bulk), taskProgress: undefined,
}, {lastToolOk: true, unresolvedToolInputError: false}), 'ready'); // AR-02

const malformed = workspaceEditChanges({changes: {
  'file:///synthetic/a.ts': [{range: {start: {}, end: {}}, newText: 'X'}],
}}).get('file:///synthetic/a.ts');
assert.equal(applyTextEdits('abc', malformed), 'Xabc'); // TS-05

assert.ok((await walkDir('src/utils', {maxEntries: 10})).length > 0);
assert.equal((await walkDir('src/utils', {maxEntries: 10, cursor: ''})).length, 0); // TS-03

const controller = new AbortController();
let fired = false;
const deadline = createAbsoluteDeadline({
  timeoutMs: 10000, signal: controller.signal,
  onTimeout: () => { fired = true; },
});
deadline.clear();
controller.abort();
assert.equal(fired, true);
const toolController = new AbortController();
await withToolDeadline(async () => 42, 1000, toolController.signal);
assert.equal(getEventListeners(toolController.signal, 'abort').length, 1); // AR-06

assert.equal(reduceGitOutput(
  'pwd && git status --short && ls', '/some/path\nREADME.md\n', '',
), 'git status: 0 changed, 0 untracked'); // TS-06
```

Run from repository root with `node --import tsx --input-type=module` and pass the code on stdin. This is a review reproduction, not a replacement for Vitest integration tests.

## Deliberately not executed

- Build/prepublish/pack: build runs a cleanup that removes existing dist; unnecessary for a documentation-only review and would erase the stale-build evidence. Package installation/publishing was not attempted.
- Dependency installation, network audit, model-backed evals, benchmarks, OAuth login, remote MCP servers, and live provider tests: not needed to verify the local findings; network/credential availability was not assumed.
- Node 22/24 and Windows CI matrices: current environment was Node 26.7.0 on macOS. Passing checks here do not certify the supported-version matrix.
- Real-secret safety exploits: only source tracing/mocked-test recommendations were used for secret-related findings.

Five attempted parallel review workers returned provider_error with no usable deliverables or changed paths. All report conclusions were therefore assembled directly; they are not claimed as independently corroborated reviews.
