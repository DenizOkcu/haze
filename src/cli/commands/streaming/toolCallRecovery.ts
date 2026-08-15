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

/** Resolves a tool's public JSON Schema, as provided by the AI SDK repair hook. */
export type ToolInputSchemaResolver = (options: {toolName: string}) => PromiseLike<unknown>;

function numericBoundsFor(schema: unknown, key: string): {maximum?: number; minimum?: number} {
  const properties = (schema as {properties?: Record<string, unknown>} | null | undefined)?.properties;
  const property = properties?.[key];
  if (property == null) return {};
  const {maximum, minimum} = property as {maximum?: unknown; minimum?: unknown};
  return {
    maximum: typeof maximum === 'number' ? maximum : undefined,
    minimum: typeof minimum === 'number' ? minimum : undefined,
  };
}

/**
 * Clamps top-level numeric arguments that exceed a tool schema's declared
 * inclusive bounds (for example grep's maxMatches: 9999 against maximum: 200).
 * Small local models frequently invent out-of-range values; clamping keeps the
 * call executable without a model round-trip. Returns the repaired input
 * object, or null when the input is not a JSON object or nothing is out of
 * range. Exclusive bounds, nested objects, and non-numeric fields are left
 * untouched so genuinely malformed input still takes the forced-retry path.
 */
export async function clampOutOfBoundsToolNumbers(input: unknown, toolName: string, resolveSchema: ToolInputSchemaResolver): Promise<Record<string, unknown> | null> {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  let schema: unknown;
  try {
    schema = await resolveSchema({toolName});
  } catch {
    return null;
  }
  const repaired = {...(value as Record<string, unknown>)};
  let changed = false;
  for (const [key, entry] of Object.entries(repaired)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) continue;
    const {maximum, minimum} = numericBoundsFor(schema, key);
    if (maximum !== undefined && entry > maximum) {
      repaired[key] = maximum;
      changed = true;
    } else if (minimum !== undefined && entry < minimum) {
      repaired[key] = minimum;
      changed = true;
    }
  }
  return changed ? repaired : null;
}

/** Identifies tool-input failures that are safe to send back to the model for a smaller retry. */
export function isMalformedToolInputError(error: unknown): boolean {
  const text = errorFragments(error).join(' ');
  return /AI_(?:JSONParse|InvalidToolInput)Error|JSON parsing failed|Invalid input for tool|invalid tool input/i.test(text);
}
