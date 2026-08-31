/**
 * Provider context-overflow classification (Pillar 1.2 of the Pi learning
 * roadmap). Three overflow modes exist and each routes to different recovery:
 *
 * 1. **Error overflow**: the provider rejects an oversized request with a
 *    provider-specific error message (`errorIndicatesContextOverflow`).
 * 2. **Silent overflow**: some gateways (z.ai-style) accept the oversized
 *    request and answer normally; only the reported usage exceeds the window
 *    (`isSilentContextOverflow`).
 * 3. **Length-stop overflow**: some local servers truncate the input to fill
 *    the window, leaving no room for output — a `length` finish with ~zero
 *    output and input filling the window (`isLengthStopOverflow`).
 *
 * Pattern families are battle-tested against the providers listed per regex;
 * keep this file a pure data table so tests can pin it (like the theme
 * registry). Additive changes only.
 */

import {inputLikeTokens} from './contextBudget.js';

/** Provider error shapes that indicate the request exceeded the context window. */
const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i, // Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
  /request_too_large/i, // Anthropic HTTP 413 request_too_large
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses)
  /exceeds (?:the )?(?:model'?s )?maximum context length/i, // OpenAI/LiteLLM
  /input token count.*exceeds the maximum/i, // Google Gemini
  /maximum prompt length is \d+/i, // xAI Grok
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is/i, // DS4
  /model_context_window_exceeded/i, // z.ai finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow
  /range of input length should be/i, // DashScope / Qwen
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i, // Cerebras: 400/413 with no body
];

/**
 * Error shapes that look like overflow but are not (rate limiting and other
 * transient throttles). Checked before the overflow patterns so a throttling
 * message containing "too many tokens" cannot trigger compaction.
 */
const NON_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /^(?:throttling|service unavailable)/i, // AWS Bedrock throttling/unavailable prefixes (raw ThrottlingException and formatted variants)
  /rate limit/i,
  /too many requests/i,
];

/** Does an error text indicate a provider context-window overflow? */
export function errorIndicatesContextOverflow(text: string): boolean {
  if (NON_OVERFLOW_PATTERNS.some(pattern => pattern.test(text))) return false;
  return OVERFLOW_PATTERNS.some(pattern => pattern.test(text));
}

export interface OverflowUsageInput {
  inputTokens: number | undefined;
  cacheReadTokens: number;
  contextWindowTokens: number;
}

/**
 * Silent overflow: the request succeeded but the reported input already
 * exceeded the model's context window (some gateways accept and stream an
 * answer anyway; the next request will fail or be truncated). The input-like
 * term is convention-robust (see `inputLikeTokens`): subset-style cached
 * tokens inside `inputTokens` are never double counted, so a cache-heavy
 * successful finish cannot false-positive.
 */
export function isSilentContextOverflow(input: OverflowUsageInput): boolean {
  if (input.contextWindowTokens <= 0) return false;
  return inputLikeTokens(input) > input.contextWindowTokens;
}

export interface LengthStopOverflowInput extends OverflowUsageInput {
  finishReason: string | undefined;
  outputTokens: number | undefined;
}

/**
 * Length-stop overflow: the server truncated the oversized input to fit the
 * window, leaving no room to generate — a `length` finish with zero output and
 * input filling (≥99% of) the window.
 */
export function isLengthStopOverflow(input: LengthStopOverflowInput): boolean {
  if (input.finishReason !== 'length' || (input.outputTokens ?? 0) > 0) return false;
  if (input.contextWindowTokens <= 0) return false;
  return inputLikeTokens(input) >= input.contextWindowTokens * 0.99;
}

/** Overflow patterns exposed for pinning tests. */
export function getOverflowPatterns(): readonly RegExp[] {
  return OVERFLOW_PATTERNS;
}
