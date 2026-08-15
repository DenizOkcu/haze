import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {ModelMessage} from 'ai';
import {IMAGE_ATTACHMENT_BYTES, IMAGE_ATTACHMENTS_PER_MESSAGE} from '../limits/byteBudgets.js';
import {workspaceRoot} from '../../utils/path.js';
import {formatBytes} from '../../utils/format.js';

/**
 * User-attached images for one prompt (F03).
 *
 * Attachments are resolved from `@path` mentions typed by the user in the
 * interactive chat: host-path allowed (workspace-relative, absolute, or `~/`),
 * real-path deduped, extension-allowlisted, byte-bounded. The module is UI-
 * and provider-agnostic (constitution VI): the capability gate takes the
 * provider shape explicitly, never settings I/O.
 */

/** Extension allowlist → media type. Only these image kinds can be attached. */
export const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const IMAGE_EXTENSIONS = Object.keys(IMAGE_MEDIA_TYPES);

export interface ImageAttachment {
  /** Display path: workspace-relative inside the project, `~/…` under the home directory, absolute otherwise. */
  displayPath: string;
  absolutePath: string;
  fileName: string;
  mediaType: string;
  bytes: number;
  data: Uint8Array;
}

export interface ResolvedImageAttachments {
  /** Prompt text with attached mentions removed. */
  text: string;
  attachments: ImageAttachment[];
}

/** ASCII path-token characters accepted by the chat mention syntax. */
function isPathTokenCharacter(character: string | undefined): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || character === '_'
    || character === '.'
    || character === '/'
    || character === '~'
    || character === '-';
}

function isWordCharacter(character: string | undefined): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || character === '_';
}

/** Scan one path token, retaining backslash escapes verbatim. */
function pathTokenEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (isPathTokenCharacter(text[index])) {
      index++;
      continue;
    }
    if (text[index] === '\\' && index + 1 < text.length && text[index + 1] !== '\n' && text[index + 1] !== '\r') {
      index += 2;
      continue;
    }
    break;
  }
  return index;
}

/** Linear-time scanner for explicit `@path` mentions. */
function explicitPathMentions(text: string): ScannedPathMention[] {
  const mentions: ScannedPathMention[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '@' || isWordCharacter(text[index - 1]) || text[index - 1] === '@') continue;
    const end = pathTokenEnd(text, index + 1);
    const token = text.slice(index + 1, end);
    if (token && (token.includes('.') || token.includes('/'))) mentions.push({mention: text.slice(index, end), token, start: index, end});
    index = Math.max(index, end - 1);
  }
  return mentions;
}

/** Linear-time scanner for bare path tokens containing `/`. */
function barePathMentions(text: string): ScannedPathMention[] {
  const mentions: ScannedPathMention[] = [];
  for (let index = 0; index < text.length; index++) {
    const previous = text[index - 1];
    if (!isPathTokenCharacter(text[index]) || isWordCharacter(previous) || previous === '.' || previous === '@' || previous === '/') continue;
    const end = pathTokenEnd(text, index);
    const token = text.slice(index, end);
    const next = text[end];
    if (token.includes('/') && !isWordCharacter(next) && next !== '.' && next !== '-') mentions.push({mention: token, token, start: index, end});
    index = Math.max(index, end - 1);
  }
  return mentions;
}

export interface PathMention {
  /** Full match as it appears in the prompt (`@path` for explicit mentions, the path itself for bare). */
  mention: string;
  /** The path token after the `@`, or the bare path itself. */
  token: string;
}

type ScannedPathMention = PathMention & {start: number; end: number};

/**
 * Extract path-like attachment candidates from prompt text. Two forms are
 * recognised:
 *
 * - Explicit `@token` mentions: any path-like token after `@`. A candidate
 *   must contain a `.` or `/` so bare handles (`@here`) are skipped.
 * - Bare paths: a token that ends in an allowlisted image extension AND
 *   contains `/`. The separator keeps prose like "I named it cat.png" out;
 *   the existence check during resolution is the final gate.
 *
 * Whether a candidate is really an attachment is decided during resolution.
 */
