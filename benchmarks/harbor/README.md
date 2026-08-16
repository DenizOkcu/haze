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
├── run-benchmark.sh            # runs both harnesses and prints a summary
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
ZAI_API_KEY=... ./run-benchmark.sh glm-5.2
```

The script resolves the Z.ai key from `$ZAI_API_KEY` or from the local
nanocoder config (`~/Library/Preferences/nanocoder/agents.config.json`).
Secrets are passed to the containers via `--ae` env vars and never written
into the repo (`.run/` and `jobs/` are gitignored).

Per-harness endpoints on Z.ai: Claude Code uses the Anthropic-compatible
`/api/anthropic`, nanocoder and haze the OpenAI-compatible
`/api/coding/paas/v4/`, and pi its built-in `zai` provider. Each harness gets
one trial with a 15-minute agent timeout; reward is 1 (all tests pass) or 0.

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

The benchmark surfaced three real haze defects. Two are fixed on this branch
(with regression tests, full suite green), one is a documented design gap:

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
3. **Validation evidence is JS-toolchain-biased** (partially fixed). The bash
   classifier only credited `npm test`/`vitest`/`jest`/`tsc`/`eslint` as
   validation, so correct completions in Python/Go/Rust/make/etc. repos could
   never satisfy the evidence gate. Widened to `pytest`, `go test`, `cargo
   test`, `make check`, `mvn verify`, `rspec`, `dotnet test`, `node --test`, …
   (`bashClassifier.ts`)

**Open design gap:** running the artifact you just wrote (`node csv-query.js
… data.csv`) is still not credited as validation, so this task's correct
solution took a 3-turn no-progress loop to a `failed` verdict despite reward
1.0. Crediting exit-0 execution of files mutated this turn (hook:
`observeWorkToolEvent`'s bash branch in `src/core/agent/workState.ts`) would
let such goals complete structurally in one turn — but it weakens the
evidence gate and deserves a deliberate decision.

Adapter-side hardening (no core change): `--timeout 13m` bounds the goal
supervisor inside the harness deadline (fixes the SIGKILL/missing-envelope
case), and `HAZE_LOCAL_TARBALL` + harbor `--mounts` lets the benchmark run an
uncommitted local build.

## Results (2026-08-16, one run per harness)

| harness | reward | agent time | in tokens | out tokens | model | agent ver | notes |
|---|---|---|---|---|---|---|---|
| claude-code | **1.0** | ~249s | 328,990 (incl. cache) | 10,797 | glm-5.2 | 2.1.233 | clean run |
| nanocoder | **1.0** | ~242s | n/a | n/a | glm-5.2 | 1.29.0 | provider reports no token telemetry |
| pi | **1.0** | 222s | 141,276 (incl. cache) | 11,357 | glm-5.2 | 0.73.1 | clean run, lowest token use |
| haze | **1.0** | ~730s (13m cap) | ~555k (incl. cache) | 33,238 | glm-5.2 | 0.11.0+fixes | local build; graceful exit, goal loop ended no-progress (see findings) |

All four harnesses produced a correct `csv-query.js` (17/17 verifier tests).

Caveats worth reading before drawing conclusions:

- **One trial per harness** — differences at this sample size are anecdotal,
  not statistical. Run with `--n-attempts 3+` for signal.
- **Z.ai stream flakiness**: the endpoint repeatedly terminates or stalls
  long streams (`terminated` / 300s idle stalls). It cost haze one failed
  28-minute run (retry pool exhausted → exit 1). Haze's bounded model-retry
  pool (`MAX_MODEL_RETRIES = 2`, hardcoded in `stallRecovery.ts`) is small
  for such providers; making it configurable is another candidate fix.
  Token counts for haze are summed from its NDJSON stream.
- **Agent versions differ between host and container**: adapters install
  `@latest` from npm inside the container (pi 0.73.1 vs 0.84.2 on the host).
- **Input-token accounting differs per harness** (cache reads included for
  claude-code/pi/haze; nanocoder reports nothing), so the token columns are
  not directly comparable across harnesses.
- Token counts for haze were summed from its NDJSON stream (the process was
  killed before it could emit its final usage envelope).

## Inspecting a run

```bash
harbor view jobs/<job-name>          # web UI over trajectories
cat jobs/<job-name>/*/agent/nanocoder-output.json
```
