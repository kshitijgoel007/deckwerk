/**
 * Media classification and the pending-upload sentinel, shared between the
 * main-process importer, the collab server and both renderers.
 *
 * A freshly dropped file appears on the slide immediately as a normal
 * image/video element whose `src` is `pending:<token>` — a real element, so
 * moving, resizing and collab sync all work while the bytes are still
 * uploading or transcoding. When the import finishes, the src is swapped for
 * the deck-relative asset path.
 */

export const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.pdf',
]);
export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

/** Classify by file name/path extension; null means "not droppable media". */
export function classifyMediaName(name: string): 'image' | 'video' | null {
  const m = /\.[^./\\]+$/.exec(name);
  const ext = m ? m[0].toLowerCase() : '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

const PENDING_PREFIX = 'pending:';

/** The file name rides in the src so collab peers can label the placeholder. */
export function makePendingSrc(token: string, name: string): string {
  return `${PENDING_PREFIX}${token}:${encodeURIComponent(name)}`;
}

export function isPendingSrc(src: string): boolean {
  return src.startsWith(PENDING_PREFIX);
}

/** The token of a pending src, or null for a real asset path. */
export function pendingToken(src: string): string | null {
  if (!isPendingSrc(src)) return null;
  return src.slice(PENDING_PREFIX.length).split(':')[0];
}

/** The original file name of a pending src, for the placeholder label. */
export function pendingName(src: string): string {
  if (!isPendingSrc(src)) return '';
  const rest = src.slice(PENDING_PREFIX.length);
  const sep = rest.indexOf(':');
  return sep === -1 ? '' : decodeURIComponent(rest.slice(sep + 1));
}
