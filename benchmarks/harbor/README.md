# Harbor agent benchmark

A single-task [Harbor](https://github.com/harbor-framework/harbor) benchmark
that pits four agent harnesses installed on this machine against each other:

- **Claude Code** (built-in `claude-code` harbor adapter)
- **nanocoder** (custom adapter: `agents/nanocoder_agent.py`)
- **pi** (built-in `pi` harbor adapter)
- **haze** (custom adapter: `agents/haze_agent.py`)

All harnesses run the **same model** (`glm-5.2` via the Z.ai Coding
Subscription key already configured on this machine), so the comparison
isolates the agent harness rather than the model.

## Task: `local/csv-query`

Implement a dependency-free Node.js CSV filtering CLI
(`--where` / `--select` / `--sort`) with RFC-4180-style quoted fields
(escaped quotes, embedded commas and newlines), exact output formatting,
and exit-code contracts. 17 deterministic pytest cases verify behavior
(edge cases: quoted commas, `""` escapes, `=` in values, stable
lexicographic sort, unknown-column and malformed-CSV errors).

## Layout

```
benchmarks/harbor/
├── agents/nanocoder_agent.py   # custom harbor adapter (nanocoder CLI)
├── agents/haze_agent.py        # custom harbor adapter (haze CLI)
├── tasks/csv-query/            # the benchmark task
│   ├── task.toml
│   ├── instruction.md          # prompt given to the agent
│   ├── environment/            # Dockerfile + task fixture files
│   ├── solution/solve.sh       # reference solution (oracle)
│   └── tests/                  # verifier (pytest via uv)
├── run-benchmark.sh            # runs all harnesses and prints a summary
└── jobs/                       # harbor job output (gitignored)
```

## Prerequisites

- `harbor` 0.20.x (`uv tool install harbor`) and Docker
- `claude` and `nanocoder` CLIs installed on the host (used only as the
  source of truth for versions/auth; the benchmark itself runs both
  harnesses inside Docker)

## Run

```bash
cd benchmarks/harbor
./run-benchmark.sh            # defaults to glm-5.2; runs all four harnesses
HARBOR_ATTEMPTS=3 ZAI_API_KEY=... ./run-benchmark.sh glm-5.2
# Optional lowest-observer-overhead haze run (final envelope only):
HAZE_OUTPUT=json ./run-benchmark.sh glm-5.2
```

The script resolves the Z.ai key from `$ZAI_API_KEY` or from the local
nanocoder config (`~/Library/Preferences/nanocoder/agents.config.json`).
The script writes credentials to a mode-`0600` temporary `.run/benchmark.env`, passes only its path through Harbor's `--env-file` option, and deletes it on exit. Secrets never enter process arguments or tracked files (`.run/` and `jobs/` are gitignored).

Per-harness endpoints on Z.ai: Claude Code uses the Anthropic-compatible
`/api/anthropic`, nanocoder and haze the OpenAI-compatible
`/api/coding/paas/v4/`, and pi its built-in `zai` provider. Agent versions are
pinned by default and can be overridden with `CLAUDE_CODE_VERSION`,
`NANOCODER_VERSION`, `PI_VERSION`, and `HAZE_VERSION`. `HARBOR_ATTEMPTS`
controls repeated trials (default 1). Each attempt has a 15-minute agent
timeout; reward is 1 (all tests pass) or 0.

## Why the same model for both harnesses?

Benchmarking "Claude Code with Claude" against "nanocoder with GLM" would
measure model quality as much as harness quality. Routing Claude Code at
Z.ai's Anthropic-compatible endpoint (`https://api.z.ai/api/anthropic`) and
nanocoder at the OpenAI-compatible one (`/api/coding/paas/v4/`) keeps the
backend identical, so differences in reward/tokens come from the harness.

To benchmark Claude Code against its native subscription instead, run:

```bash
claude setup-token   # once; prints a long-lived OAuth token
export CLAUDE_CODE_OAUTH_TOKEN=<token>
export CLAUDE_FORCE_OAUTH=1
PYTHONPATH=agents harbor run --path tasks/csv-query \
  --agent claude-code -m claude-sonnet-4-5 --ae ANTHROPIC_API_KEY= -y -o jobs
```

## The haze findings (2026-08-16)

The benchmark surfaced four real haze defects. All four are fixed on this branch with regression coverage:

1. **`writeFile` schema shadowed its own chunking error** (fixed). The input
   schema had `content: z.string().max(16384)`, so an oversized single-chunk
   write died at Zod validation with a cryptic `AI_TypeValidationError` before
   `execute` could return the actionable `write_chunk_too_large` guidance
   ("write the first chunk, then append=true"). Unit tests never caught it
   because they call `execute` directly. Fix: size policy lives only in
   `execute`. (`src/llm/hazeTools.ts`)
2. **Reads failed closed in Git-less workspaces** (fixed). `assertNotIgnored`
   threw `ignore_check_unavailable` for `readFile` when `git` was absent,
   contradicting the documented "reads fail open" contract — benchmark
   containers commonly have no Git. Fix: reads tolerate `unknown` ignore
   status; mutations keep failing closed. (`fileToolShared.ts`,
   `workspaceFile.ts`)
3. **Validation evidence was JS-toolchain-biased** (fixed). The shell classifier now recognizes common Python, Go, Rust, Make, Maven, Gradle, Ruby, .NET, Deno, Bun, and Node test commands. Direct, unchained execution of a file changed during the active goal also counts as bounded runtime evidence, so a successful `node csv-query.js … data.csv` run can satisfy completion without crediting unrelated shell commands. (`shellClassifier.ts`, `workState.ts`)
4. **Custom checks passed but the completion gate could not see them** (fixed).
   `shell` now accepts `purpose=validation`, producing structured evidence from
   the real exit result for ad hoc assertion scripts. Missing-validation repair
   gets one focused slice, rejected summaries leave active model context, and
   mutation/revision churn no longer extends the goal. Deadline exits preserve
   cumulative evidence and report `goal-deadline`, not `user-aborted`.

Adapter-side hardening (no core change): `--timeout 13m` bounds the goal
supervisor inside the harness deadline (fixes the SIGKILL/missing-envelope
case), and `HAZE_LOCAL_TARBALL` + harbor `--mounts` lets the benchmark run an
uncommitted local build.

## Results (2026-08-16, one run per harness)

### glm-5.3 differential (2026-08-16 22:49, haze 1.0.0 local build @ 7e66d7b)

| harness | reward | agent time | in tokens | cache read | out tokens | model | agent ver | notes |
|---|---|---|---|---|---|---|---|---|
| claude-code | **1.0** | 290s | 549,062 | 525,248 | 16,448 | glm-5.3 | 2.1.233 | clean run; $0.79 |
| nanocoder | **1.0** | 233s | 90,422 | not broken out | 11,036 | glm-5.3 | 1.29.0+local | token numbers from the local-build telemetry rerun below |
| pi | **1.0** | 149s | 101,817 | (incl.) | 8,934 | glm-5.3 | 0.73.1 | rerun after the pi-auth overlay fix (see below) |
| haze | **1.0** | 187s | 92,320 | 61,760 | 11,388 | glm-5.3 | 1.0.0 @ 7e66d7b | clean local-tarball run; 11 steps, 11 tools, 1 goal cycle, structured passing validation, zero stalls |

All four harnesses produced a correct `csv-query.js` (17/17 verifier tests). The provider served `glm-5.3` for the `glm-5.3` request in every haze step. Full per-step detail and interpretations: `results/20260816-224944-glm53-differential.html`. Known benchmark-infra issue this run: harbor 0.20.0's built-in pi adapter does not forward `ZAI_API_KEY` (no `zai` entry in its provider key allowlist), so pi's first attempt died at startup with `No API key found for zai`; rerunning with a compose overlay that injects the key (the `csv-query-pi-key` pattern) passed cleanly. Attach the overlay for pi cells until the mapping lands upstream.

Release-gate smoke (`csv-query-haze-1.0.0-release`, the packed 1.0.0 tarball, glm-5.3): reward **1.0**, 190s, 60,506 in / 12,148 out tokens, clean envelope (`completed`, validation `passed`, 1 goal cycle). The published-artifact path is verified end to end.

### nanocoder token-telemetry rerun (local build, glm-5.3)

`csv-query-nanocoder-glm53-tokens`: the nanocoder checkout at `../nanocoder` (HEAD `5e2a074`, unreleased 1.29.0+) added plain-mode token telemetry — the JSON result now carries `usage.inputTokens/outputTokens/totalTokens`, which the harbor adapter already parses. Verified locally end to end before packaging (`pnpm pack`, mounted via the new `NANOCODER_LOCAL_TARBALL` adapter env, mirroring `HAZE_LOCAL_TARBALL`). Solo csv-query run on glm-5.3: reward **1.0**, 182s, 13 tool calls, **in=90,422 / out=11,036 / total=101,458** — the same efficiency band as haze (92,320/11,388) and pi (101,817/8,934), and far below claude-code (549,062/16,448). Published 1.29.0 predates the telemetry (its `dist/plain` has no usage code), so registry installs still report nothing until the next nanocoder release. Accounting caveat: nanocoder sums the *final step's* usage per `chat()` call (a call may span several internal tool steps), while haze/pi sum every step — close enough for band comparison, not for exact deltas.

### glm-5.2 (2026-08-16, one run per harness)

| harness | reward | agent time | in tokens | out tokens | model | agent ver | notes |
|---|---|---|---|---|---|---|---|
| claude-code | **1.0** | ~249s | 328,990 (incl. cache) | 10,797 | glm-5.2 | 2.1.233 | clean run |
| nanocoder | **1.0** | ~242s | n/a | n/a | glm-5.2 | 1.29.0 | provider reports no token telemetry |
| pi | **1.0** | 196s | 108,701 (incl. cache) | 13,142 | glm-5.2 | 0.73.1 | clean run |
| haze | **1.0** | 165s | 57,538 (incl. 46,080 cache) | 9,314 | glm-5.2 | 0.11.0+fixes | clean local-build run; 1 turn, 8 model calls, 9 tool calls |

All four harnesses produced a correct `csv-query.js` (17/17 verifier tests). The latest haze run also exited cleanly with structured passing validation; its provider reported the actual response model as `glm-5.3` while the requested benchmark model remained `glm-5.2` (the endpoint serves a newer model than requested — record the served model, which later runs confirmed).

Caveats worth reading before drawing conclusions:

- **One trial per harness** — differences at this sample size are anecdotal,
  not statistical. Run with `--n-attempts 3+` for signal.
- **Z.ai stream flakiness**: the endpoint repeatedly terminates or stalls
  long streams (`terminated` / 300s idle stalls). It cost haze one failed
  28-minute run (retry pool exhausted → exit 1) before the fix: the bounded
  model-retry pool is now sized by the `modelRetries` setting (default 2,
  range 0–10; reported as `maxRetries` in `timeout`/`retry` events), so
  flaky providers can be given more headroom. The glm-5.3 differential run
  above completed with zero stalls at the default.
  Token counts for haze are summed from its NDJSON stream.
- Published-package runs use the pinned adapter versions. Set `HAZE_LOCAL_TARBALL` (haze) or `NANOCODER_LOCAL_TARBALL` (nanocoder) and provide the corresponding Harbor mount when testing an uncommitted local build.
- **Input-token accounting differs per harness** (cache reads included for
  claude-code/pi/haze; nanocoder's local-build telemetry reports totals
  without a cache breakdown — published 1.29.0 reports nothing), so the token
  columns are not directly comparable across harnesses. The haze adapter now
  treats AI SDK `inputTokens` as cache-inclusive and reports `cacheReadTokens`
  as its subset; older haze rows produced before this fix double-counted cache
  reads. nanocoder sums final-step usage per `chat()` call rather than every
  step (see the telemetry rerun note above).
- The runner continues after an individual harness infrastructure failure, prints every available result, and exits non-zero after the summary when any harness failed.

## Inspecting a run

```bash
harbor view jobs/<job-name>          # web UI over trajectories
cat jobs/<job-name>/*/agent/nanocoder-output.json
```
