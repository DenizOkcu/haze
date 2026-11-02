import {describe, expect, it} from 'vitest';
import {InvalidToolInputError, TypeValidationError} from 'ai';
import {z} from 'zod';
import {clampOutOfBoundsToolNumbers, describeToolInputProblem, isMalformedToolInputError, toolInputProblemFromError} from '../../src/cli/commands/streaming/toolCallRecovery.js';

describe('isMalformedToolInputError', () => {
  it('recognizes AI SDK JSON and invalid-input wrappers through causes', () => {
    const error = new Error('Invalid input for tool writeFile');
    error.name = 'AI_InvalidToolInputError';
    error.cause = new Error('AI_JSONParseError: JSON parsing failed');
    expect(isMalformedToolInputError(error)).toBe(true);
  });

  it('matches a real InvalidToolInputError instance from the AI SDK', () => {
    // Smoke test: if the SDK ever renames the error class or its message
    // format, this construct will still produce the canonical shape and the
    // regex below must match it. A silent rename otherwise breaks recovery.
    const error = new InvalidToolInputError({toolCallId: 'x', toolName: 'writeFile', input: 'bogus', cause: new SyntaxError('Unexpected token')});
    expect(isMalformedToolInputError(error)).toBe(true);
  });

  it('ignores execution failures with otherwise valid tool input', () => {
    expect(isMalformedToolInputError(new Error('Command exited with code 1'))).toBe(false);
  });
});

describe('clampOutOfBoundsToolNumbers', () => {
  const grepSchema = async () => ({
    type: 'object',
    properties: {
      pattern: {type: 'string', minLength: 1},
      contextLines: {type: 'integer', minimum: 0, maximum: 5},
      maxMatches: {type: 'integer', exclusiveMinimum: 0, maximum: 200},
    },
  });

  it('clamps numbers above the schema maximum', async () => {
    const repaired = await clampOutOfBoundsToolNumbers({pattern: '.', maxMatches: 9999, contextLines: 2}, 'grep', grepSchema);
    expect(repaired).toEqual({pattern: '.', maxMatches: 200, contextLines: 2});
  });

  it('clamps numbers below the schema minimum', async () => {
    const repaired = await clampOutOfBoundsToolNumbers({pattern: '.', contextLines: -3}, 'grep', grepSchema);
    expect(repaired).toEqual({pattern: '.', contextLines: 0});
  });

  it('parses stringified tool input before clamping', async () => {
    const repaired = await clampOutOfBoundsToolNumbers(JSON.stringify({pattern: '.', maxMatches: 5000}), 'grep', grepSchema);
    expect(repaired).toEqual({pattern: '.', maxMatches: 200});
  });

  it('returns null when nothing is out of range', async () => {
    expect(await clampOutOfBoundsToolNumbers({pattern: '.', maxMatches: 50}, 'grep', grepSchema)).toBeNull();
  });

  it('returns null for non-object or unparseable input', async () => {
    expect(await clampOutOfBoundsToolNumbers(undefined, 'grep', grepSchema)).toBeNull();
    expect(await clampOutOfBoundsToolNumbers('not json', 'grep', grepSchema)).toBeNull();
    expect(await clampOutOfBoundsToolNumbers(['x'], 'grep', grepSchema)).toBeNull();
    expect(await clampOutOfBoundsToolNumbers(null, 'grep', grepSchema)).toBeNull();
  });

  it('returns null when the schema resolver fails', async () => {
    expect(await clampOutOfBoundsToolNumbers({pattern: '.', maxMatches: 9999}, 'grep', async () => {
      throw new Error('unknown tool');
    })).toBeNull();
  });

  it('ignores exclusive bounds and non-numeric values', async () => {
    // exclusiveMinimum must not clamp: the clamped value could still be invalid.
    expect(await clampOutOfBoundsToolNumbers({pattern: '.', maxMatches: -5}, 'grep', grepSchema)).toBeNull();
    const withExclusiveMax = async () => ({type: 'object', properties: {maxMatches: {type: 'integer', exclusiveMaximum: 200}}});
    expect(await clampOutOfBoundsToolNumbers({maxMatches: 9999}, 'grep', withExclusiveMax)).toBeNull();
  });
});

