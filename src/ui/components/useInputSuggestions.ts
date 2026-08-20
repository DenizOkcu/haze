import {useEffect, useState} from 'react';
import {detectMentionAtCursor, type MentionContext} from '../../cli/chat/fileMentionSuggestions.js';
import type {MentionSuggestionsProvider, TextInputSuggestion} from './TextInput.js';

/**
 * The suggestion engine behind TextInput, extracted as a standalone hook:
 * two composable layers — slash-command filtering (sync, prefix/substring
 * match over the caller's suggestion list) and `@token` mention completion
 * (async fetch with cancellation so fast typing never races stale results) —
 * plus the shared selection state the keyboard handler moves through.
 */
export function useInputSuggestions({value, cursor, suggestions, suggestionMode, mask, getMentionSuggestions}: {
  value: string;
  cursor: number;
  suggestions: TextInputSuggestion[];
  suggestionMode: 'slash' | 'always';
  mask?: boolean;
  getMentionSuggestions?: MentionSuggestionsProvider;
}) {
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [mentionContext, setMentionContext] = useState<MentionContext | undefined>();
  const [mentionSuggestions, setMentionSuggestions] = useState<TextInputSuggestion[]>([]);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);

  const suggestionQuery = !mask && (suggestionMode === 'always' || value.startsWith('/'))
    ? (suggestionMode === 'always' ? value : value.slice(1)).toLowerCase()
    : undefined;
  const filteredSuggestions = suggestionQuery == null ? [] : suggestions
    .filter(suggestion => {
      const suggestionValue = suggestionMode === 'always' ? suggestion.value : suggestion.value.slice(1);
      return suggestionValue.toLowerCase().includes(suggestionQuery) || suggestion.description?.toLowerCase().includes(suggestionQuery);
    })
    .slice(0, 20);

  // `@token` mention detection — only in chat mode (slash) so wizard pickers
  // never grab `@`-prefixed tokens. Detection is sync; suggestion fetch is
  // async with cancellation so fast typing does not race stale results.
  const detectedMention = !mask && suggestionMode === 'slash' && !value.startsWith('/') && getMentionSuggestions
    ? detectMentionAtCursor(value, cursor)
    : undefined;
  useEffect(() => {
    setMentionContext(detectedMention);
  }, [detectedMention?.token, detectedMention?.start, detectedMention?.end]);
  useEffect(() => {
    if (!mentionContext || !getMentionSuggestions) {
      if (mentionSuggestions.length > 0) setMentionSuggestions([]);
      return;
    }
    let cancelled = false;
    Promise.resolve(getMentionSuggestions(mentionContext.token))
      .then(results => { if (!cancelled) { setMentionSuggestions(results); setMentionSelectedIndex(0); } })
      .catch(() => { if (!cancelled) setMentionSuggestions([]); });
    return () => { cancelled = true; };
  }, [mentionContext?.token, mentionContext?.start, mentionContext?.end]);

  const inMentionMode = !!detectedMention;
  const mentionList = inMentionMode ? mentionSuggestions : [];
  const activeMentionIndex = Math.min(mentionSelectedIndex, Math.max(0, mentionList.length - 1));
  const activeSuggestionIndex = Math.min(selectedSuggestionIndex, Math.max(0, filteredSuggestions.length - 1));
  const activeSuggestion = inMentionMode ? mentionList[activeMentionIndex] : filteredSuggestions[activeSuggestionIndex];

  /** Reset both selection layers (called whenever the input value is replaced). */
  function resetSelection() {
    setSelectedSuggestionIndex(0);
    setMentionSelectedIndex(0);
  }

  /**
   * Move the active selection for vertical arrows. Returns true when a
   * suggestion layer consumed the key (mention mode always consumes; the
   * slash list consumes while another entry remains in that direction),
   * false when the caller should fall through to cursor/history handling.
   */
  function moveSelection(direction: -1 | 1): boolean {
    if (inMentionMode) {
      if (mentionList.length > 0) {
        if (direction < 0) setMentionSelectedIndex(current => Math.max(0, current - 1));
        else setMentionSelectedIndex(current => Math.min(mentionList.length - 1, current + 1));
      }
      return true;
    }
    if (filteredSuggestions.length > 0) {
      if (direction < 0 && activeSuggestionIndex > 0) {
        setSelectedSuggestionIndex(current => Math.max(0, current - 1));
        return true;
      }
      if (direction > 0 && activeSuggestionIndex < filteredSuggestions.length - 1) {
        setSelectedSuggestionIndex(current => Math.min(filteredSuggestions.length - 1, current + 1));
        return true;
      }
    }
    return false;
  }

  return {
    detectedMention,
    inMentionMode,
    filteredSuggestions,
    mentionList,
    activeMentionIndex,
    activeSuggestionIndex,
    activeSuggestion,
    resetSelection,
    moveSelection,
  };
}
