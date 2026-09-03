import type { Size } from '../../shared/mediaMask.js';

/**
 * The intrinsic pixel size of a media element as currently rendered on the
 * canvas, or null when it is not known yet (still loading, a PDF, an SVG with
 * no intrinsic size, a video whose metadata has not arrived).
 *
 * The deck never stores intrinsic sizes, so mask geometry that has to respect
 * the picture's aspect ratio reads it off the live DOM node instead.
 */
export function mediaNaturalSize(elementId: string): Size | null {
  // `CSS.escape` is absent in some non-browser hosts; ids only ever need the
  // quote and backslash escaped for an attribute selector.
  const escaped = globalThis.CSS?.escape?.(elementId)
    ?? elementId.replace(/["\\]/g, '\\$&');
  const node = document.querySelector<HTMLElement>(`[data-element-id="${escaped}"]`);
  const media = node?.querySelector<HTMLImageElement | HTMLVideoElement>('img, video');
  if (!media) return null;
  const w = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const h = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
  return w > 0 && h > 0 ? { w, h } : null;
}
