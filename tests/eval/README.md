# haze evals — model-backed behavioral checks

These are **not** part of the default unit suite. They run the real turn stack
(`runAgentGoal`, tools, budgets, compaction, the goal supervisor) against a
configured provider inside an isolated throwaway workspace, and assert on the
**structured goal envelope** plus deterministic ground truth (the fixture's own
test command, file hashes) — never on response text. This is what turns the
autonomy policy (`completionController`, `goalPolicy`, the Pillar-1 recovery
paths) into a regression-tested contract instead of a hand-checked one.

## Running

```bash
npm run eval                                  # uses the active provider/model
HAZE_EVAL_MODEL=openai:gpt-5.2 npm run eval   # explicit provider:model selector
npm run eval -- -t "fix a failing"            # forwarded to vitest
HAZE_EVAL_DEBUG=1 npm run eval                # stream debug lines to stderr
HAZE_EVAL_TIMEOUT_MS=120000 npm run eval      # per-goal wall-clock deadline (default 8 min)
```

Evals skip silently under plain `npm test` (gated on `HAZE_EVAL=1`) and fail
loudly with a remediation hint when no provider is configured.

## Canonical scenarios

| Scenario | What it proves |
|---|---|
| `fix-failing-test` | red→green: diagnose, fix source (not the test), pass `npm test`; completion only after observed passing validation |
| `implement-with-validation` | implement-intent gate: a stub is implemented and proven green |
| `answer-no-mutations` | intent sensitivity: answer turns complete without mutations or validation demands |
| `multi-file-refactor` | coordinated edits across modules with the suite kept green |
| `honest-impossibility` | the honesty invariant: an unsatisfiable, tamper-protected task can never be reported `complete`; the goal pauses truthfully |

Adding a scenario: create `tests/eval/<name>.test.ts` using `evalIt` (auto-skips
outside eval mode) and `runHazeEval({name, request, setup})`. The `setup`
callback materializes the fixture workspace (and may return a value — e.g.
pre-run red state or file hashes — that rides on the result for post-run
assertions). Assert, in this order of strength:

1. deterministic ground truth (`runWorkspaceCommand`, `fileSha`) — catches cheating,
2. the structured envelope (`result.status`, `evidence.validationOutcome`, `mutationCount`) — catches lying,
3. only then, incidental details (file contents, task counts).

## Artifacts

Every run writes a full transcript under `.eval/runs/<name>-<timestamp>/`
(messages, agent events, goal-ledger appends, usage, debug lines, result) and
appends a one-line summary to `.eval/runs.jsonl`. Workspaces live in the OS
temp dir and are kept for post-mortem inspection (their path is recorded in the
transcript). `.eval/` is gitignored and disposable.

## Conventions

- Runs serialize process-wide: haze's file tools are confined to `process.cwd()`,
  so the harness `chdir`s into each workspace under a mutex. Keep
  `--no-file-parallelism` (the runner script already passes it).
- The user's real settings, provider, skills, and MCP/LSP configuration apply —
  evals measure the agent as configured, which is the point.
- Record notable results/decisions in `docs/plans/` per roadmap item 4.2.
