export function errorText(error: unknown) {
  return (error instanceof Error ? `${error.name} ${error.message}` : String(error)).toLowerCase();
}

export function isContextOverflowError(error: unknown) {
  const text = errorText(error);
  return /context length|context window|context limit|maximum context|max context|token limit|too many tokens|input too long|prompt too long|context.*exceed|tokens.*exceed/.test(text);
}

export function isRetryableModelError(error: unknown) {
  const text = errorText(error);
  if (isContextOverflowError(error) || /quota|billing|balance|auth|api key|invalid request|permission|forbidden|401|403|400/.test(text)) return false;
  return /overload|rate limit|429|500|502|503|504|network|connection|stream|timeout|timed? out|terminated|econnreset|etimedout|fetch failed/.test(text);
}
