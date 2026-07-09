# src/llm/AGENTS.md

Last updated: 2026-07-09.

Model client, prompts, built-in tools, LSP/MCP integration, and tool result types.

## Responsibilities

- `client.ts` builds the active OpenAI-compatible model from configured settings. Return `undefined` when no provider/model is configured.
- `systemPrompt.ts` and `initPrompt.ts` are model-facing behavior contracts; keep them concise, explicit, and synced with real tools.
- `requestContext.ts` assembles system prompt, skills, built-ins, optional LSP tools, MCP tools, and context files for a turn. Close MCP clients in callers' `finally` paths.
- `hazeTools.ts` defines the public built-in tool catalog and schemas.
- `tools/**` contains implementation helpers split out of `hazeTools.ts`.
- `lsp.ts`/`lspTools.ts` provide optional read-only stdio LSP navigation.
- `mcp.ts` loads tools from configured MCP servers and skips collisions rather than shadowing built-ins.
- `toolResultTypes.ts` contains structured result types and guards shared by tools, formatters, and tests.
- `webFetch.ts` implements public URL fetching and content extraction behind the `fetch` tool.

## Built-in tool contract

- Tools are intentionally small, structured, and workspace-safe.
- File tools are confined to `process.cwd()` via workspace path helpers and respect `.gitignore` unless explicit `allowIgnored`/`includeIgnored` options are used.
- `listFiles`, `readFile`, `grep`, `bash`, and `fetch` are deduplicated within a turn when no mutation occurred.
- `editFile`, `replaceLines`, and `writeFile` are mutating; they must check scoped nested instructions before writing and pause if new applicable instructions are discovered.
- Failed mutations force a fresh `readFile` before another mutation attempt on the same path.
- Tool outputs should be JSON-serializable, bounded, and include recovery hints on failure.
- Large output should use `storeToolOutput`/handles and reduction metadata rather than returning unbounded text.

## Prompt/tool synchronization

When adding/removing/changing a tool or result shape:

- Update the tool schema and descriptions.
- Update `systemPrompt.ts` if model behavior guidance changes.
- Update `formatters.ts`/CLI display if users see different summaries.
- Update tests under `tests/hazeTools/**` and `tests/llm/**`.

## Provider/MCP/LSP rules

Current reliability contracts:

- LSP stdio protocol errors must reject pending requests and isolate the failed server; malformed server output must not crash the CLI.
- Fetch byte limits are byte limits, including for UTF-8/multibyte content and both streaming and non-streaming bodies.

- Do not invent default providers/models; honor `config/providers.ts` resolution.
- MCP tools are optional per turn. Failures should be isolated and surfaced as system/UI messages, not crash unrelated turns.
- LSP tools are read-only and should only appear when enabled and the configured server command is available.