export function extractPathMentions(text: string): PathMention[] {
  const mentions: PathMention[] = [];
  const seen = new Set<string>();

  for (const candidate of [...explicitPathMentions(text), ...barePathMentions(text)]) {
    if (seen.has(candidate.mention)) continue;
    seen.add(candidate.mention);
    mentions.push({mention: candidate.mention, token: candidate.token});
  }

  return mentions;
}

/**
 * Resolve an `@token` mention to a host path. Relative tokens resolve against
 * the workspace root but may escape it (`../shot.png`); `~/` expands to the
 * home directory; absolute tokens stay absolute. Attachments are explicit
 * user-typed references, so host paths outside the workspace are allowed.
 */
function resolveAttachmentPath(token: string): string {
  if (token === '~' || token.startsWith('~/')) return path.join(os.homedir(), token.slice(1));
  return path.resolve(workspaceRoot(), token);
}

/** Workspace-relative for files inside the project, `~/…` under the home directory, absolute otherwise. */
function displayPathFor(realPath: string): string {
  const relativeTo = (root: string): string | undefined => {
    const relative = path.relative(root, realPath);
    return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : relative || '.';
  };
  const inWorkspace = relativeTo(workspaceRoot());
  if (inWorkspace !== undefined) return inWorkspace;
  const inHome = relativeTo(os.homedir());
  return inHome !== undefined ? path.join('~', inHome) : realPath;
}

function notAnImageError(token: string) {
  return new Error(`Not an image: @${token}. Only ${IMAGE_EXTENSIONS.join(', ')} files can be attached.`);
}

async function statFile(absolutePath: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fs.stat(absolutePath);
  } catch {
    return undefined;
  }
}

/**
 * Resolve `@path` mentions into image attachments.
 *
 * - Mentions that do not resolve to an existing file stay literal
 *   prompt text (emails, handles, typos) — no error.
 * - Existing paths with a non-image extension stay literal text too; the
 *   read-blessing resolver picks them up so the model can `readFile` them.
 * - Existing image-extension paths that are not regular files (e.g. a
 *   directory named `foo.png`) fail loudly — that is a genuine attach-intent
 *   mismatch, not silent drop.
 * - An `@` mention is an explicit user-typed reference, so any host path
 *   works: workspace-relative (including `../`), absolute, or `~/`. The real
 *   path dedupes aliases (symlinks, `..` segments) instead of confining
 *   reads; `.gitignore` is not enforced here (documented in AGENTS.md).
 * - Size and per-message count are bounded by named limits; errors name them.
 * - The same file mentioned twice is attached once; both mentions are stripped.
 */
