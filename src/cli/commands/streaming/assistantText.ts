/**
 * Pure heuristics for gating and normalizing streamed assistant text.
 *
 * These decide when an assistant segment is "substantive" enough to show,
 * whether a fragment is an unfinished markdown/bridge prefix that should stay
 * hidden, and how to strip synthetic tool-call markup. None of them touch
 * agent/callback state, which keeps them trivially unit-testable.
 */

export function sanitizeAssistantText(text: string) {
  return [...text].filter(char => {
    const code = char.charCodeAt(0);
    return !(code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127 || code === 155);
  }).join('');
}

function hideSyntheticToolCallMarkup(text: string) {
  return text
    .replace(/(^|\n)\s*(?:```(?:xml)?\s*)?(?:xml\s*)?<tool_call>[\s\S]*?<\/tool_call>\s*(?:```)?/gi, '$1')
    .replace(/(^|\n)\s*(?:```(?:xml)?\s*)?(?:xml\s*)?<tool_call>[\s\S]*$/i, '$1');
}

function isWordChar(char: string) {
  return char.toLowerCase() !== char.toUpperCase() || (char >= '0' && char <= '9');
}

function wordCount(text: string) {
  let count = 0;
  let inWord = false;
  for (const char of text) {
    if (isWordChar(char)) {
      if (!inWord) count += 1;
      inWord = true;
    } else {
      inWord = false;
    }
  }
  return count;
}

function endsWithSentenceBoundary(text: string) {
  const trimmed = text.trim();
  if (!trimmed || wordCount(trimmed) === 0) return false;
  const last = trimmed.at(-1) ?? '';
  return last === '.' || last === '!' || last === '?' || last === ':' || last === ';' || last === ')';
}

function isNonSubstantiveAssistantText(text: string) {
  return wordCount(text) === 0;
}

export function isSubstantiveAssistantText(text: string) {
  const trimmed = text.trim();
  const words = wordCount(trimmed);
  if (words === 0) return false;
  if (trimmed.length >= 24) return true;
  if (endsWithSentenceBoundary(trimmed)) return true;
  return words >= 4;
}

function isIncompleteAssistantFragment(text: string) {
  const trimmed = text.trim();
  return !isSubstantiveAssistantText(trimmed) && wordCount(trimmed) <= 2 && !endsWithSentenceBoundary(trimmed);
}

function isLikelyUnfinishedMarkdownFragment(text: string) {
  const trimmed = text.trim();
  if (!trimmed.includes('\n')) return false;
  const last = trimmed.at(-1) ?? '';
  return last === '-' || last === '*' || last === '#' || last === '`' || last === '>';
}

// Procedural pre-tool lead-ins (e.g. "Confirmed:", "Files written.", "Now let me",
// "I checked the tests.") are short preambles the model emits before calling a tool; they
// should stay hidden so they don't surface as standalone bubbles. The ceiling is kept well
// below the length of genuine multi-segment answer content: a substantive sentence of ~12
// words preceding a tool call is real answer text and must be preserved (see the
// multi-segment headless integration test). Empirically procedural lead-ins are <=5 words,
// so 6 catches them while leaving real content visible.
const LEAD_IN_WORD_CEILING = 6;
export function isShortLeadInBeforeTool(text: string) {
  const trimmed = text.trim();
  return trimmed.length > 0 && wordCount(trimmed) <= LEAD_IN_WORD_CEILING && !isLikelyUnfinishedMarkdownFragment(trimmed);
}

export function isShortUnfinishedLeadIn(text: string) {
  const trimmed = text.trim();
  const words = wordCount(trimmed);
  return words >= 3
    && words <= 4
    && !isSubstantiveAssistantText(trimmed)
    && !endsWithSentenceBoundary(trimmed)
    && !isLikelyUnfinishedMarkdownFragment(trimmed);
}

function isHiddenAssistantText(text: string) {
  return text.length === 0 || isNonSubstantiveAssistantText(text);
}

export function isHiddenAssistantFragment(text: string) {
  return isHiddenAssistantText(text) || isIncompleteAssistantFragment(text) || isLikelyUnfinishedMarkdownFragment(text);
}

export function isHiddenUnstartedFinalText(text: string) {
  return isHiddenAssistantText(text) || isLikelyUnfinishedMarkdownFragment(text);
}

const ASSISTANT_STREAM_DEBOUNCE_MS = 200;

export function shouldStartAssistantStream(text: string, startedAt: number) {
  if (isHiddenAssistantFragment(text)) return false;
  return isSubstantiveAssistantText(text) || Date.now() - startedAt >= ASSISTANT_STREAM_DEBOUNCE_MS;
}

export function assistantDisplayText(text: string) {
  return hideSyntheticToolCallMarkup(text).trim();
}

export function normalizeAssistantText(text: string) {
  return assistantDisplayText(text)
    .replace(/[`*_~#>\-–—:;,.!?()[\]{}"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
