/**
 * Recognising images on a foreign clipboard.
 *
 * Other applications describe a copied image in whatever way suits them, and
 * the shape varies even within one app. Three families matter here:
 *
 *  - **Bitmap bytes** under an image MIME type. The type is *not* always PNG:
 *    a browser's "Copy Image" preserves the source encoding, so JPEG, GIF,
 *    WebP and AVIF all turn up. Accepting only `image/png` silently drops
 *    every other one.
 *  - **A remote reference and nothing else.** Slack, and most chat and web
 *    apps, frequently write only `text/html` holding an `<img src="https://…">`
 *    plus the URL as plain text. There are no pixels on the pasteboard at all;
 *    the bytes have to be fetched.
 *  - **Markup that merely contains an image**, alongside real content. A
 *    pasted rich-text run is not an image paste and must not become one.
 *
 * Keep this module DOM-free: the Electron main process (no `document`) and
 * both renderers all share it.
 */

import { IMAGE_EXTS } from './media.js';

/** Image MIME types the deck importer can store, mapped to their extension.
 *  Every value here must stay inside `IMAGE_EXTS`, which is asserted below. */
const IMAGE_MIME_EXTENSIONS = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
  ['image/svg+xml', '.svg'],
  // Screenshots and older Office copies arrive as TIFF/BMP on macOS. The
  // importer has no TIFF decoder, so these are deliberately absent: the
  // Electron reader re-encodes them to PNG through NativeImage instead.
]);

/* A mapping that named an extension the importer rejects would fail at paste
 * time, in the main process, after the bytes were already written. Assert the
 * invariant at module load instead. */
for (const ext of IMAGE_MIME_EXTENSIONS.values()) {
  if (!IMAGE_EXTS.has(ext)) throw new Error(`Unimportable clipboard image extension: ${ext}`);
}

/** The extension to store a clipboard image under, or null if unsupported. */
export function imageMimeExtension(mime: string): string | null {
  return IMAGE_MIME_EXTENSIONS.get(mime.trim().toLowerCase().split(';')[0]) ?? null;
}

/** Every clipboard image MIME type, best first. Callers scan in this order so
 *  a clipboard offering several encodings yields the most faithful one. */
export const CLIPBOARD_IMAGE_MIMES: string[] = [...IMAGE_MIME_EXTENSIONS.keys()];

/** True when this MIME type names a clipboard image the importer can store. */
export function isSupportedImageMime(mime: string): boolean {
  return imageMimeExtension(mime) !== null;
}

/** The name to import clipboard bytes under, matching the type's extension.
 *  Content-addressing in the importer means the stem need not be unique. */
export function clipboardImageName(mime: string): string | null {
  const ext = imageMimeExtension(mime);
  return ext ? `Screenshot${ext}` : null;
}

/** Pick the best supported image type out of what a clipboard item offers. */
export function bestClipboardImageMime(available: readonly string[]): string | null {
  const offered = new Set(available.map((type) => type.trim().toLowerCase()));
  return CLIPBOARD_IMAGE_MIMES.find((mime) => offered.has(mime)) ?? null;
}

/** Where an image-only clipboard keeps its pixels when the pasteboard itself
 *  carries none: behind a URL to fetch, or inline in a `data:` URL. */
export type ClipboardImageSource =
  | { kind: 'url'; url: string }
  | { kind: 'data'; mime: string; base64: string };

const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i;

/** The `src` of an `<img>` tag, unescaped. */
function imgTagSrc(tag: string): string | null {
  const match = SRC_ATTR.exec(tag);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw ? decodeEntities(raw.trim()) : null;
}

/** Only the entities that appear inside clipboard URLs and boilerplate. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/**
 * True when this markup is *nothing but* one or more images — the shape a
 * chat or web app writes for "Copy Image". Markup with real text alongside
 * the image is a rich-text paste and must keep going down the text path.
 */
function isImageOnlyMarkup(html: string): boolean {
  if (!IMG_TAG.test(html)) {
    IMG_TAG.lastIndex = 0;
    return false;
  }
  IMG_TAG.lastIndex = 0;
  const withoutImages = html.replace(IMG_TAG, '');
  // Drop the wrapper elements every app volunteers, then every remaining tag,
  // and see whether any words were actually copied alongside the picture.
  const text = decodeEntities(withoutImages.replace(/<[^>]*>/g, ''));
  return text.replace(/[\s ]+/g, '') === '';
}

/** A `data:` image URL split into the parts the importer needs. */
function parseDataImageUrl(url: string): ClipboardImageSource | null {
  const match = /^data:([^;,]+)(;[^,]*)?,(.*)$/is.exec(url);
  if (!match) return null;
  const mime = match[1].trim().toLowerCase();
  if (!isSupportedImageMime(mime)) return null;
  // Only base64 payloads; percent-encoded `data:` images are vanishingly rare
  // on a clipboard and not worth a second decoder.
  if (!/;base64/i.test(match[2] ?? '')) return null;
  return { kind: 'data', mime, base64: match[3].replace(/\s+/g, '') };
}

/** Accept only what is safe to hand to `fetch`. `javascript:` and `file:` URLs
 *  must never be dereferenced on a paste, and a deck asset is not remote. */
function fetchableImageUrl(raw: string): ClipboardImageSource | null {
  if (/^data:/i.test(raw)) return parseDataImageUrl(raw);
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    return { kind: 'url', url: url.href };
  } catch {
    return null;
  }
}

/** True when a URL's path names a file the image importer would accept. Used
 *  for bare-URL pastes, where there is no MIME type to consult. */
export function urlLooksLikeImage(raw: string): boolean {
  try {
    const { pathname } = new URL(raw);
    const match = /\.[^./]+$/.exec(pathname);
    return match ? IMAGE_EXTS.has(match[0].toLowerCase()) : false;
  } catch {
    return false;
  }
}

/**
 * The image an otherwise-empty clipboard is pointing at, or null when this
 * clipboard is not an image-only paste.
 *
 * `html` wins over `text` because the markup carries the real source, while
 * the plain-text fallback is often a display URL or a caption. A bare URL in
 * `text` counts only when it plainly names an image file, so that copying an
 * ordinary link does not turn into an image paste.
 */
export function clipboardImageSource(html: string, text = ''): ClipboardImageSource | null {
  if (html && isImageOnlyMarkup(html)) {
    for (const tag of html.match(IMG_TAG) ?? []) {
      const src = imgTagSrc(tag);
      const source = src ? fetchableImageUrl(src) : null;
      if (source) return source;
    }
  }
  const bare = text.trim();
  if (bare && !/\s/.test(bare)) {
    const source = fetchableImageUrl(bare);
    if (source && (source.kind === 'data' || urlLooksLikeImage(source.url))) return source;
  }
  return null;
}

/**
 * The image a drag out of a web page is carrying, or null when the drag is
 * not one.
 *
 * A cross-application drag from a browser puts no file on the pasteboard: it
 * offers the same `<img>` markup an image copy would, plus the image's URL in
 * `text/uri-list`. `uriList` may hold several lines and `#` comments, so only
 * its first real entry counts, and it stands in for the plain-text fallback
 * because dragging an image out of a page often writes the page's own URL as
 * `text/plain`.
 */
export function dragImageSource(html: string, uriList = '', text = ''): ClipboardImageSource | null {
  const uri = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'));
  return clipboardImageSource(html, uri ?? text);
}
