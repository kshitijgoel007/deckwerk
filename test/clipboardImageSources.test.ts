import { describe, expect, it } from 'vitest';
import {
  bestClipboardImageMime,
  clipboardImageName,
  clipboardImageSource,
  imageMimeExtension,
  isSupportedImageMime,
  urlLooksLikeImage,
} from '../src/shared/clipboardImages.js';

/**
 * Recognising a foreign clipboard's image, across the shapes real apps write.
 *
 * The bug these cover: "copy image, paste into a slide" silently did nothing
 * for every clipboard that wasn't literally `image/png` bytes — which is most
 * of them. Chat and web apps overwhelmingly write a bare `<img src>` and no
 * pixels at all.
 */

describe('clipboard image MIME types', () => {
  it('accepts every image encoding a browser Copy Image can produce', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']) {
      expect(isSupportedImageMime(mime), mime).toBe(true);
      expect(clipboardImageName(mime), mime).toMatch(/^Screenshot\.[a-z]+$/);
    }
  });

  it('names each type with an extension the deck importer accepts', () => {
    expect(imageMimeExtension('image/jpeg')).toBe('.jpg');
    expect(imageMimeExtension('image/svg+xml')).toBe('.svg');
    // Parameters and case ride along on real clipboard types.
    expect(imageMimeExtension('IMAGE/PNG; charset=binary')).toBe('.png');
  });

  it('rejects types the importer cannot store, rather than guessing', () => {
    for (const mime of ['image/tiff', 'image/bmp', 'text/html', 'application/pdf', '']) {
      expect(isSupportedImageMime(mime), mime).toBe(false);
      expect(clipboardImageName(mime), mime).toBeNull();
    }
  });

  it('prefers the most faithful encoding a clipboard item offers', () => {
    expect(bestClipboardImageMime(['text/html', 'image/jpeg', 'image/png'])).toBe('image/png');
    expect(bestClipboardImageMime(['text/html', 'image/webp'])).toBe('image/webp');
    expect(bestClipboardImageMime(['text/html', 'text/plain'])).toBeNull();
  });
});

describe('image-only clipboards that carry no pixels', () => {
  it('finds the image behind a chat app "Copy Image"', () => {
    // The exact shape Slack writes: wrapper boilerplate around one <img>.
    const html = "<meta charset='utf-8'><html><head></head><body>"
      + '<img src="https://files.slack.com/files-tmb/T1-F2-abc/image_720.png" alt="">'
      + '</body></html>';
    expect(clipboardImageSource(html, 'https://files.slack.com/files-tmb/T1-F2-abc/image_720.png'))
      .toEqual({ kind: 'url', url: 'https://files.slack.com/files-tmb/T1-F2-abc/image_720.png' });
  });

  it('unescapes entities in the src, which query strings are full of', () => {
    const html = '<img src="https://cdn.example.com/i.png?w=800&amp;h=600&amp;sig=x">';
    expect(clipboardImageSource(html)).toEqual({
      kind: 'url',
      url: 'https://cdn.example.com/i.png?w=800&h=600&sig=x',
    });
  });

  it('reads an inline data: image without touching the network', () => {
    const html = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
    expect(clipboardImageSource(html)).toEqual({
      kind: 'data',
      mime: 'image/gif',
      base64: 'R0lGODlhAQABAAAAACw=',
    });
  });

  it('takes a bare URL from plain text only when it names an image file', () => {
    expect(clipboardImageSource('', 'https://example.com/photo.jpg'))
      .toEqual({ kind: 'url', url: 'https://example.com/photo.jpg' });
    // Copying an ordinary link must stay a link, not become an image paste.
    expect(clipboardImageSource('', 'https://example.com/article')).toBeNull();
    expect(clipboardImageSource('', 'https://example.com/')).toBeNull();
  });

  it('leaves rich text alone when an image merely appears inside it', () => {
    const html = '<p>Here is the chart <img src="https://example.com/c.png"> — note the spike.</p>';
    expect(clipboardImageSource(html, 'Here is the chart — note the spike.')).toBeNull();
  });

  it('never dereferences a URL scheme that is not fetchable', () => {
    for (const src of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'about:blank',
      'deck://asset/assets/fig.png',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/png,notbase64',
    ]) {
      expect(clipboardImageSource(`<img src="${src}">`), src).toBeNull();
      expect(clipboardImageSource('', src), src).toBeNull();
    }
  });

  it('ignores a clipboard with neither markup nor a URL', () => {
    expect(clipboardImageSource('', '')).toBeNull();
    expect(clipboardImageSource('<p>just words</p>', 'just words')).toBeNull();
    expect(clipboardImageSource('<img alt="no src here">')).toBeNull();
  });

  it('classifies URL paths by extension for bare-URL pastes', () => {
    expect(urlLooksLikeImage('https://x.test/a/b/c.WEBP')).toBe(true);
    expect(urlLooksLikeImage('https://x.test/a.png?download=1')).toBe(true);
    expect(urlLooksLikeImage('https://x.test/a.mp4')).toBe(false);
    expect(urlLooksLikeImage('not a url')).toBe(false);
  });
});
