# Configuration, providers, LSP, and skills

See [README](README.md). These findings are open. Source code was inspected; actual credential stores and live provider authentication were not accessed.

## CI-01 — Provider discovery sends a draft key before transport validation

**Priority:** P1 · **Evidence:** source-traced end-to-end · **Confidence:** high.

**Locations:** `src/config/modelDiscovery.ts:200-211`, `src/cli/chat/wizard/fieldTransitions.ts:19-25`, `src/cli/chat/wizard/providerHandlers.ts:102-108`, `src/cli/chat/wizard/providerHandlers.ts:283-292`, `src/cli/commands/providerWizard.ts:64`.

Entering a custom provider URL and key triggers discovery immediately. Discovery sends Authorization without calling `assertCredentialedEndpointSecure`; validation at final provider save is too late. A remote plaintext HTTP draft can transmit the key even if saving it is subsequently refused. The main inference client and MCP initialization do call the shared guard, so this is a missing path, not a request to redesign the trust model.

**Smallest fix:** apply the shared endpoint check immediately before discovery's network call. Keep loopback HTTP supported. Reject disallowed redirects/downgrades according to the same credential transport policy.

**Acceptance:** inject a fetch spy and a synthetic non-secret marker; a credentialed remote HTTP URL must be rejected without invoking fetch. Test HTTPS, keyless requests, allowed loopback, invalid URLs, and redirects without using real credentials.

## CI-02 — LSP pull diagnostics use the wrong capability and method names

**Priority:** P2 · **Evidence:** protocol/source mismatch · **Confidence:** high; no external server reproduction.

**Locations:** `src/llm/lsp/client.ts:183-187`, `src/llm/lsp/requests.ts:172-198`.

The standard server capability is `diagnosticProvider`, and the document pull method is `textDocument/diagnostic`. The implementation checks `capabilities.textDocumentDiagnostic` and calls `textDocument/documentDiagnostic`. A standards-compliant pull-only server is treated as push-only, then a 500ms timeout returns `{ok: true, diagnostics: []}`. That can falsely suggest a clean file when no diagnostic result was received.

**Smallest fix:** use the protocol names and distinguish an explicit empty report from absent/timed-out diagnostics. Keep push fallback for servers that support it; do not treat silence as affirmative cleanliness.

**Acceptance:** a fake server advertising only diagnosticProvider receives textDocument/diagnostic and returns a known error; no-report timeout is distinguishable from an empty report. Include unchanged-report handling and push-only servers. Prefer a standards-shaped fixture rather than a mock reproducing the implementation's typo.

## CI-03 — Skills read references without the shared secret-file policy

**Priority:** P1 · **Evidence:** source-traced · **Confidence:** high.

**Locations:** `src/skills/SkillLoader.ts:48-58`, `src/skills/SkillLoader.ts:61-72`, `src/skills/skillTools.ts:24-28`.

Skill references are confined to the skill directory, but there is no protected-secret-name/real-path check before reading them. A project skill can reference a protected-name file within its directory; the loader eagerly reads it, and the skill tool can return the content. Confinement and the untrusted-content wrapper do not enforce the secret prohibition.

**Smallest fix:** apply shared secret policy to skill bodies/references before reading, including real paths. Keep ordinary global/project skill precedence unchanged. Ensure errors contain only safe path metadata.

**Acceptance:** mocked reads prove protected references are refused before content access and cannot be surfaced through the reference tool; ordinary Markdown and documentation-template references still work. Avoid accessing actual secret files during regression work.

## CI-04 — Input caps do not bound aggregate discovery allocations

**Priority:** P2 · **Type:** resource-exhaustion risk · **Evidence:** source-traced.

**Locations:** `src/config/modelDiscovery.ts:24-31`, `src/config/modelDiscovery.ts:127-130`, `src/config/modelDiscovery.ts:218-225`, `src/skills/SkillLoader.ts:71`.

The model-count cap is applied only after response.json(), mapping, sorting, and deduplication. Model limits are harvested for the entire response rather than the capped selected IDs. Skills cap each reference but launch Promise.all over every referenced path, with no aggregate byte/reference budget. An oversized provider response or a dense skill can therefore create far larger allocations than its advertised result size suggests.

**Smallest fix:** bounded streaming JSON-body acquisition for discovery, bounded reference count/aggregate bytes, and small fixed-concurrency loading. Consider lazy reference loading because only one reference is returned per skill call. Reuse existing bounded I/O primitives instead of adding a framework.

**Acceptance:** oversized synthetic responses/references fail or truncate with explicit metadata before aggregate allocations grow without bound. Existing picker behavior and ordinary skill reference resolution must remain intact.

## CI-05 — Task persistence uses lexical confinement only

**Priority:** P1 · **Evidence:** source-traced · **Confidence:** high.

**Locations:** `src/core/tasks/taskStorage.ts:32-33`, `src/core/tasks/taskStorage.ts:40-52`.

Tasks resolve `.haze/tasks.json` lexically and then read/write it directly. A repository with a symlinked `.haze` directory or tasks.json can redirect these operations outside the workspace, unlike skill builders and ordinary file mutations. This is a concrete gap in the workspace-local state contract; an atomic write alone would not repair a symlinked ancestor.

**Smallest fix:** use existing real-path/writable-ancestor confinement before reading or writing task state, plus protected-path checks where relevant. Preserve the documented nonfatal loading behavior. Keep full-list replacement semantics and avoid global task storage.

**Acceptance:** use harmless temp-directory targets to prove a symlink escape is refused without modifying the external target. Test missing directories, valid in-workspace paths, and nonfatal load errors. Consider atomic replacement as a separate small reliability improvement, not a prerequisite for a storage redesign.

## Notes deliberately not promoted to mandatory redesigns

- `src/config/AGENTS.md` explicitly accepts single-writer settings updates. No distributed lock or database is proposed.
- `src/config/privateStorage.ts:70-79` has an unlink-before-rename Windows fallback with a data-loss window if replacement then fails. Windows is explicitly experimental in CI; validate and repair this before advertising supported Windows durability, rather than making it a release-blocking POSIX defect.
- MCP discovery has per-server time bounds and bounded concurrency. That is a useful existing pattern for CI-04; there is no justification here for replacing MCP transport architecture.
- OAuth refresh/account-switch races, full redirect credential behavior, and live gateway compatibility need dedicated mocked/live integration review. No credential leak through those paths is claimed from this pass.
