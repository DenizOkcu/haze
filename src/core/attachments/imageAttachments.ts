import fs from 'node:fs/promises';
import path from 'node:path';
import type {ModelMessage} from 'ai';
import {IMAGE_ATTACHMENT_BYTES, IMAGE_ATTACHMENTS_PER_MESSAGE} from '../limits/byteBudgets.js';
import {assertRealPathInsideRoot, resolveWorkspacePath, workspaceRelativePath, workspaceRoot} from '../../utils/path.js';
import {formatBytes} from '../../utils/format.js';

/**
 * User-attached images for one prompt (F03).
 *
 * Attachments are resolved from `@path` mentions typed by the user in the
 * interactive chat: workspace-confined, real-path checked, extension-allowlisted,
 * byte-bounded. The module is UI- and provider-agnostic (constitution VI):
 * the capability gate takes the provider shape explicitly, never settings I/O.
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
  /** Workspace-relative path for display, e.g. `docs/shot.png`. */
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

/**
 * `@token` candidates. The lookbehind keeps emails/handles intact
 * (`user@example.com` never matches at `@example.com`).
 */
const MENTION_PATTERN = /(?<![\w@])@([\w./~-]+)/g;

export interface PathMention {
  /** Full mention including the `@`. */
  mention: string;
  /** The path token after the `@`. */
  token: string;
}

/**
 * Extract path-like `@token` mentions from prompt text. A candidate must
 * contain a `.` or `/` so bare handles (`@here`) are skipped. Whether a
 * candidate is really an attachment is decided during resolution.
 */
export function extractPathMentions(text: string): PathMention[] {
  const mentions: PathMention[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const token = match[1];
    if (!token || (!token.includes('.') && !token.includes('/'))) continue;
    mentions.push({mention: match[0], token});
  }
  return mentions;
}

function outsideWorkspaceError(token: string) {
  return new Error(`Image attachment @${token} is outside the workspace. Attach paths inside the project.`);
}

function notAnImageError(token: string) {
  return new Error(`Not an image: @${token}. Only ${IMAGE_EXTENSIONS.join(', ')} files can be attached.`);
}

/**
 * Resolve `@path` mentions into image attachments.
 *
 * - Mentions that do not resolve to an existing workspace file stay literal
 *   prompt text (emails, handles, typos) — no error.
 * - Existing paths that are not allowlisted images fail loudly (never a
 *   silent drop).
 * - Confinement reuses the shared workspace/real-path helpers, so symlink
 *   escapes are rejected. An `@` mention is an explicit user-typed reference,
 *   so `.gitignore` is not enforced here (documented in AGENTS.md).
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
    let absolutePath: string;
    try {
      absolutePath = resolveWorkspacePath(token);
    } catch {
      throw outsideWorkspaceError(token);
    }

    let stats;
    try {
      stats = await fs.stat(absolutePath);
    } catch {
      continue; // Not an existing path: leave the mention as literal text.
    }
    if (!stats.isFile()) throw notAnImageError(token);

    const realPath = await assertRealPathInsideRoot(workspaceRoot(), absolutePath, token, 'workspace');
    if (seenRealPaths.has(realPath)) {
      strippedTokens.add(token); // Same file already attached; still strip the repeat.
      continue;
    }

    const mediaType = IMAGE_MEDIA_TYPES[path.extname(token).toLowerCase()];
    if (!mediaType) throw notAnImageError(token);
    if (stats.size > IMAGE_ATTACHMENT_BYTES) {
      throw new Error(`Image too large: @${token} is ${formatBytes(stats.size)}; the attachment limit is ${formatBytes(IMAGE_ATTACHMENT_BYTES)} per image.`);
    }
    if (attachments.length >= IMAGE_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(`Too many image attachments: at most ${IMAGE_ATTACHMENTS_PER_MESSAGE} per message.`);
    }

    const data = new Uint8Array(await fs.readFile(realPath));
    seenRealPaths.add(realPath);
    strippedTokens.add(token);
    attachments.push({
      displayPath: workspaceRelativePath(realPath),
      absolutePath: realPath,
      fileName: path.basename(realPath),
      mediaType,
      bytes: data.byteLength,
      data,
    });
  }

  if (strippedTokens.size === 0) return {text, attachments};
  const cleaned = text
    .replace(MENTION_PATTERN, (mention, token) => strippedTokens.has(token) ? '' : mention)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
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