/** Builds the real AI SDK error shape: InvalidToolInputError → TypeValidationError → ZodError(.issues). */
function invalidToolInputError(toolName: string, input: unknown, schema: z.ZodType, emitted: unknown): InvalidToolInputError {
  const zodError = schema.safeParse(emitted).error;
  if (!zodError) throw new Error('test fixture expected the emitted input to fail validation');
  return new InvalidToolInputError({
    toolCallId: 'call-1',
    toolName,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    cause: new TypeValidationError({value: emitted, cause: zodError}),
  });
}

const readFileSchema = z.object({path: z.string(), limit: z.number().optional(), mode: z.enum(['exact', 'fuzzy']).optional(), allowIgnored: z.boolean().optional()});

describe('toolInputProblemFromError', () => {
  it('names an omitted required parameter from the Zod issues (session d5fe72 shape)', () => {
    const error = invalidToolInputError('readFile', {limit: 20, mode: 'exact'}, readFileSchema, {limit: 20, mode: 'exact'});
    expect(toolInputProblemFromError(error)).toBe('the input omitted the required parameter `path`');
  });

  it('names wrong-typed parameters alongside omissions', () => {
    const error = invalidToolInputError('readFile', {limit: '20', mode: 'exact'}, readFileSchema, {limit: '20', mode: 'exact'});
    expect(toolInputProblemFromError(error)).toBe('the input omitted the required parameter `path`; `limit` expects number but received string');
  });

  it('lists multiple omissions', () => {
    const schema = z.object({path: z.string(), pattern: z.string()});
    const error = invalidToolInputError('grep', {}, schema, {});
    expect(toolInputProblemFromError(error)).toBe('the input omitted the required parameters `path`, `pattern`');
  });

  it('stays generic when the error carries no structured issues', () => {
    const error = new Error('AI_JSONParseError: JSON parsing failed');
    expect(toolInputProblemFromError(error)).toBeUndefined();
  });
});

describe('describeToolInputProblem', () => {
  const schemaWithRequiredPath = async () => ({type: 'object', properties: {path: {type: 'string'}, limit: {type: 'number'}}, required: ['path']});

  it('falls back to diffing the emitted input against the tool schema', async () => {
    const error = new Error('AI_InvalidToolInputError: Invalid input for tool readFile');
    const problem = await describeToolInputProblem({limit: 20, mode: 'exact'}, 'readFile', error, schemaWithRequiredPath);
    expect(problem).toBe('the input omitted the required parameter `path`');
  });

  it('parses stringified input before diffing and reports type mismatches', async () => {
    const error = new Error('AI_InvalidToolInputError: Invalid input for tool readFile');
    const problem = await describeToolInputProblem(JSON.stringify({limit: '20'}), 'readFile', error, schemaWithRequiredPath);
    expect(problem).toBe('the input omitted the required parameter `path`; `limit` expects number but received string');
  });

  it('prefers the error issues over the schema diff', async () => {
    const error = invalidToolInputError('readFile', {limit: 20}, readFileSchema, {limit: 20});
    const problem = await describeToolInputProblem({limit: 20}, 'readFile', error, schemaWithRequiredPath);
    expect(problem).toBe('the input omitted the required parameter `path`');
  });

  it('returns undefined when neither strategy yields a diagnosis', async () => {
    const error = new Error('AI_InvalidToolInputError: Invalid input for tool readFile');
    expect(await describeToolInputProblem(undefined, 'readFile', error)).toBeUndefined();
    expect(await describeToolInputProblem('not json', 'readFile', error, schemaWithRequiredPath)).toBeUndefined();
    expect(await describeToolInputProblem({path: 'a.ts'}, 'readFile', error, async () => {
      throw new Error('unknown tool');
    })).toBeUndefined();
    expect(await describeToolInputProblem({path: 'a.ts', limit: 3}, 'readFile', error, schemaWithRequiredPath)).toBeUndefined();
  });
});
