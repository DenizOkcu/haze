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

| harness | reward | agent time | in tokens | out tokens | model | agent ver | notes |
|---|---|---|---|---|---|---|---|
| claude-code | **1.0** | ~249s | 328,990 (incl. cache) | 10,797 | glm-5.2 | 2.1.233 | clean run |
| nanocoder | **1.0** | ~242s | n/a | n/a | glm-5.2 | 1.29.0 | provider reports no token telemetry |
| pi | **1.0** | 196s | 108,701 (incl. cache) | 13,142 | glm-5.2 | 0.73.1 | clean run |
| haze | **1.0** | 165s | 57,538 (incl. 46,080 cache) | 9,314 | glm-5.2 | 0.11.0+fixes | clean local-build run; 1 turn, 8 model calls, 9 tool calls |

All four harnesses produced a correct `csv-query.js` (17/17 verifier tests). The latest haze run also exited cleanly with structured passing validation; its provider reported the actual response model as `glm-5.3` while the requested benchmark model remained `glm-5.2`.

Caveats worth reading before drawing conclusions:

- **One trial per harness** — differences at this sample size are anecdotal,
  not statistical. Run with `--n-attempts 3+` for signal.
- **Z.ai stream flakiness**: the endpoint repeatedly terminates or stalls
  long streams (`terminated` / 300s idle stalls). It cost haze one failed
  28-minute run (retry pool exhausted → exit 1). Haze's bounded model-retry
  pool (`MAX_MODEL_RETRIES = 2`, hardcoded in `stallRecovery.ts`) is small
  for such providers; making it configurable is another candidate fix.
  Token counts for haze are summed from its NDJSON stream.
- Published-package runs use the pinned adapter versions. Set `HAZE_LOCAL_TARBALL` and provide the corresponding Harbor mount when testing an uncommitted local haze build.
- **Input-token accounting differs per harness** (cache reads included for
  claude-code/pi/haze; nanocoder reports nothing), so the token columns are
  not directly comparable across harnesses. The haze adapter now treats AI SDK
  `inputTokens` as cache-inclusive and reports `cacheReadTokens` as its subset;
  older haze rows produced before this fix double-counted cache reads.
- The runner continues after an individual harness infrastructure failure, prints every available result, and exits non-zero after the summary when any harness failed.

## Inspecting a run

```bash
harbor view jobs/<job-name>          # web UI over trajectories
cat jobs/<job-name>/*/agent/nanocoder-output.json
```
