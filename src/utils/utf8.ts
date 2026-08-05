export interface Utf8BufferTruncation {
  buffer: Buffer;
  bytes: number;
  truncated: boolean;
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function expectedSequenceBytes(lead: number): number {
  if (lead <= 0x7f) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 1;
}

function completePrefixEnd(input: Buffer, proposedEnd: number): number {
  if (proposedEnd === 0) return 0;
  let sequenceStart = proposedEnd - 1;
  while (sequenceStart > 0 && isContinuationByte(input[sequenceStart])) sequenceStart--;
  const expected = expectedSequenceBytes(input[sequenceStart]!);
  return proposedEnd - sequenceStart < expected ? sequenceStart : proposedEnd;
}

/** Retain at most `maxBytes` from the start without splitting a UTF-8 character. */
export function truncateUtf8BufferAtBytes(input: Buffer, maxBytes: number): Utf8BufferTruncation {
  const limit = Math.max(0, Math.floor(maxBytes));
  const end = completePrefixEnd(input, Math.min(input.byteLength, limit));
  const buffer = end === input.byteLength ? input : input.subarray(0, end);
  return {buffer, bytes: buffer.byteLength, truncated: buffer.byteLength < input.byteLength};
}

/** Retain at most `maxBytes` from the end without starting inside a UTF-8 character. */
export function truncateUtf8TailBufferAtBytes(input: Buffer, maxBytes: number): Utf8BufferTruncation {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (input.byteLength <= limit) return {buffer: input, bytes: input.byteLength, truncated: false};
  let start = input.byteLength - limit;
  while (start < input.byteLength && isContinuationByte(input[start])) start++;
  const buffer = input.subarray(start);
  return {buffer, bytes: buffer.byteLength, truncated: true};
}

/** Retain a string or Buffer prefix under a byte budget and return valid UTF-8 text. */
export function truncateUtf8AtBytes(input: string | Buffer, maxBytes: number): {text: string; bytes: number; truncated: boolean} {
  const source = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  const result = truncateUtf8BufferAtBytes(source, maxBytes);
  return {text: result.buffer.toString('utf8'), bytes: result.bytes, truncated: result.truncated};
}
