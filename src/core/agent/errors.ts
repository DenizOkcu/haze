export function errorText(error: unknown) {
  return (error instanceof Error ? `${error.name} ${error.message}` : String(error)).toLowerCase();
}

export function isContextOverflowError(error: unknown) {
  const text = errorText(error);
  return /context length|context window|context limit|maximum context|max context|token limit|too many tokens|input too long|prompt too long|context.*exceed|tokens.*exceed/.test(text);
}

export function isRetryableModelError(error: unknown) {
  const text = errorText(error);
  if (isContextOverflowError(error)) return false;
  // Status codes are matched as whole words so "15000 tokens" or "processed
  // 5000 files" are not misclassified (CR-020).
  if (/\b(?:400|401|403)\b/.test(text) || /quota|billing|balance|auth|api key|invalid request|permission|forbidden/.test(text)) return false;
  return /\b(?:429|500|502|503|504)\b/.test(text) || /overload|rate limit|network|connection|timeout|timed? out|terminated|econnreset|etimedout|fetch failed|stream disconnected|stream closed|stream aborted|stream error/.test(text);
}
