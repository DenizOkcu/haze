# haze 0.8.0 comprehensive code and security review

**Review date:** 2026-07-10  
**Reviewer stance:** senior TypeScript/terminal-agent architect; optimize for DRY, KISS, and YAGNI without weakening haze's expert-user product model.

## Purpose and audience

haze is intentionally a high-agency terminal coding agent for experienced developers. It is not a sandbox and it deliberately permits model-directed shell commands without confirmation gates. This review therefore does **not** report “the model can run commands” as a vulnerability. It reviews whether the boundaries haze *does* promise are truthful and robust:

- file tools stay inside the current workspace and respect `.gitignore` by default;
- public URL fetches resist SSRF and DNS rebinding;
- provider/MCP secrets are not disclosed accidentally;
- cancellation, timeouts, output caps, sessions, and headless statuses mean what the UI and documentation say;
- optional integrations fail in isolation rather than hanging or corrupting a turn;
- implementation complexity remains proportionate to a compact expert tool.

The intended readers of the implementation artifacts are coding agents working incrementally from the linked findings and remediation plan.

## Material reviewed

Documentation was read before source review:

- `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, root and nested `AGENTS.md` files;
- the complete `docs/index.html` site;
- existing review artifacts under `docs/code-review/`;
- packaged skill documentation under `examples/skills/`.

Code review covered all source subtrees under `src/` and the complete test inventory under `tests/`, with detailed inspection of the CLI/turn loop, file tools, path helpers, bash execution/output reduction, fetch/URL guard, settings/providers, MCP/LSP, skills, session/log storage, context loading, compaction, and headless output.

Repository snapshot:

- 115 TypeScript/TSX source files, 11,586 LOC.
- 89 test files, 9,096 LOC.
- Largest orchestration files: `src/cli/commands/chat.tsx` (1,237 LOC), `src/cli/commands/streaming.ts` (439 LOC), `src/llm/webFetch.ts` (414 LOC), and `src/llm/hazeTools.ts` (371 LOC).

## Executive assessment

haze has a strong foundation for a young agent CLI: strict TypeScript, focused domain folders, unusually broad tests, structured tool results, explicit provider selection, SSRF-aware fetch transport pinning, scoped context files, compact session output, and bounded model-facing schemas. The 0.8.0 AI SDK migration is generally coherent.

The most important gaps are not missing features. They are mismatches between documented guarantees and runtime behavior:

1. **A turn is marked complete unconditionally after the stream ends**, even when step/tool budgets stopped unfinished work. The existing completion policy is tested but no longer wired into the runtime.
2. **Bash output is collected without a byte limit and cancellation kills only the shell process**, so noisy or forked commands can exhaust memory or continue after haze reports timeout/abort.
3. **`grep` can read an explicitly addressed ignored file**, bypassing the default `.gitignore` boundary.
4. **Secrets and detailed transcripts are created with ordinary umask-derived permissions**; on the reviewed machine, `~/.haze/settings.json` and history were `0644`, while `~/.haze` was `0755`.
5. **Symlinks bypass the intended skill-reference and LSP workspace boundaries.**
6. **MCP discovery has no explicit timeout or abort path**, despite the documentation saying an unreachable server never blocks the agent.
7. **Durable session and debug-log writes are fire-and-forget and unordered**, weakening resume/audit reliability.

These should be fixed before another broad feature release. Most remedies are small shared primitives, not frameworks.

## Finding index

### Security and boundary findings

See [`2026-07-10-security-findings.md`](./2026-07-10-security-findings.md).

| ID | Severity | Summary |
|---|---:|---|
| SEC-01 | High | Settings, sessions, logs, and history are not created with private permissions |
| SEC-02 | High | Bash output and raw-output storage permit memory exhaustion |
| SEC-03 | High | Bash timeout/abort does not terminate the process tree |
| SEC-04 | High | `grep` can search a directly named `.gitignore`d file |
| SEC-05 | High | Skill reference symlinks can escape the skill directory |
| SEC-06 | Medium | LSP file reads and returned locations do not enforce real workspace paths |
| SEC-07 | High | MCP connection/tool discovery can block indefinitely and ignores turn abort |
| SEC-08 | Medium | Remote provider/MCP credentials can be configured over plaintext HTTP without warning |

### Correctness and maintainability findings

See [`2026-07-10-architecture-findings.md`](./2026-07-10-architecture-findings.md).

| ID | Priority | Summary |
|---|---:|---|
| ARC-01 | P0 | Turn completion/status is not authoritative |
| ARC-02 | P0 | Structured tool failures are emitted/logged as successful tool events |
| ARC-03 | P1 | Session and log append ordering is nondeterministic and errors are swallowed |
| ARC-04 | P1 | `grep`'s advertised global cap is applied only after unbounded subprocess output |
| ARC-05 | P1 | Interactive startup suppresses malformed settings errors |
| ARC-06 | P1 | Removing the active provider automatically selects the first remaining provider/model |
| ARC-07 | P2 | stdio MCP key setup is accepted and then normalized away |
| ARC-08 | P1 | `ChatScreen` remains an oversized mode/state controller |
| ARC-09 | P1 | Retry/attempt lifecycle in `runAgentTurn` is recursive and emits contradictory durable events |
| ARC-10 | P2 | Resource limits are scattered and often bound returned text, not work performed |
| ARC-11 | P2 | Invalid skills are not isolated from the registry/request assembly |

## What is working well

- `src/core/safety/urlGuard.ts` plus `src/llm/webFetch.ts` pins hostname connections to already validated public IPs and revalidates every redirect. This directly addresses DNS-rebinding TOCTOU rather than relying on a second DNS lookup.
- File mutations use lexical and real-path workspace checks and pause when newly discovered scoped instructions apply.
- Tool schemas are bounded and structured; exact-edit recovery and failure reason codes are practical for models.
- Settings parsing validates known fields and preserves unknown fields on normal patch writes.
- Detailed LLM logs are opt-in with `--debug`.
- Headless stdout intentionally excludes raw tool inputs/outputs.
- Test breadth is excellent for project size: 831 tests across 89 files passed during review.
- Dependency audit reported no known production dependency vulnerabilities.

## Validation performed

```text
npm run typecheck       PASS
npm test                PASS — 89 files, 831 tests
npm run lint            PASS
npm run context:report  PASS
npm audit --omit=dev    PASS — 0 known vulnerabilities
```

Additional manual probes confirmed:

- bundled ripgrep returns matches when an ignored file is passed explicitly;
- current `~/.haze/settings.json` and input history were mode `0644`, and `~/.haze`/sessions directories were `0755` under the machine's normal umask.

No production source or generated `dist/` files were changed by this review.

## Recommended implementation order

Use [`2026-07-10-remediation-plan.md`](./2026-07-10-remediation-plan.md). In short:

1. Add adversarial regression tests for status truth, ignored paths, symlinks, permissions, subprocess output/process trees, MCP timeout, and ordered persistence.
2. Fix authoritative turn/tool status and retry lifecycle.
3. Add one secure private-storage primitive and one bounded subprocess primitive; migrate existing callers.
4. Close `grep`, skill, and LSP boundary gaps.
5. Add MCP connection deadlines/abort and isolate bad skills.
6. Simplify `ChatScreen` only after behavior is protected.

Do not add a permission-dialog system, container sandbox, dependency-injection framework, generic plugin framework, or broad policy engine. Those would conflict with the audience or violate YAGNI.
