import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
  extractPathMentions,
  imageCapabilityError,
  IMAGE_EXTENSIONS,
  resolveImageAttachments,
  userTurnMessage,
  type ImageAttachment,
} from '../../../src/core/attachments/imageAttachments.js';
import {IMAGE_ATTACHMENT_BYTES, IMAGE_ATTACHMENTS_PER_MESSAGE} from '../../../src/core/limits/byteBudgets.js';

// 1x1 transparent PNG: valid header bytes are enough for extension-based
// media typing; content is never decoded by haze.
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('image attachments (F03)', () => {
  let workspace: string;
  let originalCwd: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-images-test-'));
    originalCwd = process.cwd();
    process.chdir(workspace);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(workspace);
  });

  function attachment(displayPath: string, bytes = 10): ImageAttachment {
    return {displayPath, absolutePath: path.join(workspace, displayPath), fileName: path.basename(displayPath), mediaType: 'image/png', bytes, data: new Uint8Array(bytes)};
  }

  describe('extractPathMentions', () => {
    it('finds path-like mentions and skips bare handles', () => {
      expect(extractPathMentions('fix @docs/shot.png and @a.jpeg please').map(m => m.token)).toEqual(['docs/shot.png', 'a.jpeg']);
      expect(extractPathMentions('ping @here about @channel')).toEqual([]);
    });

    it('does not match the host part of email addresses', () => {
      // The lookbehind keeps `user@example.com` intact; `example.com` only
      // matches when preceded by a non-word boundary.
      expect(extractPathMentions('mail user@example.com today').map(m => m.token)).toEqual([]);
    });
  });

  describe('resolveImageAttachments', () => {
    it('returns text unchanged when there are no mentions', async () => {
      await expect(resolveImageAttachments('plain prompt')).resolves.toEqual({text: 'plain prompt', attachments: []});
    });

    it('keeps mentions that are not existing files as literal text', async () => {
      const result = await resolveImageAttachments('contact user@missing.example.com about @nope.png');
      expect(result.attachments).toEqual([]);
      expect(result.text).toContain('@missing.example.com');
      expect(result.text).toContain('@nope.png');
    });

    it('attaches an existing workspace image and strips the mention (AC1 prep)', async () => {
      await fs.writeFile(path.join(workspace, 'shot.png'), PNG_BYTES);
      const result = await resolveImageAttachments('fix @shot.png layout');
      expect(result.text).toBe('fix layout');
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]).toMatchObject({fileName: 'shot.png', mediaType: 'image/png', bytes: PNG_BYTES.byteLength});
      expect(Buffer.from(result.attachments[0].data).equals(PNG_BYTES)).toBe(true);
    });

    it('attaches a nested image and reports a workspace-relative display path', async () => {
      await fs.ensureDir(path.join(workspace, 'docs'));
      await fs.writeFile(path.join(workspace, 'docs', 'ui.webp'), PNG_BYTES);
      const result = await resolveImageAttachments('@docs/ui.webp');
      expect(result.attachments[0]?.displayPath).toBe(path.join('docs', 'ui.webp'));
      expect(result.attachments[0]?.mediaType).toBe('image/webp');
    });

    it('attaches the same file once when mentioned twice and strips both mentions', async () => {
      await fs.writeFile(path.join(workspace, 'shot.png'), PNG_BYTES);
      const result = await resolveImageAttachments('@shot.png and again @shot.png');
      expect(result.attachments).toHaveLength(1);
      expect(result.text).toBe('and again');
    });

    it('rejects existing non-image files with a clear error (AC5)', async () => {
      await fs.writeFile(path.join(workspace, 'notes.txt'), 'text');
      await expect(resolveImageAttachments('see @notes.txt')).rejects.toThrow(`Not an image: @notes.txt. Only ${IMAGE_EXTENSIONS.join(', ')} files can be attached.`);
    });

    it('rejects directories', async () => {
      await fs.ensureDir(path.join(workspace, 'imgs.png'));
      await expect(resolveImageAttachments('see @imgs.png')).rejects.toThrow('Not an image: @imgs.png');
    });

    it('rejects oversized images naming the limit (AC3)', async () => {
      const big = path.join(workspace, 'big.png');
      await fs.writeFile(big, Buffer.alloc(0));
      await fs.truncate(big, IMAGE_ATTACHMENT_BYTES + 1);
      await expect(resolveImageAttachments('see @big.png')).rejects.toThrow(/Image too large.*attachment limit/);
    });

    it('rejects more than the per-message attachment limit', async () => {
      for (let index = 0; index <= IMAGE_ATTACHMENTS_PER_MESSAGE; index++) {
        await fs.writeFile(path.join(workspace, `img${index}.png`), PNG_BYTES);
      }
      const prompt = Array.from({length: IMAGE_ATTACHMENTS_PER_MESSAGE + 1}, (_, index) => `@img${index}.png`).join(' ');
      await expect(resolveImageAttachments(prompt)).rejects.toThrow(`Too many image attachments: at most ${IMAGE_ATTACHMENTS_PER_MESSAGE} per message.`);
    });

    it('rejects paths outside the workspace', async () => {
      await expect(resolveImageAttachments('see @../escape.png')).rejects.toThrow('outside the workspace');
    });

    it('rejects symlink escapes from the workspace', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-images-outside-'));
      try {
        await fs.writeFile(path.join(outside, 'secret.png'), PNG_BYTES);
        await fs.symlink(path.join(outside, 'secret.png'), path.join(workspace, 'link.png'));
        await expect(resolveImageAttachments('see @link.png')).rejects.toThrow('outside the workspace');
      } finally {
        await fs.remove(outside);
      }
    });
  });

  describe('userTurnMessage', () => {
    it('keeps plain string content when there are no attachments', () => {
      expect(userTurnMessage('hello', [])).toEqual({role: 'user', content: 'hello'});
    });

    it('builds multipart content with text and file parts (AC1 request shape)', () => {
      const message = userTurnMessage('fix this', [attachment('shot.png', PNG_BYTES.byteLength)]);
      expect(message.role).toBe('user');
      const content = message.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({type: 'text', text: 'fix this'});
      expect(content[1]).toMatchObject({type: 'file', mediaType: 'image/png', filename: 'shot.png'});
      expect((content[1]?.data as Uint8Array).byteLength).toBe(PNG_BYTES.byteLength);
    });

    it('omits the text part when the prompt is image-only', () => {
      const message = userTurnMessage('', [attachment('shot.png')]);
      const content = message.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      expect(content[0]).toMatchObject({type: 'file', mediaType: 'image/png'});
    });
  });

  describe('imageCapabilityError', () => {
    it('passes providers explicitly marked image-capable', () => {
      expect(imageCapabilityError({name: 'cloud', capabilities: {images: true}})).toBeUndefined();
    });

    it('fails loudly for providers not marked image-capable (AC2 message)', () => {
      expect(imageCapabilityError({name: 'local'})).toBe("Provider 'local' is not marked image-capable. Enable image input for it via /provider, or switch models.");
      expect(imageCapabilityError({name: 'local', capabilities: {images: false}})).toContain("Provider 'local' is not marked image-capable");
    });

    it('fails loudly when no provider is configured', () => {
      expect(imageCapabilityError(undefined)).toContain('No provider is configured');
    });
  });
});
