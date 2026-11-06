export const PROCESSING_OUTPUT_CHAR_LIMIT = 200_000;
const PROCESSING_TRUNCATION_MARKER = '\n[... output truncated for processing ...]\n';

export type ReductionContentKind = 'validation' | 'log' | 'search' | 'diff' | 'json' | 'table' | 'web' | 'source-outline' | 'generic';
export type ReductionParseTier = 'full' | 'degraded' | 'passthrough';

export interface ReductionMetrics {
  rawChars: number;
  returnedChars: number;
  rawTokensEstimate: number;
  returnedTokensEstimate: number;
  estimatedSavedTokens: number;
  savingsPct: number;
}

export interface StreamReduction {
  text: string;
  truncated: boolean;
  filtered: boolean;
  reducerName?: string;
  filterName?: string;
  contentKind: ReductionContentKind;
  lossy: boolean;
  parseTier: ReductionParseTier;
  warning?: string;
  handle?: string;
  rawHandle?: string;
  omittedChars: number;
  rawChars: number;
  returnedChars: number;
  rawTokensEstimate: number;
  returnedTokensEstimate: number;
  estimatedSavedTokens: number;
  savingsPct: number;
}

function estimateReductionTokens(text: string) {
  return Math.ceil(text.length / 4);
}

export function capOutputForProcessing(text: string, maxChars = PROCESSING_OUTPUT_CHAR_LIMIT) {
  if (text.length <= maxChars) return text;
  if (maxChars <= PROCESSING_TRUNCATION_MARKER.length) return text.slice(0, maxChars);
  const keepChars = maxChars - PROCESSING_TRUNCATION_MARKER.length;
  const headChars = Math.floor(keepChars / 2);
  const tailChars = keepChars - headChars;
  return `${text.slice(0, headChars)}${PROCESSING_TRUNCATION_MARKER}${text.slice(-tailChars)}`;
}

export function reductionMetrics(raw: string, returned: string): ReductionMetrics {
  const rawTokensEstimate = estimateReductionTokens(raw);
  const returnedTokensEstimate = estimateReductionTokens(returned);
  const estimatedSavedTokens = Math.max(0, rawTokensEstimate - returnedTokensEstimate);
  const savingsPct = rawTokensEstimate === 0 ? 0 : Number(((estimatedSavedTokens / rawTokensEstimate) * 100).toFixed(1));
  return {
    rawChars: raw.length,
    returnedChars: returned.length,
    rawTokensEstimate,
    returnedTokensEstimate,
    estimatedSavedTokens,
    savingsPct,
  };
}

function retrievalHint(handle: string) {
  return `Use readToolOutput with handle ${handle} for the original output.`;
}

function isInflating(raw: string, returned: string) {
  return raw.trim().length > 0 && returned.length > raw.length;
}

/**
 * Compact output for storage, keeping head + tail and storing the full text behind a handle.
 */
export function compactOutput(text: string, maxChars: number, storeRawOutput?: (text: string) => string): {text: string; truncated: boolean; handle?: string; omittedChars?: number} {
  if (text.length <= maxChars) return {text, truncated: false};
  const handle = storeRawOutput?.(text);
  const headChars = Math.floor(maxChars * 0.4);
  const tailChars = maxChars - headChars;
  const omitted = text.length - maxChars;
  return {
    text: `${text.slice(0, headChars)}\n\n[... ${omitted} characters omitted${handle ? `; use readToolOutput with handle ${handle}` : ''} ...]\n\n${text.slice(-tailChars)}`,
    truncated: true,
    omittedChars: omitted,
    handle,
  };
}

/**
 * Create a stream reduction result for shell output.
 */
export function makeStreamReduction(
  raw: string,
  text: string,
  filtered: boolean,
  reducerName: string | undefined,
  input: {
    storeRawOutput?: (text: string) => string;
    compactMaxChars: number;
    fallbackCompact?: (text: string, maxChars: number) => {text: string; truncated: boolean; handle?: string; omittedChars?: number};
  },
  warning?: string,
  contentKind: ReductionContentKind = 'generic'
): StreamReduction {
  let finalText = text;
  let handle: string | undefined;
  let truncated = false;
  const compactFn = input.fallbackCompact ?? ((value: string, max: number) => compactOutput(value, max, input.storeRawOutput));

  if (finalText.length > input.compactMaxChars) {
    const compacted = compactFn(finalText, input.compactMaxChars);
    finalText = compacted.text;
    handle = compacted.handle;
    truncated = compacted.truncated;
  }

  const lossy = filtered && finalText !== raw;
  const rawHandle = lossy && input.storeRawOutput ? input.storeRawOutput(raw) : handle;

  if (filtered && contentKind !== 'validation' && raw.length > 2000 && isInflating(raw, finalText)) {
    return passthroughReduction(raw, input);
  }

  if (lossy && rawHandle && !finalText.includes(rawHandle)) {
    finalText = `${finalText}\n\n[${retrievalHint(rawHandle)}]`;
  }

  const metrics = reductionMetrics(raw, finalText);

  return {
    text: finalText,
    truncated,
    filtered,
    ...(reducerName ? {reducerName, filterName: reducerName} : {}),
    contentKind,
    lossy,
    parseTier: warning ? 'degraded' : filtered ? 'full' : 'passthrough',
    ...(warning ? {warning} : {}),
    ...(handle ?? rawHandle ? {handle: handle ?? rawHandle} : {}),
    ...(rawHandle ? {rawHandle} : {}),
    omittedChars: Math.max(0, raw.length - finalText.length),
    ...metrics,
  };
}

/**
 * Fallback reduction for passthrough output.
 */
export function passthroughReduction(
  raw: string,
  input: {
    storeRawOutput?: (text: string) => string;
    compactMaxChars: number;
    fallbackCompact?: (text: string, maxChars: number) => {text: string; truncated: boolean; handle?: string; omittedChars?: number};
  }
): StreamReduction {
  const compactFn = input.fallbackCompact ?? ((value: string, max: number) => compactOutput(value, max, input.storeRawOutput));
  const compacted = compactFn(raw, input.compactMaxChars);
  const metrics = reductionMetrics(raw, compacted.text);

  return {
    text: compacted.text,
    truncated: compacted.truncated,
    filtered: false,
    reducerName: 'generic-cap',
    contentKind: 'generic',
    lossy: compacted.truncated,
    parseTier: 'passthrough',
    ...(compacted.handle ? {handle: compacted.handle, rawHandle: compacted.handle} : {}),
    omittedChars: compacted.omittedChars ?? Math.max(0, raw.length - compacted.text.length),
    ...metrics,
  };
}
