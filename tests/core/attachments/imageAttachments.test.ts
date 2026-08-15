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

    it('keeps backslash escapes inside the captured token', () => {
      // macOS screenshots default to `Bildschirmfoto YYYY-MM-DD um HH.MM.SS.png`;
      // users shell-escape the spaces. The escape must stay in the token so the
      // mention can be stripped verbatim after resolution.
      expect(extractPathMentions('see @screen\\ 2026.png here').map(m => m.token)).toEqual(['screen\\ 2026.png']);
    });

    it('extracts bare paths ending in an image extension and containing a separator', () => {
      expect(extractPathMentions('see /abs/path/foo.jpg and ~/pics/cat.png').map(m => m.token))
        .toEqual(['/abs/path/foo.jpg', '~/pics/cat.png']);
    });

    it('does not extract bare filenames without a separator (prose safety)', () => {
      // "I named it cat.png" should not become an attachment just because the
      // workspace happens to contain a `cat.png`. The separator requirement is
      // the prose-safety gate.
      expect(extractPathMentions('I named it cat.png and dog.jpeg')).toEqual([]);
    });

    it('does not extract the host part of an email even with an image-like TLD', () => {
      expect(extractPathMentions('mail user@fake.png today')).toEqual([]);
    });

    it('handles adversarial path-like input in linear time', () => {
      const input = '-'.repeat(100_000);
      expect(extractPathMentions(input)).toEqual([]);
    });
  });

  describe('resolveImageAttachments', () => {
    it('returns text unchanged when there are no mentions', async () => {
      await expect(resolveImageAttachments('plain prompt')).resolves.toEqual({text: 'plain prompt', attachments: []});
    });

    it('keeps mentions that are not existing files as literal text', async () => {
      const result = await resolveImageAttachments('contact user@missing.example.com about @nope.png and @../also-missing.png');
      expect(result.attachments).toEqual([]);
      expect(result.text).toContain('@missing.example.com');
      expect(result.text).toContain('@nope.png');
      expect(result.text).toContain('@../also-missing.png');
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

    it('tidies the gap left by a mid-line mention but keeps line-leading indentation', async () => {
      await fs.writeFile(path.join(workspace, 'shot.png'), PNG_BYTES);
      const result = await resolveImageAttachments('fix @shot.png the button\n  indented: true');
      expect(result.text).toBe('fix the button\n  indented: true');
    });

    it('drops a sentence-ending period so the image is attached, not silently left as text', async () => {
      await fs.writeFile(path.join(workspace, 'shot.png'), PNG_BYTES);
      const result = await resolveImageAttachments('here is the bug: @shot.png. Please fix');
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.fileName).toBe('shot.png');
      expect(result.text).toBe('here is the bug: Please fix');
    });

    it('unescapes backslash-escaped spaces in the resolved path (macOS screenshots)', async () => {
      // Default macOS screenshot filenames contain spaces; users shell-escape them.
      const fileName = 'Bildschirmfoto 2026-08-03 um 10.14.15.png';
      await fs.writeFile(path.join(workspace, fileName), PNG_BYTES);
      const result = await resolveImageAttachments(`describe @Bildschirmfoto\\ 2026-08-03\\ um\\ 10.14.15.png please`);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.fileName).toBe(fileName);
      expect(result.attachments[0]?.mediaType).toBe('image/png');
      expect(result.text).toBe('describe please');
    });

    it('leaves an unresolved escaped mention as literal text', async () => {
      // The escaped form does not point at a real file, so it must not be
      // stripped or attached — same contract as any other unresolved mention.
      const result = await resolveImageAttachments('see @does\\ not\\ exist.png now');
      expect(result.attachments).toEqual([]);
      expect(result.text).toBe('see @does\\ not\\ exist.png now');
    });

    it('attaches a bare absolute path without `@` and strips it from the text', async () => {
      // The motivating case: a user pastes a host path like
      // `/Users/.../unnamed.jpg` without thinking about the `@` sigil.
      const abs = path.join(os.tmpdir(), 'haze-bare-absolute.png');
      await fs.writeFile(abs, PNG_BYTES);
      try {
        const result = await resolveImageAttachments(`whats on this one: ${abs} please`);
        expect(result.attachments).toHaveLength(1);
        expect(result.attachments[0]?.fileName).toBe(path.basename(abs));
        expect(result.attachments[0]?.absolutePath).toBe(await fs.realpath(abs));
        expect(result.text).toBe('whats on this one: please');
      } finally {
        await fs.remove(abs);
      }
    });

    it('attaches a bare relative path that contains a separator', async () => {
      await fs.ensureDir(path.join(workspace, 'assets'));
      await fs.writeFile(path.join(workspace, 'assets', 'logo.png'), PNG_BYTES);
      const result = await resolveImageAttachments('check assets/logo.png please');
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.displayPath).toBe(path.join('assets', 'logo.png'));
      expect(result.text).toBe('check please');
    });

    it('does not attach a bare filename without a separator even if it exists', async () => {
      // `cat.png` exists in the workspace, but without a `/` it must stay
      // prose — otherwise incidental mentions hijack the prompt.
      await fs.writeFile(path.join(workspace, 'cat.png'), PNG_BYTES);
      const result = await resolveImageAttachments('I named it cat.png today');
      expect(result.attachments).toEqual([]);
      expect(result.text).toBe('I named it cat.png today');
    });

    it('dedupes a bare path and an explicit `@` mention of the same file', async () => {
      await fs.ensureDir(path.join(workspace, 'pics'));
      await fs.writeFile(path.join(workspace, 'pics', 'dup.png'), PNG_BYTES);
      const result = await resolveImageAttachments(`see pics/dup.png and @pics/dup.png too`);
      expect(result.attachments).toHaveLength(1);
      expect(result.text).toBe('see and too');
    });

    it('leaves existing non-image files as literal text (read-blessing picks them up)', async () => {
      // Non-image existing paths no longer throw: they stay as text so the
      // read-blessing resolver can mark them readable by the model.
      await fs.writeFile(path.join(workspace, 'notes.txt'), 'text');
      const result = await resolveImageAttachments('see @notes.txt');
      expect(result.attachments).toEqual([]);
      expect(result.text).toBe('see @notes.txt');
    });

    it('rejects directories with an image extension as a genuine attach-intent mismatch', async () => {
      // A directory named `imgs.png` is image-extension but not a file: the
      // user clearly intended to attach it. Loud error stays.
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

    it('attaches images outside the workspace via ../ relative mentions', async () => {
      const parentFile = path.join(workspace, '..', 'escape.png');
      await fs.writeFile(parentFile, PNG_BYTES);
      try {
        const result = await resolveImageAttachments('see @../escape.png');
        expect(result.attachments).toHaveLength(1);
        expect(result.attachments[0]).toMatchObject({fileName: 'escape.png', mediaType: 'image/png'});
        expect(result.attachments[0]?.displayPath).toBe(await fs.realpath(parentFile));
        expect(result.text).toBe('see');
      } finally {
        await fs.remove(parentFile);
      }
    });

    it('attaches absolute and ~ home mentions of the same file once', async () => {
      const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haze-images-home-')));
      const savedHome = process.env.HOME;
      process.env.HOME = home;
      try {
        await fs.ensureDir(path.join(home, 'pics'));
        await fs.writeFile(path.join(home, 'pics', 'shot.png'), PNG_BYTES);
        const result = await resolveImageAttachments(`look @${path.join(home, 'pics', 'shot.png')} and @~/pics/shot.png`);
        expect(result.attachments).toHaveLength(1);
        expect(result.attachments[0]?.displayPath).toBe(path.join('~', 'pics', 'shot.png'));
        expect(result.text).toBe('look and');
      } finally {
        process.env.HOME = savedHome;
        await fs.remove(home);
      }
    });

    it('follows workspace symlinks to outside targets and dedupes the alias', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-images-outside-'));
      try {
        const target = path.join(outside, 'secret.png');
        await fs.writeFile(target, PNG_BYTES);
        await fs.symlink(target, path.join(workspace, 'link.png'));
        const result = await resolveImageAttachments(`see @link.png and @${target}`);
        expect(result.attachments).toHaveLength(1);
        expect(result.attachments[0]?.fileName).toBe('secret.png');
        expect(result.attachments[0]?.displayPath).toBe(await fs.realpath(target));
        expect(result.text).toBe('see and');
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
