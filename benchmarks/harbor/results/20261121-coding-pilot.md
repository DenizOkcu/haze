# Coding-task pilot — haze, GLM-5.3, 2026-11-21

One trial per fixed Harbor Hub task revision on Harbor 0.27.0 with published
haze 1.7.12 and GLM-5.3 through Z.ai. Low reasoning was requested and haze
reported that it was applied. Tasks ran serially. Times below are agent phase
only, excluding Docker setup and verification. Input totals include cache
reads; provider-side effective effort was not independently attested.

| Task | Verifier | Agent exit | Agent time | Input | Cache reads | Output |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `aider/polyglot_javascript_resistor-color-trio@1` | fail | clean | 27 s | 35,533 | 28,736 | 696 |
| `aider/polyglot_javascript_rectangles@1` | pass | clean | 32 s | 31,893 | 25,216 | 973 |
| `swe-bench/django__django-11728@1` | pass | failed | 177 s | 317,881 | 287,616 | 6,445 |
| **Total** | **2/3** | **2/3 clean** | **236 s** | **385,307** | **341,568** | **8,114** |

The Aider verifiers ran only one active test each: resistor-color-trio had five
skipped, and rectangles had thirteen skipped. The rectangles reward therefore
establishes only that its one active test passed; it does not demonstrate a
complete implementation. The resistor test expected `label` as a property,
but haze generated a method.

The Django patch passed the upstream SWE-bench verifier, but haze exited with
`NonZeroAgentExitCodeError`: its completion evidence remained in a failed
validation state despite later passing checks. A verifier pass should not be
reported as a clean agent run. The first Django environment build failed on
Apple Silicon because its image is x86-only; the successful trial used Docker
`linux/amd64` emulation. It is excluded from token and pass-rate denominators
because the agent never started. Emulation affects timing.

The raw local jobs are:

- `polyglot_javascript_resistor-color-trio-haze-low-20261121-185525-51940`
- `polyglot_javascript_rectangles-haze-low-20261121-185729-52392`
- `django__django-11728-haze-low-20261121-185903-52926`

They are gitignored and can contain sensitive information. The monitoring tool
reads agent logs at five-second intervals and may affect timings. The sample is
far too small to estimate a general pass rate or compare agents.
