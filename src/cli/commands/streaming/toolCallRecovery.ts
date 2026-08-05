function errorFragments(error: unknown, depth = 0): string[] {
  if (depth > 4 || error == null) return [];
  if (typeof error === 'string') return [error];
  if (error instanceof Error) {
    const cause = 'cause' in error ? error.cause : undefined;
    return [error.name, error.message, ...errorFragments(cause, depth + 1)];
  }
  if (typeof error !== 'object') return [String(error)];
  const record = error as Record<string, unknown>;
  return [
    ...errorFragments(record.name, depth + 1),
    ...errorFragments(record.message, depth + 1),
    ...errorFragments(record.cause, depth + 1),
    ...errorFragments(record.error, depth + 1),
  ];
}

/** Identifies tool-input failures that are safe to send back to the model for a smaller retry. */
export function isMalformedToolInputError(error: unknown): boolean {
  const text = errorFragments(error).join(' ');
  return /AI_(?:JSONParse|InvalidToolInput)Error|JSON parsing failed|Invalid input for tool|invalid tool input/i.test(text);
}
