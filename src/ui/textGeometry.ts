import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
export function graphemes(text: string) {
  return Array.from(segmenter.segment(text), ({segment, index}) => ({text: segment, start: index, end: index + segment.length}));
}
export function previousBoundary(text: string, cursor: number): number {
  return graphemes(text).reverse().find(part => part.start < cursor)?.start ?? 0;
}
export function nextBoundary(text: string, cursor: number): number {
  return graphemes(text).find(part => part.end > cursor)?.end ?? text.length;
}
/** UTF-16 offsets stay distinct from terminal-cell columns. */
export function offsetAtColumn(text: string, column: number): number {
  let cells = 0;
  for (const part of graphemes(text)) {
    const next = cells + stringWidth(part.text);
    if (next > column) return part.start;
    cells = next;
  }
  return text.length;
}
export function clipCells(text: string, width: number): string {
  return text.slice(0, offsetAtColumn(text, Math.max(0, width)));
}
/** Display-only replacement keeps offsets stable and cannot execute pasted controls. */
export function safeInputDisplay(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '�');
}
export {stringWidth as cellWidth};
