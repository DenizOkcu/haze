/**
 * Curated model metadata catalog (Pillar 1.8 of the Pi learning roadmap).
 *
 * Keys are **model-name patterns** (not provider names) because haze reaches
 * most models through user-configured OpenAI-compatible gateways where the
 * provider name is arbitrary — the model id is the only stable identity.
 *
 * Precedence (enforced in `llm/client.ts`): per-model `modelLimits` settings →
 * this catalog → user-set context-window fallback → built-in default fallback.
 * Values are deliberately conservative (input-safe): when a family differs
 * between variants, the smaller window wins — under-budgeting only compacts a
 * little earlier, over-budgeting hard-fails the request. First match wins, so
 * keep more specific patterns before broader family prefixes.
 *
 * Local inference servers (localhost URLs) never consult the catalog: their
 * effective window is set by server configuration (often far below the model's
 * nominal window) and silent truncation there is undetectable.
 */

export interface CatalogModelLimits {
  contextWindowTokens: number;
  maxOutputTokens?: number;
}

interface CatalogEntry extends CatalogModelLimits {
  /** Lower-cased model-name pattern; matched with `startsWith` unless it contains '*', then prefix-before-'*' match. */
  match: string;
  note?: string;
}

const MODEL_CATALOG: readonly CatalogEntry[] = [
  // ── OpenAI ────────────────────────────────────────────────────────────────
  {match: 'gpt-5.1-codex', contextWindowTokens: 400_000, maxOutputTokens: 128_000},
  {match: 'gpt-5.1-codex-mini', contextWindowTokens: 400_000, maxOutputTokens: 128_000},
  {match: 'gpt-5', contextWindowTokens: 400_000, maxOutputTokens: 128_000},
  {match: 'gpt-4.1', contextWindowTokens: 1_047_576, maxOutputTokens: 32_768},
  {match: 'gpt-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_384},
  {match: 'o4', contextWindowTokens: 200_000, maxOutputTokens: 100_000},
  {match: 'o3', contextWindowTokens: 200_000, maxOutputTokens: 100_000},
  {match: 'o1', contextWindowTokens: 200_000, maxOutputTokens: 100_000},
  // ── Anthropic ─────────────────────────────────────────────────────────────
  {match: 'claude-opus-4', contextWindowTokens: 200_000, maxOutputTokens: 32_000},
  {match: 'claude-sonnet-4', contextWindowTokens: 200_000, maxOutputTokens: 64_000},
  {match: 'claude-haiku-4', contextWindowTokens: 200_000, maxOutputTokens: 32_000},
  {match: 'claude-3-7', contextWindowTokens: 200_000, maxOutputTokens: 64_000},
  {match: 'claude-3-5', contextWindowTokens: 200_000, maxOutputTokens: 8_192},
  // ── Google ────────────────────────────────────────────────────────────────
  {match: 'gemini-3', contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
  {match: 'gemini-2.5', contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
  {match: 'gemini-2.0', contextWindowTokens: 1_048_576, maxOutputTokens: 8_192},
  // ── xAI ───────────────────────────────────────────────────────────────────
  {match: 'grok-4', contextWindowTokens: 256_000, maxOutputTokens: 32_768},
  {match: 'grok-3', contextWindowTokens: 131_072, maxOutputTokens: 32_768},
  // ── DeepSeek ──────────────────────────────────────────────────────────────
  {match: 'deepseek-reasoner', contextWindowTokens: 128_000, maxOutputTokens: 32_768, note: 'R1/reasoner family'},
  {match: 'deepseek-r1', contextWindowTokens: 128_000, maxOutputTokens: 32_768},
  {match: 'deepseek', contextWindowTokens: 128_000, maxOutputTokens: 8_192},
  // ── Alibaba / Moonshot / Zhipu / MiniMax ─────────────────────────────────
  {match: 'qwen3-coder', contextWindowTokens: 262_144, maxOutputTokens: 32_768},
  {match: 'qwen3', contextWindowTokens: 131_072, maxOutputTokens: 32_768, note: 'native window without YaRN extension'},
  {match: 'qwen', contextWindowTokens: 131_072, maxOutputTokens: 8_192},
  {match: 'kimi-k2', contextWindowTokens: 131_072, maxOutputTokens: 32_768, note: 'input-safe half of the 256K total'},
  {match: 'glm-4.6', contextWindowTokens: 200_000, maxOutputTokens: 32_768},
  {match: 'glm-4.5', contextWindowTokens: 131_072, maxOutputTokens: 32_768},
  {match: 'minimax-m2', contextWindowTokens: 204_800, maxOutputTokens: 1_048_576, note: 'output budget exceeds window in interleave mode'},
  // ── Meta / Mistral ───────────────────────────────────────────────────────
  {match: 'llama-4-maverick', contextWindowTokens: 1_048_576, maxOutputTokens: 32_768},
  {match: 'llama-4-scout', contextWindowTokens: 1_048_576, maxOutputTokens: 32_768, note: 'gateway-served window; self-host is server-configured'},
  {match: 'llama-3.3', contextWindowTokens: 128_000, maxOutputTokens: 8_192},
  {match: 'llama-3.1', contextWindowTokens: 128_000, maxOutputTokens: 8_192},
  {match: 'mistral-large', contextWindowTokens: 128_000, maxOutputTokens: 32_768},
  {match: 'mistral-medium', contextWindowTokens: 128_000, maxOutputTokens: 32_768},
  {match: 'devstral', contextWindowTokens: 128_000, maxOutputTokens: 32_768},
  {match: 'codestral', contextWindowTokens: 256_000, maxOutputTokens: 32_768},
  {match: 'mistral', contextWindowTokens: 128_000, maxOutputTokens: 8_192},
];

/** Look up catalog limits for a model name (case-insensitive prefix families). Gateway-style `vendor/model` and `vendor:model` identifiers match on their final segment. */
export function catalogLimitsFor(modelName: string): CatalogModelLimits | undefined {
  const name = modelName.trim().toLowerCase();
  if (!name) return undefined;
  for (const entry of MODEL_CATALOG) {
    if (name.startsWith(entry.match) || lastSegment(name).startsWith(entry.match)) {
      return {contextWindowTokens: entry.contextWindowTokens, ...(entry.maxOutputTokens !== undefined ? {maxOutputTokens: entry.maxOutputTokens} : {})};
    }
  }
  return undefined;
}

function lastSegment(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf(':'));
  return slash === -1 ? name : name.slice(slash + 1);
}

/** Catalog entries exposed for pinning tests (like the theme registry). */
export function getModelCatalog(): readonly CatalogEntry[] {
  return MODEL_CATALOG;
}
