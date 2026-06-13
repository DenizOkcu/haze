# Token Efficiency Research

Research date: 2026-06-13

## Scope and method

This research covers all major token sources in Haze:

- system and project-context prompts;
- built-in, subagent, and skill tool schemas;
- model-message history and session restore;
- tool inputs and results;
- continuation and completion-gate calls;
- compaction and context-overflow recovery;
- subagent prompts and handoffs;
- model output and final-answer contracts;
- provider prompt caching and usage telemetry.

The repository audit inspected the current implementation in:

- `src/llm/systemPrompt.ts`
- `src/llm/hazeTools.ts`
- `src/cli/commands/streaming.ts`
- `src/core/agent/compaction.ts`
- `src/core/subagent/subagentRunner.ts`
- `src/config/contextFiles.ts`
- `src/skills/skillTools.ts`
- `src/core/goal/*`
- `src/cli/commands/chat.tsx`
- `src/core/log/llmLog.ts`

No private `~/.haze` settings, logs, sessions, or skills were inspected. The measured baseline uses tracked repository files and generated schemas only.

## Current token flow

For each main model step, Haze may send:

1. The full Haze system prompt.
2. Every loaded `AGENTS.md` and `CLAUDE.md`, up to 20,000 characters each.
3. All built-in tool schemas.
4. The subagent tool schema.
5. One schema per installed skill.
6. The full retained conversation.
7. Prior tool calls and results embedded in that conversation.
8. Synthetic user messages added by loop guards and completion policy.

The AI SDK then grows the message list across tool steps. A separate continuation starts another `streamText` call with the full retained conversation, rebuilt system prompt, and full tool set.

## Repository findings

### 1. Static prompt overhead is large and duplicated

`buildSystemPrompt()` is about 2.2k estimated tokens without project context. It describes every tool even though the tool schemas contain overlapping descriptions, repeats autonomy and validation rules in several sections, and includes the same final-response contract more than once.

In this repository, adding `AGENTS.md` raises the system prompt to about 6.3k estimated tokens. The eight built-in schemas add another 1.95k, and the subagent schema adds about 250. This is before history or tool output.

The subagent call uses:

```text
SUBAGENT_SYSTEM_PROMPT + buildSystemPrompt(contextFiles)
```

That gives a focused subagent both a dedicated instruction set and the complete parent operating contract. Much of it is redundant or irrelevant to the scoped task.

### 2. `readFile` returns duplicate content

`readFile` returns both:

- `lineNumberedText`, containing the selected content with line numbers; and
- `text`, containing the same selected content without line numbers.

The model receives both values. This nearly doubles the dominant part of every file-read result. In addition, omitting `limit` reads the full file, and `lineNumberedText` is not bounded by `MAX_OUTPUT_CHARS`.

This is the clearest no-regression token reduction: retain one numbered representation plus pagination metadata.

### 3. Tool results are retained long after their useful life

Raw reads, searches, bash output, write payloads, edit payloads, diffs, and validation summaries remain in the model conversation. A bash result can contain up to 50,000 characters each for stdout and stderr while also including a parsed `validationSummary` that may repeat the useful diagnostics.

The current compactor extracts only textual message parts, clips each older message to 500 characters, and does not semantically summarize tool state. It therefore has two opposing problems:

- before compaction, raw tool traffic is retained too long;
- during compaction, important state can be lost because tool details are not converted into a structured summary.

### 4. Text-only follow-ups still carry tool schemas

`streamAssistantResponse(..., allowTools = false)` sets `toolChoice: 'none'` but still passes `tools: availableTools`. Providers still receive the schemas even though no tool may be called. A final synthesis call should omit `tools` entirely.

### 5. Completion recovery can multiply full-context requests

The main stream allows 40 steps. A follow-up allows 30 steps. The completion loop can start up to 30 follow-ups. This protects autonomy, but each follow-up resends the full system, tools, and accumulated conversation. Long work should continue through compact work slices, not repeated full-trace calls.

The completion policy also appends synthetic user messages such as edit-recovery instructions, duplicate-tool warnings, and mutation nudges. These messages can become durable conversation content even though they are runtime control state, not user intent.

### 6. Task tracking creates avoidable model traffic

The system prompt requires `writeTasks` for work with three or more steps and directs the model to update the complete task list for every state transition. Because `writeTasks` has full-replacement semantics, each update repeats all task titles and creates another tool call/result pair in context.

Task state is valuable for long work, but it should be updated at phase boundaries or meaningful progress events, not after every small action. The UI can render persisted task state without echoing the full list back to the model.

### 7. Skill scaling is linear in installed skill count

Every installed skill becomes a separate `skill_*` tool. Each tool repeats a schema for an optional `reason`, and every skill description participates in every request. This is manageable with a few skills but grows without a bound.

A single skill-discovery/loading tool can preserve progressive disclosure while eliminating repeated per-skill schema structure.

### 8. Context files are all-or-nothing

Haze eagerly injects global context files and every ancestor `AGENTS.md`/`CLAUDE.md`, each capped at 20,000 characters. This provides strong instruction recall but has no total token budget, duplicate-content detection, section prioritization, or warning when context instructions dominate the request.

Project instructions are higher risk to compress than ordinary tool results. The first implementation should expose their cost and encourage concise files. Any selective loading or generated summary needs a dedicated instruction-following eval before rollout.

### 9. Current accounting is too approximate for optimization decisions

Tool-schema cost is estimated as tool-name tokens plus 250 tokens per tool. Actual schema sizes vary substantially. In the current built-ins, measured description plus JSON-schema size ranges from about 184 to 380 estimated tokens per tool.

The UI aggregates provider input/output usage and cache reads/writes, but it does not report:

