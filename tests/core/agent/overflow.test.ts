import {describe, expect, it} from 'vitest';
import {errorIndicatesContextOverflow, getOverflowPatterns, isLengthStopOverflow, isSilentContextOverflow} from '../../../src/core/agent/overflow.js';

describe('overflow classification', () => {
  it('recognizes provider error shapes', () => {
    const cases = [
      'prompt is too long: 213462 tokens > 200000 maximum', // Anthropic
      '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}', // Anthropic 413
      'Your input exceeds the context window of this model', // OpenAI
      'Requested token count exceeds the model\'s maximum context length of 131072 tokens', // OpenAI/LiteLLM
      'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)', // Gemini
      'This model\'s maximum prompt length is 131072 but the request contains 537812 tokens', // xAI
      'Please reduce the length of the messages or completion', // Groq
      'This endpoint\'s maximum context length is 262144 tokens. However, you requested about 300000 tokens', // OpenRouter
      'Input length (265330) exceeds model\'s maximum context length (262144).', // OpenAI-compatible
      'The input (5000 tokens) is longer than the model\'s context length (4096 tokens).', // Together
      'prompt token count of 131072 exceeds the limit of 8192', // GitHub Copilot
      'the request exceeds the available context size, try increasing it', // llama.cpp
      'tokens to keep from the initial prompt is greater than the context length', // LM Studio
      'invalid params, context window exceeds limit', // MiniMax
      'Your request exceeded model token limit: 262144 (requested: 300000)', // Kimi
      'Prompt contains 5000 tokens ... too large for model with 4096 maximum context length', // Mistral
      'Prompt has 9000 tokens, but the configured context size is 8192 tokens', // DS4
      'Range of input length should be [1, 8192]', // DashScope/Qwen
      'prompt too long; exceeded max context length by 4096 tokens', // Ollama
      '400 status code (no body)', // Cerebras
      'model_context_window_exceeded', // z.ai finish reason as error text
    ];
    for (const text of cases) expect(errorIndicatesContextOverflow(text), text).toBe(true);
  });

  it('excludes rate-limit look-alikes even when they mention tokens', () => {
    expect(errorIndicatesContextOverflow('ThrottlingException: Too many tokens, please wait before trying again.')).toBe(false);
    expect(errorIndicatesContextOverflow('Rate limit hit: too many tokens per minute')).toBe(false);
    expect(errorIndicatesContextOverflow('429 Too many requests')).toBe(false);
  });

  it('does not match ordinary failures', () => {
    expect(errorIndicatesContextOverflow('Connection terminated')).toBe(false);
    expect(errorIndicatesContextOverflow('Invalid API key provided')).toBe(false);
    expect(errorIndicatesContextOverflow('Internal server error')).toBe(false);
  });

  it('pins the pattern table size (additive changes only)', () => {
    expect(getOverflowPatterns().length).toBeGreaterThanOrEqual(25);
  });

  it('detects silent overflow from usage on a successful finish', () => {
    expect(isSilentContextOverflow({inputTokens: 150_000, cacheReadTokens: 0, contextWindowTokens: 128_000})).toBe(true);
    // Exclusive-style reporting: cache read outside input sums into the window check.
    expect(isSilentContextOverflow({inputTokens: 20_000, cacheReadTokens: 120_000, contextWindowTokens: 128_000})).toBe(true);
    expect(isSilentContextOverflow({inputTokens: 90_000, cacheReadTokens: 30_000, contextWindowTokens: 128_000})).toBe(false);
    expect(isSilentContextOverflow({inputTokens: undefined, cacheReadTokens: 0, contextWindowTokens: 128_000})).toBe(false);
    // Subset-style reporting (cached tokens already inside inputTokens) must
    // not double count: a cache-heavy successful finish is not an overflow.
    expect(isSilentContextOverflow({inputTokens: 120_000, cacheReadTokens: 110_000, contextWindowTokens: 128_000})).toBe(false);
    // Unknown window (0) disables the check.
    expect(isSilentContextOverflow({inputTokens: 150_000, cacheReadTokens: 0, contextWindowTokens: 0})).toBe(false);
  });

  it('detects length-stop overflow: length finish, zero output, full window', () => {
    expect(isLengthStopOverflow({finishReason: 'length', outputTokens: 0, inputTokens: 127_900, cacheReadTokens: 100, contextWindowTokens: 128_000})).toBe(true);
    // Output present means generation had room: not a length-stop overflow.
    expect(isLengthStopOverflow({finishReason: 'length', outputTokens: 40, inputTokens: 127_900, cacheReadTokens: 100, contextWindowTokens: 128_000})).toBe(false);
    // Normal finish or an unconstrained window is not overflow either.
    expect(isLengthStopOverflow({finishReason: 'stop', outputTokens: 0, inputTokens: 127_900, cacheReadTokens: 100, contextWindowTokens: 128_000})).toBe(false);
    expect(isLengthStopOverflow({finishReason: 'length', outputTokens: 0, inputTokens: 50_000, cacheReadTokens: 0, contextWindowTokens: 128_000})).toBe(false);
  });
});
