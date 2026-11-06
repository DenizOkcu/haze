# Improvements Backlog

Prioritized list of DRY/YAGNI/KISS improvements for the haze codebase.

## Priority 1: Critical Fixes
- [01-tool-output-reduction.md](01-tool-output-reduction.md) (DRY)
- [02-path-handling-centralization.md](02-path-handling-centralization.md) (DRY)
- [03-validation-parsing-consolidation.md](03-validation-parsing-consolidation.md) (DRY)
- [04-session-persistence-refactor.md](04-session-persistence-refactor.md) (DRY)

## Priority 2: Speculative Feature Removal
- [05-mcp-deprecation.md](05-mcp-deprecation.md) (YAGNI)
- [06-subagent-profiles-simplification.md](06-subagent-profiles-simplification.md) (YAGNI)

## Priority 3: Unnecessary Complexity
- [07-reasoning-effort-simplification.md](07-reasoning-effort-simplification.md) (KISS)
- [08-transcript-partitioning-removal.md](08-transcript-partitioning-removal.md) (KISS)
- [09-wizard-flow-split.md](09-wizard-flow-split.md) (KISS)

## Priority 4: Maintainability Risks
- [10-large-file-split.md](10-large-file-split.md)
- [11-tool-schema-narrowing.md](11-tool-schema-narrowing.md)
- [12-shell-tool-safety-hardening.md](12-shell-tool-safety-hardening.md)

## How to Use
1. Pick a task from **Priority 1** and implement it.
2. Validate with tests and manual checks.
3. Move to the next task.