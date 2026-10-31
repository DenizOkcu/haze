/**
 * Terminal control-sequence sanitizer for Ink sinks (HZA-3).
 *
 * Untrusted text (file content in edit-diff previews, model/repo-derived
 * strings in tool summary rows) reaches the terminal through `<Text>` rows,
 * and Ink passes embedded C0/CSI/OSC bytes through to stdout. A repo file
 * containing OSC 52 (`ESC]52;c;<base64> BEL/ST`) can otherwise write the
 * user's clipboard; OSC 8 can spoof hyperlinks; CSI can clear/hijack the
 * screen. Sinks that render untrusted strings call this before display.
 *
 * Both the 7-bit (ESC-prefixed) and 8-bit C1 (single-character U+0080–U+009F)
 * spellings are covered: terminals in C1-interpretation mode (kitty, some
 * VTE/WezTerm configurations) execute `\u009B` as CSI and `\u009D` as OSC
 * without any ESC byte.
 */

const ESC = 0x1b;
const BEL = 0x07;
/** 8-bit C1 controls (single-character sequence introducers and friends). */
const C1_CSI = 0x9b;
const C1_DCS = 0x90;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_SOS = 0x9f;
/** 8-bit String Terminator; also terminates C1-started string sequences. */
const C1_ST = 0x9c;

/**
 * Remove terminal control sequences from text: CSI (`ESC[`/`\u009B` … final
 * `@`-`~`), OSC/DCS/APC/PM/SOS string sequences (`ESC]`/`ESC P`/`ESC^`/`ESC_`
 * and their C1 spellings, terminated by BEL, ST (`ESC \` or `\u009C`)), other
 * escape sequences (charset designators, two-byte escapes), and remaining
 * C0/C1 control bytes except `\n` and `\t`. Plain text is unchanged.
 */
export function stripTerminalControlSequences(text: string): string {
  let out = '';
  let index = 0;
  const length = text.length;
  while (index < length) {
    const code = text.charCodeAt(index);
    if (code === ESC) {
      index += consumeEscape(text, index);
      continue;
    }
    if (code === C1_CSI) {
      index += 1 + consumeCsi(text, index + 1);
      continue;
    }
    if (code === C1_DCS || code === C1_OSC || code === C1_PM || code === C1_SOS) {
      index += 1 + consumeStringSequence(text, index + 1);
      continue;
    }
    if ((code >= 0x80 && code <= 0x9f) || (code < 0x20 && code !== 0x09 && code !== 0x0a)) {
      index += 1;
      continue;
    }
    out += text[index];
    index += 1;
  }
  return out;
}

/** How many chars to drop for one escape sequence starting at `index`. */
function consumeEscape(text: string, index: number): number {
  const length = text.length;
  const next = index + 1 < length ? text.charCodeAt(index + 1) : undefined;
  if (next === undefined) return 1; // trailing lone ESC: drop it
  if (next === 0x5b) return 2 + consumeCsi(text, index + 2); // ESC [ → CSI
  if (next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f) {
    // ESC ]/P/^/_ → OSC/DCS/PM/APC string sequence.
    return 2 + consumeStringSequence(text, index + 2);
  }
  if (next >= 0x20 && next <= 0x2f) {
    // Escape sequences with intermediates (e.g. ESC ( B): consume to the final byte.
    let cursor = index + 2;
    while (cursor < length) {
      const code = text.charCodeAt(cursor);
      cursor += 1;
      if (code < 0x20 || code > 0x2f) break;
    }
    return cursor - index;
  }
  return 2; // any other escape (ESC 7, ESC M, ...): drop the pair
}

/**
 * Consume a CSI body (parameter/intermediate bytes 0x20-0x3F) starting after
 * the introducer, up to and including the final byte 0x40-0x7E. Stops without
 * consuming on a malformed byte so a stray introducer cannot eat plain text.
 */
function consumeCsi(text: string, from: number): number {
  const length = text.length;
  let cursor = from;
  while (cursor < length) {
    const code = text.charCodeAt(cursor);
    cursor += 1;
    if (code >= 0x40 && code <= 0x7e) break;
    if (code < 0x20 || code > 0x3f) break; // malformed: stop consuming
  }
  return cursor - from;
}

/**
 * Consume an OSC/DCS/PM/SOS body starting after the introducer, up to and
 * including its terminator: BEL, ST (`ESC \` or the 8-bit `\u009C`). An
 * unterminated sequence consumes the rest of the text.
 */
function consumeStringSequence(text: string, from: number): number {
  const length = text.length;
  let cursor = from;
  while (cursor < length) {
    const code = text.charCodeAt(cursor);
    if (code === BEL) return cursor + 1 - from;
    if (code === C1_ST) return cursor + 1 - from;
    if (code === ESC && cursor + 1 < length && text.charCodeAt(cursor + 1) === 0x5c) return cursor + 2 - from;
    cursor += 1;
  }
  return cursor - from;
}
