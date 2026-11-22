# Harbor agent benchmark

A reproducible Harbor comparison of haze, Pi, nanocoder and Claude Code on
`local/csv-query`. The runner uses GLM-5.3 through the Z.ai Coding endpoint by
default. Every agent receives the same task and requested model, but differences
in provider protocol, model configuration, token accounting and sampling still
limit what can be attributed to the harness.

## Task and verifier

The task asks for a dependency-free Node.js CSV filtering CLI. The verifier
checks exact output, filtering, column selection, errors and byte-wise stable
sorting. The current suite has **19 tests**; two were added after the 2026-08-16
runs below, so scores across these suite versions are not directly equivalent.
Harbor directory checksums cover the task directory, including incidental files; see the latest report for a cache-related checksum difference.

## Run a comparison

Prerequisites: Docker running, Harbor 0.27.0 (the runner prefers
`benchmarks/harbor/.run/harbor-0.27/bin/harbor`, then `.venv/bin/harbor`;
set `HARBOR_BIN` to choose another), and access to the
Z.ai Coding API. The CLIs are installed inside the trial containers, not taken
from the host. Configure `ZAI_API_KEY` in the environment or a Z.ai provider in
the local nanocoder config. Credentials are stored in a unique mode-0600
file for the duration of the run and removed on exit; do not publish raw jobs
without reviewing them for secrets and private information.

```bash
cd benchmarks/harbor
# Install Harbor 0.27.0 in an isolated environment:
uv venv .run/harbor-0.27 --python 3.12
uv pip install --python .run/harbor-0.27/bin/python 'harbor==0.27.0'
# Haze, Pi and Claude Code, one attempt apiece, GLM-5.3:
./run-benchmark.sh
# Choose agents and repeat each trial (serial execution):
HARBOR_AGENTS=haze,pi,claude-code HARBOR_ATTEMPTS=3 ./run-benchmark.sh glm-5.3
# Explicit low reasoning for the selected agents:
HARBOR_REASONING_LOW=1 ./run-benchmark.sh glm-5.3
# Run just one agent:
HARBOR_AGENTS=pi ./run-benchmark.sh glm-5.3
python3 -m unittest discover -s tests -v
```

Defaults pinned for this refresh: Claude Code 2.1.330, nanocoder 1.32.0,
Pi 0.73.1, and the haze version in the repository's `package.json` (installed
from npm). Override with `CLAUDE_CODE_VERSION`, `NANOCODER_VERSION`,
`PI_VERSION`, or `HAZE_VERSION`; use published versions that actually exist.
The Pi adapter forwards `ZAI_API_KEY` to the agent container. Claude uses the Anthropic-compatible endpoint; haze and nanocoder use
the OpenAI-compatible endpoint; Pi uses its `zai` provider. Custom endpoint
overrides are available via `ANTHROPIC_BASE_URL`, `NANOCODER_BASE_URL`, and
`HAZE_BASE_URL` and must refer to the same backend for a comparison.

Each selected agent gets a separate job and a 15-minute agent timeout. The
runner continues after a failed Harbor command and prints results from only
this invocation. A reward of 1 means all verifier tests passed; an agent error
and a verifier result are separate facts. The job directories contain the
full trial results, trajectories and verifier reports. `harbor view jobs/<job>`
opens a trajectory. Missing telemetry is shown as `n/a`, never as zero.

Before replacing the website numbers, review each trial's verifier, errors,
actual served model and telemetry. Run multiple attempts, report pass counts and
the distribution of durations and tokens, and disclose missing or incompatible
measurements. Do not mix telemetry from different attempts into one row. The
website source is `website/src/pages/index.astro`; regenerate the public `docs/`
with `npm run sync --prefix website` after editing. Historical reports remain
unchanged as records of their original runs.

## Latest run

[2026-11-21 GLM-5.3 comparison](results/20261121-glm53.md): all four agents passed 19/19 tests in one trial each. The [low-reasoning run on Harbor 0.27.0](results/20261121-glm53-low-harbor027.md) reports separate results.

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
- Historical local-build runs used explicit Harbor mounts and tarballs; the runner above installs published packages.
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

## Small coding-task pilot

Run three fixed Harbor task revisions with haze and GLM-5.3, low reasoning:

```bash
cd benchmarks/harbor
./run-coding-pilot.sh
# Optional: run the same set with haze, Pi and Claude Code:
HARBOR_AGENTS=haze,pi,claude-code ./run-coding-pilot.sh
```

The pilot downloads `aider/polyglot_javascript_resistor-color-trio@1`,
`aider/polyglot_javascript_rectangles@1`, and
`swe-bench/django__django-11728@1` into `.run/coding-pilot-pinned/`. Each task
is run serially in Docker with one attempt and the normal 13-minute haze goal
deadline. SWE-bench's x86 image uses `linux/amd64` emulation on Apple Silicon;
image tags and external dependencies can still change. Each trial reports
verifier reward and agent errors separately. The pilot prints live haze tool
names, step token counts, and cumulative token counts by reading the active
container's log every five seconds; this monitoring has some overhead. The
final aggregate reports missing usage and agent errors rather than treating
those as successful runs. The existing runner supports the same progress view
with `HARBOR_PROGRESS=1`.

The upstream Aider task revisions currently ship tests marked skipped: this
pilot observed only one active verifier case per JavaScript task. Their
rewards do not establish that the whole exercise works. See the
[pilot report](results/20261121-coding-pilot.md) before using its scores.

## Real JavaScript repository pilot

`./run-js-plugin-pilot.sh` downloads a content-hash-pinned NodeBB plugin-ID
validation task from SWE-bench Pro and runs haze, Pi and Claude Code
serially, using GLM-5.3-Flash with low reasoning. Set `HARBOR_AGENTS=haze` to
run only haze. Progress prints tool events and available usage as it arrives;
nanocoder's JSON mode buffers its token totals until exit. The default
13-minute agent limit applies; the verifier runs separately afterward. Docker
uses x86 emulation on Apple Silicon. Codex and Gemini CLI join the same
comparison through local bridges: `./run-codex-nodebb.sh` starts a LiteLLM
proxy that exposes the OpenAI Responses API and forwards to the Z.ai chat
endpoint, and `./run-gemini-nodebb.sh` starts `gemini_bridge.py`, a
dependency-free generateContent-to-chat translator for Gemini CLI's native
protocol (`python3 gemini_bridge.py --selftest` checks the translators).
