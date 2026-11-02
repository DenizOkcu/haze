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
  const parsed = parseInputObject(input);
  if (!parsed) return null;
  let schema: unknown;
  try {
    schema = await resolveSchema({toolName});
  } catch {
    return null;
  }
  const repaired = {...parsed};
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

/** Parses a tool-call input (stringified JSON or object) into a plain object; null when not a JSON object. */
function parseInputObject(input: unknown): Record<string, unknown> | null {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Normalized validation issue for a rejected tool input: which parameter, what was expected, what arrived. */
type ToolInputIssue = {path: string; expected: string | undefined; received: string | undefined};

/**
 * Extracts Zod-style validation issues from an AI SDK tool-input error's cause
 * chain (InvalidToolInputError → TypeValidationError → ZodError.issues). Zod 4
 * folds the received type into the message ("…received undefined") instead of a
 * `received` issue field, so both shapes are normalized here.
 */
function toolInputIssuesFromError(error: unknown): ToolInputIssue[] | undefined {
  let node: unknown = error;
  for (let depth = 0; depth < 5 && node != null; depth += 1) {
    if (typeof node !== 'object') return undefined;
    const record = node as {issues?: unknown; cause?: unknown};
    if (Array.isArray(record.issues)) {
      const issues: ToolInputIssue[] = [];
      for (const entry of record.issues) {
        if (entry == null || typeof entry !== 'object') continue;
        const issue = entry as {path?: unknown; expected?: unknown; received?: unknown; message?: unknown};
        const path = Array.isArray(issue.path)
          ? issue.path.filter(segment => typeof segment === 'string' || typeof segment === 'number').join('.')
          : undefined;
        if (path == null || path === '') continue;
        let received = typeof issue.received === 'string' ? issue.received : undefined;
        if (received == null && typeof issue.message === 'string') received = /received (\w+)/.exec(issue.message)?.[1];
        issues.push({path, expected: typeof issue.expected === 'string' ? issue.expected : undefined, received});
      }
      if (issues.length > 0) return issues;
    }
    node = record.cause;
  }
  return undefined;
}

type ProblemParts = {missing: string[]; mismatches: Array<{path: string; expected: string; received: string}>};

const MAX_LISTED_MISMATCHES = 3;

function quotedList(values: string[]): string {
  return values.map(value => `\`${value}\``).join(', ');
}

function describeProblemParts(parts: ProblemParts): string | undefined {
  const clauses: string[] = [];
  if (parts.missing.length > 0) {
    clauses.push(parts.missing.length === 1
      ? `the input omitted the required parameter ${quotedList(parts.missing)}`
      : `the input omitted the required parameters ${quotedList(parts.missing)}`);
  }
  if (parts.mismatches.length > 0) {
    const listed = parts.mismatches.slice(0, MAX_LISTED_MISMATCHES).map(m => `\`${m.path}\` expects ${m.expected} but received ${m.received}`);
    const extra = parts.mismatches.length > MAX_LISTED_MISMATCHES ? ` (and ${parts.mismatches.length - MAX_LISTED_MISMATCHES} more)` : '';
    clauses.push(`${listed.join('; ')}${extra}`);
  }
  return clauses.length > 0 ? clauses.join('; ') : undefined;
}

/**
 * Concise diagnosis of why a tool input failed validation, derived from the
 * error's Zod issues alone — e.g. "the input omitted the required parameter
 * `path`". Used where no tool schema resolver is available (streamed tool-error
 * parts). Undefined when the error carries no structured issues.
 */
export function toolInputProblemFromError(error: unknown): string | undefined {
  const issues = toolInputIssuesFromError(error);
  if (!issues) return undefined;
  const missing = [...new Set(issues.filter(issue => issue.received === 'undefined').map(issue => issue.path))];
  const mismatches = issues
    .filter(issue => issue.expected != null && issue.received != null && issue.received !== 'undefined' && issue.expected !== issue.received)
    .map(issue => ({path: issue.path, expected: issue.expected as string, received: issue.received as string}));
  return describeProblemParts({missing, mismatches});
}

/** Diff of an emitted tool-call input against the tool's JSON schema (fallback when the error carries no issues). */
async function schemaProblemParts(input: Record<string, unknown>, toolName: string, resolveSchema: ToolInputSchemaResolver): Promise<ProblemParts | undefined> {
  let schema: unknown;
  try {
    schema = await resolveSchema({toolName});
  } catch {
    return undefined;
  }
  const {required, properties} = (schema ?? {}) as {required?: unknown; properties?: unknown};
  const missing = Array.isArray(required)
    ? [...new Set(required.filter((key): key is string => typeof key === 'string' && input[key] === undefined))]
    : [];
  const mismatches: ProblemParts['mismatches'] = [];
  if (properties != null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [key, declared] of Object.entries(properties as Record<string, unknown>)) {
      const value = input[key];
      if (value === undefined) continue;
      const type = (declared as {type?: unknown} | null | undefined)?.type;
      const expected = type === 'integer' ? 'number' : type;
      if (expected !== 'string' && expected !== 'number' && expected !== 'boolean') continue;
      const received = typeof value;
      if (received !== expected) mismatches.push({path: key, expected, received});
    }
  }
  return missing.length > 0 || mismatches.length > 0 ? {missing, mismatches} : undefined;
}

/**
 * Diagnosis for the forced malformed-retry prompt: names the exact defect
 * (omitted required parameters, wrong value types) instead of the generic
 * "invalid or truncated" wording, which models ignored 19 times in a row while
 * dropping readFile's `path` (observed 2026-10-31 session d5fe72). Prefers the
 * error's structured Zod issues; falls back to diffing the emitted input keys
 * against the tool's JSON schema. Undefined when neither yields a diagnosis —
 * callers then keep the generic wording.
 */
export async function describeToolInputProblem(input: unknown, toolName: string, error: unknown, resolveSchema?: ToolInputSchemaResolver): Promise<string | undefined> {
  const fromError = toolInputProblemFromError(error);
  if (fromError) return fromError;
  if (!resolveSchema) return undefined;
  const parsed = parseInputObject(input);
  if (!parsed) return undefined;
  const parts = await schemaProblemParts(parsed, toolName, resolveSchema);
  return parts ? describeProblemParts(parts) : undefined;
}