- logical input versus non-cached billed input;
- exact serialized schema size;
- message tokens by role and content type;
- retained tool-result tokens by tool;
- tokens introduced by synthetic control messages;
- cache hit ratio by step;
- task outcome per token.

Optimization should begin with this accounting so savings are attributable.

## Research synthesis

### Context quality matters more than maximum context size

Anthropic's context-engineering guidance defines the goal as the smallest high-signal token set that produces the desired behavior. It recommends just-in-time retrieval, progressive disclosure, compaction, structured notes, and focused subagents for long-horizon work. It also specifically identifies old tool-result clearing as a low-risk first form of compaction.

The [Lost in the Middle](https://arxiv.org/abs/2307.03172) study found that model performance can degrade when relevant information is buried in the middle of long contexts. This supports reducing irrelevant transcript volume even when the model technically has enough context capacity.

Design conclusion: Haze should maintain a compact working set and durable external state, rather than treating the transcript as the only memory.

### Compaction must preserve state, not merely shorten text

Anthropic recommends preserving architectural decisions, unresolved bugs, implementation details, and recently accessed files while removing redundant tool output. Its current context-editing API clears old tool results first and retains recent uses. OpenAI's compaction API similarly carries prior state into a smaller canonical context.

The [ACE paper](https://arxiv.org/abs/2510.04618) warns about brevity bias and context collapse when context is repeatedly rewritten. Although its system differs from Haze, the risk applies: repeated free-form summaries can gradually erase constraints.

Design conclusion: Haze should use a structured, incrementally updated `WorkState` plus recent raw messages. Free-form summaries should supplement, not replace, exact fields such as goal, constraints, touched files, validation status, decisions, and next action.

### Tool output should be high signal and bounded

Anthropic's tool-design research recommends returning only information that directly informs the next action and using evaluations to tune tools. The current Haze tool set is already small and distinct, but several outputs are unnecessarily broad or duplicated.

Design conclusion: keep tool capabilities, but change result contracts to concise defaults with explicit pagination or retrieval handles for omitted detail.

### Prompt caching changes the best request layout

OpenAI prompt caching requires exact prefix matches and explicitly notes that tool definitions must remain identical between requests. Anthropic caches in `tools`, then `system`, then `messages` order and recommends static content first. OpenRouter uses provider-sticky routing and supports an explicit `session_id` for long agentic conversations.

The 2026 preprint [Don't Break the Cache](https://arxiv.org/abs/2601.06007) reports 45-80% cost reduction and 13-31% time-to-first-token improvement on its long-horizon benchmark, while finding that cache-aware prompt structure is more reliable than naive caching. These figures are evidence from that benchmark, not expected Haze results.

Design conclusion:

- Keep core tools and static instructions byte-stable within a session.
- Put volatile state after the stable prefix.
- Do not rebuild or reorder tools unnecessarily.
- Compare smaller dynamic tool sets against cache loss before adopting them.
- Track cache-read tokens and effective billed input, not only logical input.

### Multi-agent work trades tokens for isolation and parallelism

Anthropic reports that subagents help when broad exploration can be isolated and returned as concise summaries. It also notes that multi-agent systems consume substantially more tokens than single-agent flows and recommends outcome-based evaluation.

Design conclusion: Haze's current restriction to independent parallel work is correct. Improve subagent efficiency by supplying only the scoped prompt, relevant project instructions, a minimal tool set, and a structured handoff. Do not use subagents as a general compaction mechanism.

### Compression algorithms are promising but not the first lever

[LongLLMLingua](https://arxiv.org/abs/2310.06839) reports large token and latency reductions on long-context benchmarks through prompt compression, sometimes with improved task performance. Its results justify an optional future experiment, but learned compression adds another model, latency, dependencies, and potential code-token corruption.

Design conclusion: first remove exact duplication, bound tool output, clear stale results, and preserve structured state. Evaluate learned or semantic compression only after these deterministic changes plateau.

## Recommended architecture

Haze should separate four forms of state:

1. **Stable policy** - concise Haze contract, project instructions, and stable core tool schemas.
2. **Working state** - structured goal, constraints, decisions, files, validation, tasks, blockers, and next action.
3. **Recent evidence** - the latest user turns and recent tool interactions needed for immediate reasoning.
4. **External artifacts** - full command output, old file reads, subagent artifacts, and session history available by reference when needed.

The model should receive all of stable policy, all of working state, a bounded window of recent evidence, and only referenced external artifacts requested just in time.

## Alternatives considered

### Only shorten the system prompt

Insufficient. It saves static overhead but does not address tool-result growth, repeated follow-ups, or long-session degradation.

### Only rely on provider caching

Insufficient. Caching reduces cost and latency but not logical context size, attention dilution, or context overflow. Cache behavior also varies by provider.

### Aggressively drop old messages by count

Unsafe. Message count is a poor proxy for tokens and importance. One bash or file result may be larger than dozens of chat messages.

### Summarize the whole conversation on every turn

Too expensive and prone to summary drift. Compaction should trigger by token pressure or completed phase, and exact structured state should be preserved outside the free-form summary.

### Select tools only from regex-classified intent

Potentially useful, but risky as an initial change. Misclassification can remove a needed tool, and changing tool lists can reduce cache hits. It belongs behind an eval and feature flag.

## Primary sources

- [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [OpenAI Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
- [Anthropic Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Anthropic Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Anthropic Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Anthropic How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Vercel AI SDK tool calling and `prepareStep`](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [OpenRouter Prompt caching and sticky routing](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- [Lost in the Middle](https://arxiv.org/abs/2307.03172)
- [LongLLMLingua](https://arxiv.org/abs/2310.06839)
- [Agentic Context Engineering](https://arxiv.org/abs/2510.04618)
- [Don't Break the Cache](https://arxiv.org/abs/2601.06007)
