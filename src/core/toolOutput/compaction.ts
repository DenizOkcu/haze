import {storeToolOutput} from '../agent/toolOutputStore.js';

/** Default ceiling for capped tool outputs (bash, fetch). */
export const COMPACT_COMMAND_CHARS = 12_000;

/**
 * Reduction-metadata field names shared between producers (bash/fetch reducers,
 * {@link compactStoredOutput}) and the history-compaction consumer
 * ({@link compactJsonValue}). This list is the contract that ties them together:
 * when a producer starts emitting a new metadata field, add it here once and every
 * compacted history entry picks it up — instead of re-declaring the field set in
 * every site that summarises a tool result.
 */
export const REDUCTION_METADATA_KEYS = [
  'handle',
  'rawHandle',
  'filterName',
  'reducerName',
  'contentKind',
  'lossy',
  'truncated',
  'omittedChars',
  'rawTokensEstimate',
  'returnedTokensEstimate',
  'estimatedSavedTokens',
  'savingsPct',
] as const;

const REDUCTION_METADATA_TYPES: Record<(typeof REDUCTION_METADATA_KEYS)[number], 'string' | 'boolean' | 'number'> = {
  handle: 'string',
  rawHandle: 'string',
  filterName: 'string',
  reducerName: 'string',
  contentKind: 'string',
  lossy: 'boolean',
  truncated: 'boolean',
  omittedChars: 'number',
  rawTokensEstimate: 'number',
  returnedTokensEstimate: 'number',
  estimatedSavedTokens: 'number',
  savingsPct: 'number',
};

/**
 * Select the known reduction-metadata fields (with type guards) from a stream
 * details object. Used by {@link compactJsonValue} to summarise `stdout`/`stderr`
 * blocks without copying raw content.
 */
export function pickReductionMetadata(details: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of REDUCTION_METADATA_KEYS) {
    const value = details[key];
    const expected = REDUCTION_METADATA_TYPES[key];
    if (expected === 'string' && typeof value === 'string') picked[key] = value;
    else if (expected === 'boolean' && typeof value === 'boolean') picked[key] = value;
    else if (expected === 'number' && typeof value === 'number') picked[key] = value;
  }
  return picked;
}

/**
 * Cap a string to `maxChars` characters, keeping a head + tail and storing the
 * full text behind a `readToolOutput` handle so nothing is lost.
 */
export function compactStoredOutput(text: string, maxChars = COMPACT_COMMAND_CHARS) {
  if (text.length <= maxChars) return {text, truncated: false};
  const handle = storeToolOutput(text);
  const headChars = Math.floor(maxChars * 0.4);
  const tailChars = maxChars - headChars;
  return {
    text: `${text.slice(0, headChars)}\n\n[... ${text.length - maxChars} characters omitted; use readToolOutput with handle ${handle} ...]\n\n${text.slice(-tailChars)}`,
    truncated: true,
    omittedChars: text.length - maxChars,
    handle,
  };
}

/**
 * Top-level result fields worth keeping when summarising a successful tool result
 * for history compaction. Composed of the base status fields plus the shared
 * reduction-metadata contract (see {@link REDUCTION_METADATA_KEYS}).
 */
const COMPACTED_RESULT_KEYS = [
  'ok', 'path', 'command', 'code', 'signal', 'timedOut', 'durationMs', 'reasonCode',
  'bytes', 'created', 'replacements', 'totalMatches', 'returnedMatches',
  'omittedMatches', 'truncated', 'nextOffset', 'totalLines', 'startLine', 'endLine',
  'validationSummary', 'classification', 'summary', 'counts',
  ...REDUCTION_METADATA_KEYS,
  'rawChars', 'returnedChars',
] as const;

/**
 * Compact a tool-result JSON value into a metadata-only summary, dropping raw
 * content while preserving status fields and reduction metadata (including the
 * `stdout`/`stderr` stream summaries built via {@link pickReductionMetadata}).
 */
export function compactJsonValue(value: unknown, toolName: string) {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return {compacted: true, toolName, summary: 'Older successful tool result omitted.'};
  }
  const source = value as Record<string, unknown>;
  const compacted: Record<string, unknown> = {compacted: true, toolName};
  for (const key of COMPACTED_RESULT_KEYS) if (key in source) compacted[key] = source[key];
  for (const stream of ['stdout', 'stderr']) {
    const candidate = source[stream];
    if (typeof candidate !== 'object' || candidate == null) continue;
    compacted[stream] = pickReductionMetadata(candidate as Record<string, unknown>);
  }
  return compacted;
}

/**
 * Compact a tool-result `output` envelope for history compaction. JSON outputs are
 * reduced to metadata via {@link compactJsonValue}; text outputs are replaced with
 * an omission marker; everything else is returned unchanged.
 */
export function compactResultOutput(output: unknown, toolName: string) {
  if (typeof output !== 'object' || output == null || !('type' in output)) return output;
  const typed = output as {type?: unknown; value?: unknown};
  if (typed.type === 'json') return {...typed, value: compactJsonValue(typed.value, toolName)};
  if (typed.type === 'text') return {...typed, value: `[Older successful ${toolName} result omitted from active context.]`};
  return output;
}