export async function resolveImageAttachments(text: string): Promise<ResolvedImageAttachments> {
  const mentions = extractPathMentions(text);
  if (mentions.length === 0) return {text, attachments: []};

  const attachments: ImageAttachment[] = [];
  const seenRealPaths = new Set<string>();
  const strippedTokens = new Set<string>();

  for (const {token} of mentions) {
    // Backslash escapes (`\ `, `\(`, …) are removed for filesystem resolution
    // but kept in `token` so the mention can be stripped from the prompt
    // exactly as the user typed it. macOS screenshot paths and other host
    // paths commonly contain spaces; without unescape the file would never
    // resolve and the mention would silently become plain text.
    const resolveToken = token.replace(/\\(.)/g, '$1');
    // A sentence-ending period ("@shot.png.") is not part of the filename, so
    // fall back to the trailing-dot-stripped form when the verbatim path does
    // not exist; the image is then attached instead of being silently left as
    // text.
    let fileToken = resolveToken;
    let absolutePath = resolveAttachmentPath(resolveToken);
    let stats = await statFile(absolutePath);
    if (!stats) {
      const trimmed = resolveToken.replace(/\.+$/, '');
      if (trimmed && trimmed !== resolveToken) {
        const trimmedPath = resolveAttachmentPath(trimmed);
        const trimmedStats = await statFile(trimmedPath);
        if (trimmedStats) {
          fileToken = trimmed;
          absolutePath = trimmedPath;
          stats = trimmedStats;
        }
      }
    }
    if (!stats) continue; // Not an existing path: leave the mention as literal text.
    const mediaType = IMAGE_MEDIA_TYPES[path.extname(fileToken).toLowerCase()];
    if (!mediaType) continue; // Non-image extension: leave as text; resolveReadBlessings blesses it.
    if (!stats.isFile()) throw notAnImageError(fileToken); // Image extension but directory: genuine mismatch.

    const realPath = await fs.realpath(absolutePath);
    if (seenRealPaths.has(realPath)) {
      strippedTokens.add(token); // Same file already attached; still strip the repeat.
      continue;
    }

    if (stats.size > IMAGE_ATTACHMENT_BYTES) {
      throw new Error(`Image too large: @${fileToken} is ${formatBytes(stats.size)}; the attachment limit is ${formatBytes(IMAGE_ATTACHMENT_BYTES)} per image.`);
    }
    if (attachments.length >= IMAGE_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(`Too many image attachments: at most ${IMAGE_ATTACHMENTS_PER_MESSAGE} per message.`);
    }

    const data = new Uint8Array(await fs.readFile(realPath));
    seenRealPaths.add(realPath);
    strippedTokens.add(token);
    attachments.push({
      displayPath: displayPathFor(realPath),
      absolutePath: realPath,
      fileName: path.basename(realPath),
      mediaType,
      bytes: data.byteLength,
      data,
    });
  }

  if (strippedTokens.size === 0) return {text, attachments};
  // Strip attached mentions (explicit `@` and bare) by their scanner ranges,
  // then tidy the double space a mid-line removal can leave behind. Sorting is
  // needed because extraction preserves explicit-before-bare compatibility.
  const ranges = [...explicitPathMentions(text), ...barePathMentions(text)]
    .filter(candidate => strippedTokens.has(candidate.token))
    .sort((left, right) => left.start - right.start);
  const chunks: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    chunks.push(text.slice(cursor, range.start));
    cursor = range.end;
  }
  chunks.push(text.slice(cursor));
  const cleaned = chunks.join('').replace(/(?<=[^\n])[ \t]{2,}/g, ' ').trim();
  return {text: cleaned, attachments};
}

/** Build the turn's user message: plain string without attachments, multipart with. */
export function userTurnMessage(text: string, attachments: readonly ImageAttachment[]): ModelMessage {
  if (attachments.length === 0) return {role: 'user', content: text};
  const parts = [
    ...(text.trim() ? [{type: 'text' as const, text}] : []),
    ...attachments.map(attachment => ({type: 'file' as const, mediaType: attachment.mediaType, data: attachment.data, filename: attachment.fileName})),
  ];
  return {role: 'user', content: parts};
}

/** Minimal prompt text used when a message contains only images. */
export const IMAGE_ONLY_PROMPT_TEXT = 'See the attached image.';

/** Minimal provider shape the capability gate needs (no settings I/O). */
export interface ImageCapableProviderLike {
  name: string;
  capabilities?: {images?: boolean};
}

/**
 * Loud capability gate (constitution VII): images only go to providers the
 * user explicitly marked image-capable. Returns undefined when the provider
 * may receive image parts, otherwise an actionable error message.
 */
export function imageCapabilityError(provider: ImageCapableProviderLike | undefined): string | undefined {
  if (provider?.capabilities?.images === true) return undefined;
  if (!provider) return 'No provider is configured. Run /provider to add one, then attach the image again.';
  return `Provider '${provider.name}' is not marked image-capable. Enable image input for it via /provider, or switch models.`;
}

/** Guard for AI SDK `file` parts carrying images, in any message role. */
export function isImageFilePart(value: unknown): value is {type: 'file'; mediaType: string; data?: unknown; filename?: unknown} {
  if (typeof value !== 'object' || value == null) return false;
  const part = value as {type?: unknown; mediaType?: unknown};
  return part.type === 'file' && typeof part.mediaType === 'string' && part.mediaType.startsWith('image/');
}

/** Byte size of a file part's data without serializing it. */
export function imageFilePartBytes(data: unknown): number {
  let candidate = data;
  if (typeof candidate === 'object' && candidate != null && (candidate as {type?: unknown}).type === 'data') {
    candidate = (candidate as {data?: unknown}).data;
  }
  if (candidate instanceof Uint8Array || candidate instanceof ArrayBuffer) return candidate.byteLength;
  if (typeof candidate === 'string') return Math.floor(candidate.length * 3 / 4); // base64 payload
  return 0;
}
